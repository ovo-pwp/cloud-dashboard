/**
 * 把手工 Excel《客户欠款-按产品线拆分》里的销售反馈导入看板（2026-11-19）
 *
 * 背景：Excel 不再作为同步源（金额全部从利润管控系统自动汇总），
 *   但销售**之前写在 Excel 里**的「沟通回款进度」「备注」是有价值的跟进信息，
 *   得一次性搬进看板的「进度反馈」（detail_note），否则这些内容就断了。
 *
 * 规则（2026-11-19 使用者定案：「覆盖掉原有的」）：
 *   · Excel 的内容**覆盖**看板里原有的反馈（ON CONFLICT DO UPDATE）
 *   · Excel 同时有「沟通回款进度」和「备注」→ 合并成一条（备注在前，短的当补充）
 *   · 客户名对不上的 → 报告出来，不硬塞
 *
 * 用法：node _import-excel-feedback.mjs [--dry-run]
 */
import * as XLSX from 'file:///C:/Users/Administrator/Desktop/cloud-dashboard/node_modules/xlsx/xlsx.mjs'
import fs from 'node:fs'
import { pool } from 'file:///C:/Users/Administrator/Desktop/cloud-dashboard/server/db/pool.js'

const XLSX_PATH = 'C:/Users/Administrator/Desktop/应收看板-数据导出/(客户欠款-按产品线)客户欠款.xlsx'
const DRY = process.argv.includes('--dry-run')

// 1) 读 Excel（xlsx.mjs 是浏览器版，没有 fs ⇒ 自己读 buffer 再 parse）
const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' })
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null })
const header = (rows[0] || []).map((h) => (h == null ? '' : String(h).trim()))
const idx = {}
header.forEach((h, i) => { if (h && idx[h] === undefined) idx[h] = i })
const at = (r, n) => (idx[n] === undefined ? null : r[idx[n]])
const txt = (v) => {
  if (v === null || v === undefined) return ''
  const s = String(v).trim()
  return (s === '-' || s === '—') ? '' : s
}

const excelRows = rows.slice(1)
  .map((r) => ({
    customer: txt(at(r, '挂账客户')),
    progress: txt(at(r, '沟通回款进度')),
    remark: txt(at(r, '备注')),
  }))
  .filter((x) => x.customer && (x.progress || x.remark))

console.log(`Excel 里带反馈的客户：${excelRows.length} 个`)

// 2) 看板最新批次的代表单据号（与页面编辑反馈用的是同一套规则）
const latest = await pool.query(
  `SELECT biz_type, id FROM import_batch b
    WHERE biz_type IN ('billed_unpaid','shipped_uninvoiced')
      AND id = (SELECT id FROM import_batch WHERE biz_type = b.biz_type
                 ORDER BY snapshot_date DESC, id DESC LIMIT 1)`
)
const bid = {}
latest.rows.forEach((r) => { bid[r.biz_type] = r.id })

const rep = await pool.query(
  `WITH c AS (
     SELECT customer_name,
            COUNT(DISTINCT doc_no)::int AS n,
            MIN(doc_no) AS doc_no
       FROM receivable_detail WHERE batch_id IN ($1,$2) GROUP BY 1
   )
   SELECT d.customer_name, d.biz_type, d.doc_no,
          ROW_NUMBER() OVER (PARTITION BY d.customer_name
                             ORDER BY (d.biz_type = 'billed_unpaid') DESC, d.doc_no) AS rn
     FROM receivable_detail d
    WHERE d.batch_id IN ($1,$2)`,
  [bid.billed_unpaid || 0, bid.shipped_uninvoiced || 0]
)
const repMap = new Map()
// ⚠️ ROW_NUMBER() 返回 bigint，node-pg 默认把 int8 当**字符串**返回 ⇒ 必须 Number() 转换，
//    否则 r.rn === 1 永远不成立、映射表全空（踩过一次）
for (const r of rep.rows) if (Number(r.rn) === 1) repMap.set(r.customer_name, r)

/**
 * 客户名归一化：去掉所有非中文/数字字符 + 去掉常见部门后缀字。
 * 源表改过名（如「来宾农行网金王元恢」→「来宾农行网金部-王元恢」），
 * 归一后能对上。**只在唯一命中时使用**，命中多个就放弃（宁可少导也不串客户）。
 */
function normName(s) {
  return String(s || '')
    .replace(/[^一-龥0-9A-Za-z]/g, '')
    // 全局删掉部门/机构用字：源表改过名（「来宾农行网金王元恢」→「来宾农行网金部-王元恢」）
    // 中间多一个「部」也会造成不匹配 ⇒ 不能只删尾部
    .replace(/[部区科室处行店组队]/g, '')
}
const normIndex = new Map()
for (const name of repMap.keys()) {
  const k = normName(name)
  if (!k) continue
  if (!normIndex.has(k)) normIndex.set(k, [])
  normIndex.get(k).push(name)
}
function resolveCustomer(raw) {
  if (repMap.has(raw)) return { name: raw, exact: true }
  const hits = normIndex.get(normName(raw)) || []
  if (hits.length === 1) return { name: hits[0], exact: false }
  return null
}

// 3) 看板里已有的反馈（仅用于统计会被覆盖掉多少条）
const existing = await pool.query(
  `SELECT DISTINCT n.biz_type, n.doc_no, n.note
     FROM detail_note n
     JOIN receivable_detail d ON d.doc_no = n.doc_no AND d.biz_type = n.biz_type
    WHERE n.note IS NOT NULL AND TRIM(n.note) <> ''
      AND d.batch_id IN ($1, $2)`,
  [bid.billed_unpaid || 0, bid.shipped_uninvoiced || 0]
)
const hasNote = new Set(existing.rows.map((r) => `${r.biz_type}|${r.doc_no}`))

// 4) 逐个导入（覆盖写）
let imported = 0, overwrote = 0, noMatch = 0
const unmatched = []
const samples = []

for (const x of excelRows) {
  const hit = resolveCustomer(x.customer)
  if (!hit) { noMatch++; unmatched.push(x.customer); continue }
  const r = repMap.get(hit.name)

  const note = [x.progress, x.remark && `【备注】${x.remark}`].filter(Boolean).join(' ｜ ')
  if (!note) continue
  if (hasNote.has(`${r.biz_type}|${r.doc_no}`)) overwrote++
  if (DRY) { imported++; if (samples.length < 5) samples.push({ customer: x.customer, doc: r.doc_no, note: note.slice(0, 50) }); continue }

  await pool.query(
    `INSERT INTO detail_note (biz_type, doc_no, note, updated_by)
     VALUES ($1, $2, $3, 'Excel导入')
     ON CONFLICT (biz_type, doc_no)
     DO UPDATE SET note = EXCLUDED.note, updated_at = NOW(), updated_by = 'Excel导入'`,
    [r.biz_type, r.doc_no, note]
  )
  imported++
  if (samples.length < 5) samples.push({ customer: x.customer, doc: r.doc_no, note: note.slice(0, 50) })
}

console.log(`\n${DRY ? '[试运行] ' : ''}导入 ${imported} 条`)
console.log(`  其中覆盖看板原有反馈: ${overwrote}`)
console.log(`  跳过（客户名对不上）: ${noMatch}`)
if (unmatched.length) {
  console.log('  对不上的客户名:')
  console.log('   ', unmatched.slice(0, 12).join(' | '))
}
console.log('\n样例:')
for (const s of samples) console.log('  ', s.customer, '→', s.doc, '|', s.note)

if (!DRY) {
  const cnt = await pool.query(
    `SELECT COUNT(*)::int n FROM detail_note WHERE updated_by = 'Excel导入'`
  )
  console.log(`\n库内标记为「Excel导入」的记录：${cnt.rows[0].n} 条`)
}

await pool.end()
process.exit(0)
