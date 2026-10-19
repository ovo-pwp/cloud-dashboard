/**
 * Excel 导入核心逻辑（可复用）
 *
 * 把原来 import-excel.js 里的「读文件 → 转换 → 校验 → 落库」抽成独立函数，
 * 供 CLI 脚本（import-excel.js）与文件夹监控（watcher.js）共用。
 * 调用方负责持有/释放连接池，这里不做 pool.end()。
 */

import XLSX from 'xlsx'
import { todayDate, toDateOnly } from '../utils/date.js'
import { toCityBatch } from './city.js'

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
      // 备注（跟进情况）不再从源表带入（2026-10-19 使用者决定）：
      //   以前这里 toText(r[12]) 会拿源表第 13 列覆盖掉使用者在系统里填的备注，
      //   而且同步是「DELETE 整批 + INSERT 重建」，一同步就把手写备注冲没了。
      //   现在备注只在系统里加、只在系统里存 —— 独立表 detail_note（主键 biz_type+doc_no），
      //   导入完全不碰它。这里固定置 null，receivable_detail.follow_up_note 随之退役。
      follow_up_note: null,
      // 第 14 列 = 源表那一列「地址」。未开票那张表没有这列，取到就是 null。
      // ⚠️ 源表里填的是**完整地址**（`广西南宁市青秀区古城路39号`），
      //    循环结束后统一用 toCityBatch 归一化成**只到市**，见下方注释。
      city: toText(r[13]) || null,
      // 第 15 列 = 「行系」（2026-10-19 加，使用者「明细把行系和地区也展示出来」）。
      //   值 = 工行/中行/建行/农信/邮储/农行/其他金融行业-桂林银行/非金融行业-*。
      //   ⚠️ 只有「已发货未开票」源表(对账表)有这列；「已开票未回款」源表(开票表)没有
      //      ⇒ 那条线恒为 null，明细页显示空。两线列序靠取数脚本补齐占位列保持一致
      //      （见 kdocs_pull.py 里「…备注 | 地址 | 行系」的注释）。
      row_system: toText(r[14]) || null,
      data_warning: dataWarning,
    })
  }

  // ---------- 「地址」→「城市」归一化：只到市（2026-10-12 使用者要求）----------
  // 放在这里而不是界面：明细列表 / 城市筛选下拉 / 优先级清单 / Excel 导出**四处共用** city，
  // 只在界面截会导致下拉里是整条地址、而 `WHERE city = $n` 精确匹配筛不出东西。
  // 规则与逐条核对结论见 services/city.js 顶部注释。
  const cities = toCityBatch(records.map((r) => r.city))
  records.forEach((r, i) => { r.city = cities[i] })

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
      'city', 'row_system',
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

    // 行数必须**完全一致** —— 少一行就是读文件出了问题（列错位 / 尾部被截）
    // 金额给 ¥0.5 的余量：只为兜住下面的舍入顺序差，抓不出「整列错位」那种级别的问题早已足够
    if (dbCnt !== records.length || Math.abs(dbTotal - grandTotal) > 0.5) {
      throw new Error(
        `入库校验失败: 期望 ${records.length} 条/${grandTotal}，实际 ${dbCnt} 条/${dbTotal}`
      )
    }

    // 🔴 批次合计**以库里的精确求和为准**回写（2026-10-12 修）
    //
    //    `amount_total` 是 `NUMERIC(16,2)`，Postgres 在 INSERT 时**逐行**四舍五入；
    //    而上面的 `grandTotal` 是「先累加未舍入的原值、最后再舍入一次」——
    //    **先加后舍 ≠ 先舍后加**：源表只要出现 3 位以上小数，两者就会差 ¥0.01。
    //    实测（2026-10-12）：批次合计 11,271,881.24 vs 明细求和 11,271,881.23，
    //    导致 `npm run test:audit` 的「/summary 与批次记录一致」随机失败（前 7 批都是 0.00，
    //    说明这是**数据相关**的偶发，不是每次都有）。
    //
    //    看板上的每一个环比都是「本批合计 − 上批合计」，而明细页表尾合计走的是
    //    `SUM(amount_total)`。两者必须严格相等，否则同一屏里两个数对不上。
    //    所以直接把库里的值写回批次 —— 从此「批次合计 ≡ 明细求和」恒成立。
    if (Math.abs(dbTotal - grandTotal) > 0) {
      await client.query('UPDATE import_batch SET total_amount = $2 WHERE id = $1', [
        batchId,
        dbTotal,
      ])
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

/**
 * 从「客户平台」客户名解析出城市（2026-10-19 地区列专用）。
 *
 * 源表（客户未回款平台 sheet 196）没地址列，但客户名格式稳定有两种：
 *   ① "广西工行（营销品及办公用品）-工行崇左分行-崇左市-线下"  → 含 "XX市"
 *   ② "中国工商银行股份有限公司梧州分行"                     → 以 "XX分行/支行/分理处" 结尾
 * 表里 26 个唯一客户名几乎都是工行，模式固定 ⇒ 这两条够用。
 *
 * 🔴 ② 必须是「白名单匹配」而不是正则抽取。
 *   最初写成 /([\u4e00-\u9fa5]{2,4})(?:分行|支行|分理处)/ 会把
 *   「中国工商银行股份有限公司来宾分行」抽成「公司来宾市」——
 *   因为"股份有限公司"这几个字也被当成了市名的一部分。
 *   改成先扫一遍已知地名，命中才算，宁可留空（前端显示「—」）也不给出错误地区。
 */
const GUANGXI_CITY_TOKENS = [
  '南宁市', '柳州市', '桂林市', '梧州市', '北海市',
  '防城港市', '钦州市', '贵港市', '玉林市', '百色市',
  '贺州市', '河池市', '来宾市', '崇左市',
]

/** 名字里常见的「不是市但能定位到市」的写法 → 归一化到所属地级市（只放确定的，不确定的宁可留空） */
const PLATFORM_CITY_ALIASES = {
  横县: '南宁市', 横州市: '南宁市',
  藤县: '梧州市',
  // 工行东盟支行（东盟商务区位于南宁市江南区）——源表里写的是"东盟商务支行"，
  // 名字里没有"南宁"两个字，不加这条会解析不到（实测 6 行 / 7,620 元）。
  东盟商务: '南宁市',
}

/** 「XX分行 / XX支行 / XX分理处」里的 XX 必须是下面这些字样之一，才认为是地名 */
const PLATFORM_BRANCH_TOKENS = [
  ...GUANGXI_CITY_TOKENS.map((c) => c.replace(/市$/, '')), // 南宁 / 柳州 / ……
  ...Object.keys(PLATFORM_CITY_ALIASES),                    // 横县 / 藤县 …
]

function parsePlatformCustomerCity(name) {
  const s = String(name || '').trim()
  if (!s) return null
  // ① 直接命中"XX市"（长的优先，防城港市先于港市）
  for (const c of GUANGXI_CITY_TOKENS) {
    if (s.includes(c)) return c
  }
  // ② 白名单匹配"XX分行/XX支行/XX分理处"
  //    必须整体判空：只看"含南宁"是不够的（"南宁"可能出现在分行名之外的字串里）
  for (const t of PLATFORM_BRANCH_TOKENS) {
    const plain = t.replace(/市$/, '')
    if (
      s.includes(t + '分行') || s.includes(t + '支行') || s.includes(t + '分理处') ||
      s.includes(plain + '分行') || s.includes(plain + '支行') || s.includes(plain + '分理处')
    ) {
      return PLATFORM_CITY_ALIASES[t] || plain + '市'
    }
  }
  // ③ 只出现地名、但没有分行/支行后缀（如"横州市支行"已由②覆盖；这里兜底裸地名）
  for (const t of PLATFORM_BRANCH_TOKENS) {
    if (s.includes(t)) return PLATFORM_CITY_ALIASES[t] || t + '市'
  }
  return null
}
// 导出一份给回填脚本用：回填和后续导入必须是同一套规则，
// 否则「今天回填出来的地区」和「下周新导入的地区」会对不上。
export { parsePlatformCustomerCity }

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
      // 地区（2026-10-19）：源表无地址列，从 customer_name 解析；解析不到就 null
      city: parsePlatformCustomerCity(customerName),
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
      'salesperson', 'remark', 'city',
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