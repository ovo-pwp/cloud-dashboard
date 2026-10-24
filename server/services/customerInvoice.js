/**
 * 客户开票明细表 —— 「每天开的票 / 回的款」
 *
 * 数据来源：金山文档《客户开票明细表》(sheet 26)，由 kdocs_pull.py 的「客户开票」导出。
 * 口径（使用者 2026-10-12 确认）：
 *   · 不含「业务员 = 财务部」（取数脚本已剔）
 *   · **退票不剔除** —— 按原始记录全额算；所以保留 refund_status 列让人能看出哪些是红冲的
 *   · 开票按 invoice_date，回款按 pay_date
 *
 * 导入策略：**全量替换**（这是「当前状态」表，不需要历史快照）。
 *   整个导入在一个事务里：DELETE 旧数据 → 批量 INSERT，失败自动回滚。
 */
import fs from 'node:fs'
import XLSX from 'xlsx'
import { query, pool } from '../db/pool.js'

export const CUSTOMER_INVOICE_BIZ_TYPE = 'customer_invoice'
export const CUSTOMER_INVOICE_OUT_NAME = '(客户开票明细表)开票回款.xlsx'

const TABLE = 'customer_invoice'

/** 表头名 → 数据库列（按**名字**取，列顺序变了也不怕）
 *  注意：key 必须加引号 —— 源表列名里有全角括号（如「报账方式（渠道）」），
 *  不加引号会被当成非法标识符、直接编译报错。 */
const COL_MAP = {
  '开票方案编号': 'plan_no',
  '申请日期': 'apply_date',
  '申请类型': 'apply_type',
  '报账方式（渠道）': 'channel',
  '报账公司': 'company',
  '挂账客户': 'customer',
  '业务员': 'salesperson',
  '开票日期': 'invoice_date',
  '开票金额': 'invoice_amount',
  '开票状态': 'invoice_status',
  '退票状态': 'refund_status',
  '发票类型': 'invoice_type',
  '回款日期': 'pay_date',
  '回款金额': 'pay_amount',
  '已开票未回款': 'unpaid_amount',
  '货物名称': 'product',
  '报账开票方案名称（子合同）': 'sub_contract',
  '备注': 'remark',
  '预计回款日期': 'expect_pay_date',
}
const COLS = Object.values(COL_MAP)
const DATE_COLS = new Set(['apply_date', 'invoice_date', 'pay_date', 'expect_pay_date'])
const NUM_COLS = new Set(['invoice_amount', 'pay_amount', 'unpaid_amount'])

const str = (v) => {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  return s === '' ? null : s.slice(0, 4000)
}

/** 数字：源表里有 `#VALUE!` / `1.79e-07` 这类脏值，统一处理 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (!s || s.startsWith('#')) return null // #VALUE! / #N/A 等公式错误
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  // 浮点残渣（1.79999915417284e-07）视为 0
  if (Math.abs(n) < 1e-6) return 0
  return Math.round(n * 100) / 100
}

/** 日期：支持 Date 对象 / Excel 序列号 / 字符串 */
function toDate(v) {
  if (!v) return null
  if (v instanceof Date) return iso(v)
  if (typeof v === 'number') {
    // Excel 序列号（1900 纪元，含闰年 bug 的偏移）
    const ms = Math.round((v - 25569) * 86400 * 1000)
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : iso(d)
  }
  const s = String(v).trim().replace(/-/g, '/').split(/[ T]/)[0]
  const p = s.split('/')
  if (p.length !== 3) return null
  const [y, m, d] = p.map((x) => parseInt(x, 10))
  if (!y || !m || !d) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * 导入一张导出 xlsx（全量替换）。
 * @returns {Promise<{inserted:number, skipped:number, invoiceTotal:number, payTotal:number, warnings:string[]}>}
 */
export async function importCustomerInvoice(pool, { xlsxPath }) {
  if (!fs.existsSync(xlsxPath)) throw new Error(`找不到导出文件：${xlsxPath}`)

  const wb = XLSX.readFile(xlsxPath, { cellDates: false })
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null })
  const header = (rows[0] || []).map((h) => (h == null ? '' : String(h).trim()))
  const data = rows.slice(1).filter((r) => r && r[0] !== null && String(r[0]).trim() !== '')

  const idx = {}
  header.forEach((h, i) => {
    if (h && COL_MAP[h]) idx[COL_MAP[h]] = i
  })
  const missing = COLS.filter((c) => idx[c] === undefined)
  const warnings = []
  if (missing.length) warnings.push('导出缺少列：' + missing.join(', '))

  const records = []
  let skipped = 0
  let invoiceTotal = 0
  let payTotal = 0

  for (const r of data) {
    const rec = {}
    for (const col of COLS) {
      const i = idx[col]
      if (i === undefined) {
        rec[col] = null
        continue
      }
      const v = r[i]
      rec[col] = DATE_COLS.has(col) ? toDate(v) : NUM_COLS.has(col) ? num(v) : str(v)
    }
    // 既没有开票日期也没有回款日期的行，进不了任何一天，跳过
    if (!rec.invoice_date && !rec.pay_date) {
      skipped++
      continue
    }
    invoiceTotal += rec.invoice_amount || 0
    payTotal += rec.pay_amount || 0
    records.push(rec)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM ${TABLE}`)
    // 分批插入，避免单条 SQL 参数过多（19 列 × 200 行 = 3800 个参数）
    const CHUNK = 200
    for (let i = 0; i < records.length; i += CHUNK) {
      const part = records.slice(i, i + CHUNK)
      const p = []
      const v = []
      part.forEach((rec, n) => {
        const base = n * COLS.length
        p.push('(' + COLS.map((_, k) => `$${base + k + 1}`).join(',') + ')')
        COLS.forEach((c) => v.push(rec[c]))
      })
      await client.query(
        `INSERT INTO ${TABLE} (${COLS.join(',')}) VALUES ${p.join(',')}`,
        v
      )
    }
    await client.query('COMMIT')
    return {
      inserted: records.length,
      skipped,
      invoiceTotal: Math.round(invoiceTotal * 100) / 100,
      payTotal: Math.round(payTotal * 100) / 100,
      warnings,
    }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/** 一行数据 → 接口返回的形状 */
const toRow = (r) => ({
  planNo: r.plan_no || '',
  customer: r.customer || '',
  salesperson: r.salesperson || '',
  amount: Number(r.amount || 0),
  status: r.invoice_status || '',
  refund: r.refund_status || '',
  invoiceType: r.invoice_type || '',
  product: r.product || '',
  date: r.d,
})

// ------------------------------------------------------------
// 客户对账明细表（sheet 123）—— 页面左半边
//   使用者 2026-10-12 明确要这些金额列：
//     期初欠款 / 实际出库金额 / 线下对账金额 / 平台对账金额 / 龙集采对账 / 已发货未开票
//   日期一律按 **执行日期**。
// ------------------------------------------------------------
const RECON_TABLE = 'customer_recon'

const RECON_MAP = {
  '合同执行编号': 'contract_no',
  '执行日期': 'exec_date',
  '项目执行名称': 'project_name',
  '挂账客户': 'customer',
  '业务员': 'salesperson',
  '产品线': 'product_line',
  '下单状态': 'order_status',
  '实际出库金额': 'ship_amount',
  '线下对账金额': 'offline_amount',
  '平台对账金额': 'platform_amount',
  '龙集采对账': 'ltc_amount',
  '期初欠款': 'opening_debt',
  '已发货未开票': 'uninvoiced_amount',
  '开票勾选': 'invoice_checked',
  '备注': 'remark',
}
const RECON_COLS = Object.values(RECON_MAP)
const RECON_NUM = new Set([
  'ship_amount', 'offline_amount', 'platform_amount', 'ltc_amount',
  'opening_debt', 'uninvoiced_amount',
])

/** 导入《客户对账明细表》导出（全量替换） */
export async function importCustomerRecon(pool, { xlsxPath }) {
  if (!fs.existsSync(xlsxPath)) throw new Error(`找不到导出文件：${xlsxPath}`)
  const wb = XLSX.readFile(xlsxPath, { cellDates: false })
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null })
  const header = (rows[0] || []).map((h) => (h == null ? '' : String(h).trim()))
  const data = rows.slice(1).filter((r) => r && r[0] !== null && String(r[0]).trim() !== '')

  const idx = {}
  header.forEach((h, i) => {
    if (h && RECON_MAP[h]) idx[RECON_MAP[h]] = i
  })

  const records = []
  let shipTotal = 0
  for (const r of data) {
    const rec = {}
    for (const col of RECON_COLS) {
      const i = idx[col]
      if (i === undefined) {
        rec[col] = null
        continue
      }
      const v = r[i]
      rec[col] = col === 'exec_date' ? toDate(v) : RECON_NUM.has(col) ? num(v) : str(v)
    }
    if (!rec.exec_date) continue // 没有执行日期的进不了任何一天
    shipTotal += rec.uninvoiced_amount || 0
    records.push(rec)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM ${RECON_TABLE}`)
    const CHUNK = 200
    for (let i = 0; i < records.length; i += CHUNK) {
      const part = records.slice(i, i + CHUNK)
      const p = []
      const v = []
      part.forEach((rec, n) => {
        const base = n * RECON_COLS.length
        p.push('(' + RECON_COLS.map((_, k) => `$${base + k + 1}`).join(',') + ')')
        RECON_COLS.forEach((c) => v.push(rec[c]))
      })
      await client.query(
        `INSERT INTO ${RECON_TABLE} (${RECON_COLS.join(',')}) VALUES ${p.join(',')}`,
        v
      )
    }
    await client.query('COMMIT')
    return {
      inserted: records.length,
      skipped: data.length - records.length,
      uninvoicedTotal: Math.round(shipTotal * 100) / 100,
    }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * 左半边：客户对账明细，按**执行日期**分组。
 * 金额列全部返回，让界面按使用者要的那样并排显示。
 */
async function getReconByDay({ from, to, salesperson, latest = false }) {
  const cond = [`COALESCE(salesperson,'') <> '财务部'`]
  if (latest) cond.push(`exec_date BETWEEN (SELECT MAX(exec_date) FROM ${RECON_TABLE}) - INTERVAL '2 days' AND (SELECT MAX(exec_date) FROM ${RECON_TABLE})`)
  const params = []
  if (from) { params.push(from); cond.push(`exec_date >= $${params.length}`) }
  if (to) { params.push(to); cond.push(`exec_date <= $${params.length}`) }
  if (salesperson) { params.push(salesperson); cond.push(`salesperson = $${params.length}`) }

  const { rows } = await query(
    `SELECT to_char(exec_date,'YYYY-MM-DD') d, contract_no, project_name, customer, salesperson,
            product_line, order_status, ship_amount, offline_amount, platform_amount,
            ltc_amount, opening_debt, uninvoiced_amount, invoice_checked, remark
       FROM ${RECON_TABLE}
      WHERE ${cond.join(' AND ')}
      ORDER BY exec_date DESC, uninvoiced_amount DESC NULLS LAST`,
    params
  )
  return rows
}

const toRecon = (r) => ({
  contractNo: r.contract_no || '',
  projectName: r.project_name || '',
  customer: r.customer || '',
  salesperson: r.salesperson || '',
  productLine: r.product_line || '',
  orderStatus: r.order_status || '',
  shipAmount: Number(r.ship_amount || 0),
  offlineAmount: Number(r.offline_amount || 0),
  platformAmount: Number(r.platform_amount || 0),
  ltcAmount: Number(r.ltc_amount || 0),
  openingDebt: Number(r.opening_debt || 0),
  uninvoicedAmount: Number(r.uninvoiced_amount || 0),
  invoiceChecked: r.invoice_checked || '',
  remark: r.remark || '',
})

/**
 * 按天取「已发货未开票（执行日期）」和「回款（回款日期）」的逐笔明细。
 * @param {object} o { from, to, salesperson }
 */

/**
 * 本条线「本批 vs 上批」的差异明细（2026-10-12 使用者要求）
 *
 * 用途：页面下面那块要**和上面卡片的环比一一对应** ——
 *      列出「新增 / 消失 / 金额改动」三种单，三条小计之和 = 卡片的环比数值。
 *
 * 按 doc_no（开票方案编号 / 合同执行编号）配对；金额差 > 0.005 视为改动。
 *
 * @param {string} bizType billed_unpaid | shipped_uninvoiced
 * @param {string} [salesperson] 可选。给了就只比这个业务员名下的单。
 *   🔴 口径一致性：不传时 `prevTotal/curTotal/delta` 直接取 `import_batch.total_amount`
 *      —— 这是**上面卡片环比用的同一个数**，保证「变动卡 = 卡片环比」分毫不差。
 *      传了 `salesperson` 时批次合计没意义，改用**该业务员行金额之和**。
 *   ⚠️ 逐行过滤会带来一个已知副作用：同一 doc_no 换业务员时，会同时出现在
 *      「消失」（旧人）和「新增」（新人）里 —— 这是对的，本来就是换了归属。
 */
export async function getLineDelta({ bizType, salesperson }) {
  const bs = (
    await query(
      `SELECT id, to_char(snapshot_date,'YYYY-MM-DD') d, ROUND(total_amount::numeric,2)::float8 amt, row_count
         FROM import_batch WHERE biz_type=$1 ORDER BY snapshot_date DESC, id DESC LIMIT 2`,
      [bizType]
    )
  ).rows
  if (bs.length < 2) {
    return { bizType, prevDate: null, curDate: bs[0]?.d || null,
             salespersons: [], salesperson: salesperson || '',
             added: [], removed: [], changed: [],
             summary: { addedAmount: 0, removedAmount: 0, changedAmount: 0, delta: 0 }, ready: false }
  }
  const [cur, prev] = bs
  // 2026-10-24 使用者「开票跟回款都按照销售战队」⇒ 多带一个 department，
  // 前端汇总卡按部门分组（原先按 salesperson 人名）。
  const cols = `doc_no, customer_name, salesperson, department, amount_total::float8 amt, aging_category`
  const curAll = (await query(`SELECT ${cols} FROM receivable_detail WHERE batch_id=$1`, [cur.id])).rows
  const prevAll = (await query(`SELECT ${cols} FROM receivable_detail WHERE batch_id=$1`, [prev.id])).rows

  // 业务员候选：取**两批全量**（不加过滤），否则「本期没动的人」在下拉里会凭空消失
  const salespersons = [
    ...new Set([...curAll, ...prevAll].map((r) => (r.salesperson || '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  const sp = (salesperson || '').trim()
  const curRows = sp ? curAll.filter((r) => (r.salesperson || '').trim() === sp) : curAll
  const prevRows = sp ? prevAll.filter((r) => (r.salesperson || '').trim() === sp) : prevAll

  const prevMap = new Map(prevRows.map((r) => [r.doc_no, r]))
  const added = []
  const changed = []
  for (const r of curRows) {
    const p = prevMap.get(r.doc_no)
    if (!p) {
      added.push(r)
    } else {
      if (Math.abs(Number(p.amt) - Number(r.amt)) > 0.005) {
        changed.push({ ...r, oldAmount: Number(p.amt), diff: Number(r.amt) - Number(p.amt) })
      }
      prevMap.delete(r.doc_no)
    }
  }
  const removed = [...prevMap.values()]
  const sum = (a, k) => Math.round(a.reduce((s2, x) => s2 + Number(k ? x[k] : x.amt || 0), 0) * 100) / 100

  // ------------------------------------------------------------
  // 「新增」拆两拨（2026-10-14 使用者：「就统计今日新增…不要上一次表里面摸鱼出现的就爆出来」）
  //
  //   · 真新增 = 账龄在「当月」档 ⇒ 这一批才发货、还没满一个月
  //   · 补录   = 账龄是 一个月/两个月/三个月/三个月以上 ⇒ 货早就发了，
  //              是**源表当时漏登记、这一批才补录进来**的（俗称"摸鱼单"）
  //
  // 实测（未开票线 10-12 → 10-13）：30 张「新增」里 **23 张是补录**，
  //   金额 380,355.88 / 410,298.67 = **92.7%** ⇒ 不拆的话「今日新增」会被补录撑大一个量级，
  //   领导看到 41 万「今日新增」，实际今天真发生的只有 29,942.79。
  //
  // ⚠️ 判断依据用**源表自带的 `aging_category`**，不是 `doc_date` ——
  //    分档口径以源表为准（实测 42 天归「两个月」、38 天归「一个月」，按天数反推会错）。
  // ⚠️ `summary.addedAmount` 仍返回**全量**（含补录）：变动恒等式
  //    `变动 = 新增 − 已开票 + 金额改动` 必须对得上，不能因为拆组就少一块。
  // ------------------------------------------------------------
  const isCurrentAging = (r) => !r.aging_category || /当月/.test(String(r.aging_category))
  const backfilled = added.filter((r) => !isCurrentAging(r))
  const addedReal = added.filter(isCurrentAging)

  const prevTotal = sp ? sum(prevRows) : prev.amt
  const curTotal = sp ? sum(curRows) : cur.amt

  return {
    bizType,
    salesperson: sp,
    salespersons,
    prevDate: prev.d,
    curDate: cur.d,
    prevTotal,
    curTotal,
    /** 真新增（账龄「当月」档） */
    added: addedReal,
    /** 补录：老单补登记（账龄不是「当月」档） */
    backfilled,
    removed,
    changed,
    summary: {
      addedAmount: sum(added), // 全量（真新增 + 补录），变动恒等式用这个
      addedRealAmount: sum(addedReal),
      backfilledAmount: sum(backfilled),
      removedAmount: sum(removed),
      changedAmount: sum(changed, 'diff'),
      delta: Math.round((curTotal - prevTotal) * 100) / 100,
    },
    ready: true,
  }
}

export async function getInvoiceDaily({ from, to, salesperson, latest = false }) {
  // latest：两侧**各取各的「最近 3 天」**（2026-10-12）
  //   ⚠️ 不能用「全局最新一天」—— 实测发货最新 10-13、回款最新 10-10，
  //      取全局会把回款那侧挤成空的。
  //   ⚠️ 也不能只取「最新那一天」—— 10-13 只有 1 笔，而当天上升的 7 笔在 10-12 及之前，
  //      使用者当场发现「下面只有一份开票」。
  //   ⇒ 各侧以**自己的 MAX 日期**为终点、往前推 2 天（共 3 天）。
  let latestRecon = false
  let latestPay = false
  if (latest) {
    latestRecon = true
    latestPay = true
    from = null
    to = null
  }
  /** 按「哪个日期列」组装 WHERE + 绑定参数（参数化，防注入） */
  const buildWhere = (dateCol) => {
    const cond = []
    const params = []
    if (from) {
      params.push(from)
      cond.push(`${dateCol} >= $${params.length}`)
    }
    if (to) {
      params.push(to)
      cond.push(`${dateCol} <= $${params.length}`)
    }
    if (salesperson) {
      params.push(salesperson)
      cond.push(`salesperson = $${params.length}`)
    }
    if (latestPay) cond.push(`pay_date BETWEEN (SELECT MAX(pay_date) FROM ${TABLE}) - INTERVAL '2 days' AND (SELECT MAX(pay_date) FROM ${TABLE})`)
    return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params }
  }

  // 左：客户对账明细（执行日期）
  const recon = await getReconByDay({ from, to, salesperson, latest: latestRecon })

  // 右：回款（回款日期）
  const w2 = buildWhere('pay_date')
  const pay = await query(
    `SELECT to_char(pay_date,'YYYY-MM-DD') d, plan_no, customer, salesperson,
            pay_amount AS amount, invoice_status, refund_status, invoice_type, product
       FROM ${TABLE} ${w2.where}
      ORDER BY pay_date DESC, pay_amount DESC NULLS LAST`,
    w2.params
  )

  const byDay = new Map()
  const ensure = (d) => {
    if (!byDay.has(d)) byDay.set(d, { date: d, shipped: [], payments: [] })
    return byDay.get(d)
  }
  recon.forEach((r) => ensure(r.d).shipped.push(toRecon(r)))
  pay.rows.forEach((r) => ensure(r.d).payments.push(toRow(r)))

  const sum = (arr, key) => arr.reduce((s, x) => s + Number(key ? x[key] : x.amount || 0), 0)
  const days = [...byDay.values()]
    .map((x) => ({
      date: x.date,
      shippedCount: x.shipped.length,
      // 「已发货未开票」金额 —— 与现有那条线同口径，日期改按执行日期
      shippedAmount: Math.round(sum(x.shipped, 'uninvoicedAmount') * 100) / 100,
      shipAmount: Math.round(sum(x.shipped, 'shipAmount') * 100) / 100,
      offlineAmount: Math.round(sum(x.shipped, 'offlineAmount') * 100) / 100,
      platformAmount: Math.round(sum(x.shipped, 'platformAmount') * 100) / 100,
      ltcAmount: Math.round(sum(x.shipped, 'ltcAmount') * 100) / 100,
      openingDebt: Math.round(sum(x.shipped, 'openingDebt') * 100) / 100,
      payCount: x.payments.length,
      payAmount: Math.round(sum(x.payments) * 100) / 100,
      shipped: x.shipped,
      payments: x.payments,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))

  const t = (k) => Math.round(days.reduce((s, d) => s + (d[k] || 0), 0) * 100) / 100
  return {
    days,
    summary: {
      days: days.length,
      shippedCount: days.reduce((s, d) => s + d.shippedCount, 0),
      shippedAmount: t('shippedAmount'),
      shipAmount: t('shipAmount'),
      offlineAmount: t('offlineAmount'),
      platformAmount: t('platformAmount'),
      ltcAmount: t('ltcAmount'),
      openingDebt: t('openingDebt'),
      payCount: days.reduce((s, d) => s + d.payCount, 0),
      payAmount: t('payAmount'),
    },
    salespersons: (
      await query(
        `SELECT salesperson FROM (
           SELECT DISTINCT salesperson FROM ${TABLE} WHERE COALESCE(salesperson,'') <> ''
           UNION
           SELECT DISTINCT salesperson FROM ${RECON_TABLE} WHERE COALESCE(salesperson,'') <> ''
         ) t WHERE salesperson <> '财务部' ORDER BY salesperson`
      )
    ).rows.map((r) => r.salesperson),
    dataRange: (
      await query(
        `SELECT to_char(MIN(d),'YYYY-MM-DD') a, to_char(MAX(d),'YYYY-MM-DD') b FROM (
           SELECT invoice_date d FROM ${TABLE}
           UNION SELECT pay_date FROM ${TABLE}
           UNION SELECT exec_date FROM ${RECON_TABLE}
         ) t`
      )
    ).rows[0],
  }
}

/** 空表 → 返回空结构（导入前页面也能打开） */
export async function tableReady() {
  const r = await query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS ok`,
    [TABLE]
  )
  return !!r.rows[0]?.ok
}
