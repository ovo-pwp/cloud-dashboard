/**
 * 客户名规范化回填（2026-11-19）
 *
 * 把历史数据里的客户名按新规则统一：
 *   receivable_detail.customer_name
 *   customer_invoice.customer
 *   customer_recon.customer
 *   customer_debt_daily.customer_name      （每日快照）
 *   customer_debt_product.customer_name    （Excel 导入的旧表）
 *
 * ⚠️ 两个安全前提：
 *   1. **金额绝不能变** —— 脚本结束会校验总额一致，不一致直接报错
 *   2. **不能把两个客户合成一个** —— 归一后撞名的会被列出来（碰撞清单），
 *      默认**不合并**（保持原样），除非明确用 --merge 放行
 *
 * 用法：
 *   node server/scripts/backfill-customer-names.mjs            # 干跑，只报告
 *   node server/scripts/backfill-customer-names.mjs --apply    # 真正回填
 *   node server/scripts/backfill-customer-names.mjs --apply --merge   # 允许合并撞名
 */
import { pool } from '../db/pool.js'
import { normalizeCustomerName, loadNameDict } from '../utils/customerName.js'

const APPLY = process.argv.includes('--apply')
const MERGE = process.argv.includes('--merge')

const dict = loadNameDict()

// ── 1. 收集所有原名，算出映射 ─────────────────────────────
const TABLES = [
  { table: 'receivable_detail', col: 'customer_name' },
  { table: 'customer_invoice', col: 'customer' },
  { table: 'customer_recon', col: 'customer' },
  { table: 'customer_debt_product', col: 'customer_name' },
  { table: 'ledger_note', col: 'customer' },
]

const mapping = new Map()   // 原名 → 新名
for (const t of TABLES) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ${t.col} AS n FROM ${t.table} WHERE ${t.col} IS NOT NULL AND ${t.col} <> ''`
  )
  for (const r of rows) {
    const orig = r.n
    if (mapping.has(orig)) continue
    mapping.set(orig, normalizeCustomerName(orig, dict).name)
  }
}

const changed = [...mapping.entries()].filter(([a, b]) => a !== b)
console.log(`客户名总数 ${mapping.size}，需要改写 ${changed.length}（${((changed.length / mapping.size) * 100).toFixed(1)}%）`)

// 规则命中统计
const byRule = {}
for (const [a, b] of changed) {
  const r = normalizeCustomerName(a, dict).rule || 'clean'
  byRule[r] = (byRule[r] || 0) + 1
}
console.log('按规则:', JSON.stringify(byRule))

// ── 2. 碰撞检测：不同原名归到同一个新名 ────────────────────
// ⚠️ 必须遍历**全部** mapping（不能只看有改动的）——
//    否则「原名A 保持不变」+「原名B 归一后变成 A」这种撞名会漏检，
//    回填时就会撞主键（customer_debt_daily 的 PK 是 日期+客户名）。
const groups = new Map()
for (const [a, b] of mapping) {
  if (!groups.has(b)) groups.set(b, [])
  groups.get(b).push(a)
}
const collisions = [...groups.entries()].filter(([, list]) => list.length > 1)
console.log(`\n⚠️ 归一后撞名的组：${collisions.length}`)
for (const [newName, olds] of collisions) {
  console.log(`   ${newName}  ←  ${olds.join('  /  ')}`)
}

// ── 3. 金额基线 ───────────────────────────────────────────
async function totals() {
  const out = {}
  for (const [t, col] of [['receivable_detail', 'amount_total'], ['customer_invoice', 'invoice_amount'], ['customer_recon', 'ship_amount']]) {
    const { rows } = await pool.query(`SELECT COALESCE(SUM(${col}),0)::float8 AS s FROM ${t}`)
    out[t] = rows[0].s
  }
  return out
}
const before = await totals()

// ── 4. 执行回填 ───────────────────────────────────────────
if (!APPLY) {
  console.log('\n【干跑】未写库。改动预览（前 40 条）:')
  changed.slice(0, 40).forEach(([a, b]) => console.log(`   ${a.padEnd(26)} → ${b}`))
  if (changed.length > 40) console.log(`   ...（其余 ${changed.length - 40} 条）`)
  await pool.end()
  process.exit(0)
}

// 撞名的（除 --merge 外）保持原样：这些原名整体不改
const skip = new Set()
if (!MERGE) collisions.forEach(([, olds]) => olds.forEach((o) => skip.add(o)))

// ── 4. 执行回填（两步改名，避免主键冲突）──────────────────
//   第一步：待改的行先改成唯一临时名；第二步：临时名改成最终名。
//   这样即使「A→B」且表里已存在 B，也不会撞唯一键。
const TMP = '__norm_tmp__'
let totalRows = 0
for (const t of TABLES) {
  const pairs = [...mapping.entries()].filter(([a, b]) => a !== b && !skip.has(a))
  if (!pairs.length) continue
  const olds = pairs.map(([a]) => a)
  // 第一步：加临时前缀
  await pool.query(
    `UPDATE ${t.table} SET ${t.col} = $2 || ${t.col} WHERE ${t.col} = ANY($1::text[])`,
    [olds, TMP]
  )
  // 第二步：临时名 → 最终名
  for (const [a, b] of pairs) {
    const { rowCount } = await pool.query(
      `UPDATE ${t.table} SET ${t.col} = $2 WHERE ${t.col} = $1`,
      [TMP + a, b]
    )
    if (rowCount) totalRows += rowCount
  }
  console.log(`  ${t.table}.${t.col}: 处理 ${pairs.length} 个名字，共 ${totalRows} 行`)
}
console.log(`\n共更新 ${totalRows} 行`)

// ── 5. 金额校验 ───────────────────────────────────────────
const after = await totals()
console.log('\n金额校验:')
let ok = true
for (const k of Object.keys(before)) {
  const same = Math.abs(before[k] - after[k]) < 0.01
  if (!same) ok = false
  console.log(`   ${k.padEnd(20)} ${before[k].toFixed(2)} → ${after[k].toFixed(2)}  ${same ? '✓' : '✗ 不一致！'}`)
}
if (!ok) {
  console.error('\n❌ 金额对不上，请检查！')
  await pool.end()
  process.exit(1)
}

console.log('\n⚠️ 客户欠款日快照未参与改名（合并会产生「两行变一行」撞 PK），')
console.log('   请接着跑历史快照重算：node _backfill-customer-daily.mjs 2026-11-16 2026-11-17 2026-11-18 2026-11-19')

await pool.end()
console.log('\n✅ 完成')
process.exit(0)
