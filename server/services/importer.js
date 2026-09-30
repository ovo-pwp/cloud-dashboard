/**
 * Excel 导入核心逻辑（可复用）
 *
 * 把原来 import-excel.js 里的「读文件 → 转换 → 校验 → 落库」抽成独立函数，
 * 供 CLI 脚本（import-excel.js）与文件夹监控（watcher.js）共用。
 * 调用方负责持有/释放连接池，这里不做 pool.end()。
 */

import XLSX from 'xlsx'
import { todayDate, toDateOnly } from '../utils/date.js'

const BIZ_TYPES = {
  billed_unpaid: {
    label: '已开票未回款',
    nameField: '开票方案编号',
    dateField: '开票日期',
  },
  shipped_uninvoiced: {
    label: '已发货未开票',
    nameField: '合同执行编号',
    dateField: '执行日期',
  },
}

/** 按文件名识别业务类型；无法识别返回 null */
export function detectBizType(filename) {
  if (filename.includes('客户未回款')) return 'customer_platform_unpaid'
  if (filename.includes('未回款')) return 'billed_unpaid'
  if (filename.includes('未开票')) return 'shipped_uninvoiced'
  return null
}

export const CUSTOMER_PLATFORM_BIZ_TYPE = 'customer_platform_unpaid'

export { BIZ_TYPES }

// ------------------------------------------------------------
// Excel 序列号 → 日期字符串
// 基准 1899-12-30；含小数（如 46112.6111）需向下取整；序列 0/负数视为无效
// ------------------------------------------------------------
const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

function excelSerialToDate(serial) {
  if (serial === null || serial === undefined || serial === '') return null
  const n = Number(serial)
  if (Number.isNaN(n) || n <= 0) return null
  if (n < 1000) return null // 明显异常（约 1902 年之前），视为脏数据
  const days = Math.floor(n)
  return new Date(EXCEL_EPOCH + days * 86400000).toISOString().slice(0, 10)
}

// ------------------------------------------------------------
// 业务员列拆解：源表混入部门名（如「大客户中心」）
// ------------------------------------------------------------
const KNOWN_DEPARTMENTS = ['大客户中心']
const DEPT_SUFFIX = /(中心|事业部|团队|大客户部)$/

function splitSalesperson(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return { department: null, salesperson: '未指定' }
  if (KNOWN_DEPARTMENTS.includes(value)) {
    return { department: value, salesperson: value }
  }
  if (DEPT_SUFFIX.test(value) && value.length <= 10) {
    return { department: value, salesperson: value }
  }
  return { department: null, salesperson: value }
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(String(v).replace(/,/g, '').trim())
  return Number.isNaN(n) ? 0 : n
}

function toText(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * 导入一份 Excel 快照。
 * @param {object} pool  pg 连接池
 * @param {object} opts
 * @param {string}  opts.bizType      billed_unpaid | shipped_uninvoiced
 * @param {string}  opts.xlsxPath     源文件绝对路径
 * @param {string}  [opts.snapshotDate] 快照日期 YYYY-MM-DD，缺省今天
 * @returns {Promise<{batchId:number, inserted:number, skippedCount:number,
 *          totalAmount:number, warnings:Array}>}
 */
export async function importExcel(pool, { bizType, xlsxPath, snapshotDate }) {
  const meta = BIZ_TYPES[bizType]
  if (!meta) throw new Error(`未知业务类型: ${bizType}`)

  const snapshot = snapshotDate || todayDate()

  // ---------- 读取 ----------
  const wb = XLSX.readFile(xlsxPath, { cellDates: false })
  const sheetName = wb.SheetNames[0]
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    defval: null,
  })
  const dataRows = rows.slice(1).filter((r) => r && r[0] !== null && String(r[0]).trim() !== '')

  // ---------- 转换 + 质量校验 ----------
  const records = []
  const skipped = []
  const warnings = []
  let sumTotal = 0

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const lineNo = i + 2

    const docNo = toText(r[0])
    if (!docNo) {
      skipped.push({ lineNo, docNo: '(空)', reason: '单据编号为空' })
      continue
    }

    const rawSalesperson = toText(r[5])
    const agingCategory = toText(r[2])
    const amountTotal = toNumber(r[6])
    const amountOver3m = toNumber(r[7])
    const amount3m = toNumber(r[8])
    const amount2m = toNumber(r[9])
    const amount1m = toNumber(r[10])
    const amountCurrent = toNumber(r[11])

    const bucketSum =
      Math.round((amountOver3m + amount3m + amount2m + amount1m + amountCurrent) * 100) / 100
    const totalRounded = Math.round(amountTotal * 100) / 100
    const agingMismatch = Math.abs(bucketSum - totalRounded) > 0.01

    let docDate = null
    const rawDate = r[1]
    if (rawDate instanceof Date) {
      docDate = toDateOnly(rawDate)
    } else if (typeof rawDate === 'number') {
      docDate = excelSerialToDate(rawDate)
    } else if (rawDate) {
      // 走 toDateOnly 而不是 new Date(...).toISOString()：
      // 源里若有 '2026/9/21' 这种不补零的斜杠日期，new Date 会按本地零点解析，
      // toISOString 再换算成 UTC 就会少一天
      docDate = toDateOnly(String(rawDate).trim())
    }

    // ---------- 质量问题：登记为告警，但一律保留入库 ----------
    // 明细表口径「与源文件逐行一致」，因此不再因脏数据丢弃整行，
    // 只打 warning 标记，由前端明细页以高亮 + tooltip 呈现。
    const qualityNotes = []

    // 分类为空且账龄分档全为 0 但总额不为 0
    if (!agingCategory && amountTotal !== 0 && bucketSum === 0) {
      qualityNotes.push(`分类为空且账龄分档全为0，但总额为 ${amountTotal}`)
    }

    // 日期缺失或无效（如源表出现 1900/01/00 这种 Excel 假日期）
    if (!docDate) {
      const rawText = rawDate === null || rawDate === undefined ? '(空)' : String(rawDate)
      qualityNotes.push(`日期无效（源值 ${rawText}）`)
    }

    if (agingMismatch) {
      qualityNotes.push(`账龄分档之和 ${bucketSum} ≠ 总额 ${totalRounded}`)
    }

    const dataWarning = qualityNotes.length ? qualityNotes.join('；') : null
    if (dataWarning) {
      warnings.push({ lineNo, docNo, reason: dataWarning })
    }

    const { department, salesperson } = splitSalesperson(rawSalesperson)

    sumTotal += amountTotal

    records.push({
      doc_no: docNo,
      doc_date: docDate,
      aging_category: agingCategory,
      customer_name: toText(r[3]) || '未知客户',
      permission_raw: toText(r[4]),
      salesperson_raw: rawSalesperson || '未指定',
      department,
      salesperson,
      amount_total: amountTotal,
      amount_over3m: amountOver3m,
      amount_3m: amount3m,
      amount_2m: amount2m,
      amount_1m: amount1m,
      amount_current: amountCurrent,
      follow_up_note: toText(r[12]),
      // 第 14 列 = 源表新增的「地址」（城市名）。未开票那张表没有这列，取到就是 null
      city: toText(r[13]) || null,
      data_warning: dataWarning,
    })
  }

  const grandTotal = Math.round(sumTotal * 100) / 100

  // ---------- 入库（事务，同类型同日覆盖）----------
  const client = await pool.connect()
  let batchId
  try {
    await client.query('BEGIN')

    await client.query(
      'DELETE FROM import_batch WHERE biz_type = $1 AND snapshot_date = $2',
      [bizType, snapshot]
    )

    const batchRes = await client.query(
      `INSERT INTO import_batch
         (biz_type, snapshot_date, source_file, row_count, total_amount, skipped_count)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        bizType,
        snapshot,
        String(xlsxPath).split(/[\\/]/).pop(),
        records.length,
        grandTotal,
        skipped.length,
      ]
    )
    batchId = batchRes.rows[0].id

    const cols = [
      'batch_id', 'biz_type', 'doc_no', 'doc_date', 'aging_category',
      'customer_name', 'permission_raw', 'salesperson_raw', 'department',
      'salesperson', 'amount_total', 'amount_over3m', 'amount_3m',
      'amount_2m', 'amount_1m', 'amount_current', 'follow_up_note', 'data_warning',
      'city',
    ]
    const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(',')

    for (const rec of records) {
      const values = [batchId, bizType, ...cols.slice(2).map((c) => rec[c])]
      await client.query(
        `INSERT INTO receivable_detail (${cols.join(',')}) VALUES (${placeholders})`,
        values
      )
    }

    const check = await client.query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_total),0) AS total
         FROM receivable_detail WHERE batch_id = $1`,
      [batchId]
    )
    const dbCnt = Number(check.rows[0].cnt)
    const dbTotal = Number(check.rows[0].total)

    if (dbCnt !== records.length || Math.abs(dbTotal - grandTotal) > 0.01) {
      throw new Error(
        `入库校验失败: 期望 ${records.length} 条/${grandTotal}，实际 ${dbCnt} 条/${dbTotal}`
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return {
    batchId,
    inserted: records.length,
    skippedCount: skipped.length,
    totalAmount: grandTotal,
    warnings,
    skipped,
  }
}

// ------------------------------------------------------------
// 客户平台未回款导入（订单级明细，独立表 customer_platform_unpaid）
// 源表 23 列：
//   0 下单平台  1 订单日期  2 公司名称  3 客户订单号  4 客户名称  5 回款状态
//   6 商品名称  7 开票点数  8 数量  9 采购金额  10 发票状态  11 收货人
//   12 采购单价  13 销售单价  14 销售金额  15 销售金额合计  16 导单销售金额
//   17 自检  18 差异调整  19 报账方案编号  20 挂账客户  21 业务员  22 备注
// ------------------------------------------------------------
export async function importCustomerPlatformUnpaid(pool, { xlsxPath, snapshotDate }) {
  const snapshot = snapshotDate || todayDate()

  const wb = XLSX.readFile(xlsxPath, { cellDates: false })
  const sheetName = wb.SheetNames[0]
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    defval: null,
  })
  const header = (rows[0] || []).map((h) => (h == null ? '' : String(h).trim()))
  const dataRows = rows.slice(1).filter((r) => r && r[0] !== null && String(r[0]).trim() !== '')

  const records = []
  const skipped = []
  let sumTotal = 0

  // 按表头列名定位，兼容 23 列（桌面手动导出「表格视图」）与 27 列（云端 kdocs_pull 抓取）两种结构
  const colIdx = {}
  header.forEach((h, i) => { if (h) colIdx[h] = i })
  const at = (r, name) => (colIdx[name] === undefined ? null : r[colIdx[name]])

  const col = (v) => (v === null || v === undefined || v === '' ? null : String(v).trim())
  const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : toNumber(v))

  // 日期列：可能为 Date / Excel 序列 / 字符串
  function toDate(v) {
    if (v instanceof Date) return toDateOnly(v)
    if (typeof v === 'number') return excelSerialToDate(v)
    if (!v) return null
    return toDateOnly(String(v).trim())
  }

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const lineNo = i + 2

    const customerName = col(at(r, '客户名称'))
    const accountCustomer = col(at(r, '挂账客户'))
    if (!customerName && !accountCustomer) {
      skipped.push({ lineNo, reason: '客户名称与挂账客户均为空' })
      continue
    }

    const salesAmountTotal = toNumber(at(r, '销售金额合计'))
    // 口径对齐看板：累加「销售金额」（= 销售单价 × 数量），不用「销售金额合计」
    // （后者是导单销售金额，通常大 3 倍，会让重复批检测的金额比对失效）
    sumTotal += toNumber(at(r, '销售金额'))

    records.push({
      platform: col(at(r, '下单平台')),
      order_date: toDate(at(r, '订单日期')),
      company_name: col(at(r, '公司名称')),
      customer_order_no: col(at(r, '客户订单号')),
      customer_name: customerName,
      payment_status: col(at(r, '回款状态')),
      product_name: col(at(r, '商品名称')),
      invoice_points: numOrNull(at(r, '开票点数')),
      qty: numOrNull(at(r, '数量')),
      purchase_amount: toNumber(at(r, '采购金额')),
      invoice_status: col(at(r, '发票状态')),
      receiver: col(at(r, '收货人')),
      purchase_unit_price: numOrNull(at(r, '采购单价')),
      sales_unit_price: numOrNull(at(r, '销售单价')),
      sales_amount: toNumber(at(r, '销售金额')),
      sales_amount_total: salesAmountTotal,
      guided_sales_amount: toNumber(at(r, '导单销售金额')),
      self_check: col(at(r, '自检')),
      diff_adjustment: toNumber(at(r, '差异调整')),
      report_plan_no: col(at(r, '报账方案编号')),
      account_customer: accountCustomer,
      salesperson: col(at(r, '业务员')) || '未指定',
      remark: col(at(r, '备注')),
    })
  }

  const grandTotal = Math.round(sumTotal * 100) / 100

  // ---------- 重复批检测（2026-09-29 新增）----------
  // 源表《客户未回款》按周出数，但同步每天跑，于是库里会出现内容完全相同的连续快照
  // （实测 09-24 与 09-28 两批的行数/金额/最早最晚订单日期逐项一致）。
  // 这种批入库后，「较上期」恒为 0.0%，看板失去意义，而且会把真正的上期挤掉。
  //
  // 判定：取比本次快照更早的最近一批，比较「行数 + 销售金额 + 订单日期范围」，
  // 三者全等即视为重复，**不写入本次快照**（相当于这次抓取白跑，源表没更新）。
  // 用订单日期范围而不是逐行 diff：前者一次查询就能拿到，且对「同数据不同顺序」也成立。
  if (records.length > 0) {
    const early = await pool.connect()
    try {
      const { rows: dup } = await early.query(
        `SELECT snapshot_date,
                COUNT(*)                          AS n,
                ROUND(SUM(sales_amount)::numeric, 2) AS amt,
                MIN(order_date)                   AS eo,
                MAX(order_date)                   AS lo
           FROM customer_platform_unpaid
          WHERE snapshot_date < $1::date
          GROUP BY snapshot_date
          ORDER BY snapshot_date DESC
          LIMIT 1`,
        [snapshot]
      )
      const prev = dup[0]
      if (prev) {
        const sameCount = Number(prev.n) === records.length
        const sameAmount = Math.abs(Number(prev.amt) - grandTotal) <= 0.03
        const dates = records.map((r) => r.order_date).filter(Boolean).sort()
        const myEo = dates[0] || null
        const myLo = dates[dates.length - 1] || null
        const pEo = prev.eo ? toDateOnly(prev.eo) : null
        const pLo = prev.lo ? toDateOnly(prev.lo) : null
        const sameRange = myEo === pEo && myLo === pLo

        if (sameCount && sameAmount && sameRange) {
          console.log(
            `[import] 跳过重复批 ${snapshot}：与 ${toDateOnly(prev.snapshot_date)} 内容完全相同` +
            `（${records.length} 行 / ${grandTotal} / ${myEo}~${myLo}），源表未更新`
          )
          return {
            inserted: 0,
            skippedCount: skipped.length,
            totalAmount: grandTotal,
            skipped,
            duplicateOf: toDateOnly(prev.snapshot_date),
          }
        }
      }
    } finally {
      early.release()
    }
  }

  // 入库（事务，同日覆盖）
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      'DELETE FROM customer_platform_unpaid WHERE snapshot_date = $1',
      [snapshot]
    )

    const cols = [
      'snapshot_date', 'platform', 'order_date', 'company_name', 'customer_order_no',
      'customer_name', 'payment_status', 'product_name', 'invoice_points', 'qty',
      'purchase_amount', 'invoice_status', 'receiver', 'purchase_unit_price',
      'sales_unit_price', 'sales_amount', 'sales_amount_total', 'guided_sales_amount',
      'self_check', 'diff_adjustment', 'report_plan_no', 'account_customer',
      'salesperson', 'remark',
    ]
    const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(',')

    for (const rec of records) {
      const values = [snapshot, ...cols.slice(1).map((c) => rec[c])]
      await client.query(
        `INSERT INTO customer_platform_unpaid (${cols.join(',')}) VALUES (${placeholders})`,
        values
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return {
    inserted: records.length,
    skippedCount: skipped.length,
    totalAmount: grandTotal,
    skipped,
  }
}