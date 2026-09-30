/**
 * 独立交叉验证：直接用 SQL 算「最新批 − 上一个批」的四个指标差值，
 * 与 /api/summary 的 prev 结果比对。
 *
 * 为什么要单独做：验证脚本里是「页面 vs 接口」，两者可能同源出错而互相印证。
 * 这里绕开接口，直接查库独立算一遍，才算真正的交叉验证。
 */
import 'dotenv/config'
import { query } from './server/db/pool.js'

const AGG = `
  SELECT COUNT(*)                              AS doc_count,
         COUNT(DISTINCT customer_name)         AS customer_count,
         COUNT(DISTINCT salesperson)           AS salesperson_count,
         COALESCE(SUM(amount_total), 0)        AS total,
         COALESCE(SUM(amount_over3m), 0)       AS over3m
    FROM receivable_detail WHERE batch_id = $1`

const money = v => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

for (const biz of ['billed_unpaid', 'shipped_uninvoiced']) {
  const b = await query(
    `SELECT id, to_char(snapshot_date,'YYYY-MM-DD') d FROM import_batch
      WHERE biz_type = $1 ORDER BY snapshot_date DESC, id DESC LIMIT 2`, [biz])

  if (b.rows.length < 2) { console.log(`\n[${biz}] 批次不足 2 个，跳过`); continue }

  const [cur, prv] = b.rows
  const c = (await query(AGG, [cur.id])).rows[0]
  const p = (await query(AGG, [prv.id])).rows[0]

  console.log(`\n=== ${biz} ===`)
  console.log(`  本期批 ${cur.d} (id=${cur.id})   上期批 ${prv.d} (id=${prv.id})`)
  console.log(`  ${'指标'.padEnd(12)} ${'本期'.padStart(16)} ${'上期'.padStart(16)} ${'差值'.padStart(16)}`)
  const row = (name, a, b2, isMoney = true) => {
    const d = Number(a) - Number(b2)
    const dd = isMoney ? Math.round(d * 100) / 100 : d
    console.log(`  ${name.padEnd(12)} ${(isMoney ? money(a) : a).padStart(16)} ${(isMoney ? money(b2) : b2).padStart(16)} ${(dd > 0 ? '+' : '') + (isMoney ? money(dd) : dd)}`)
    return dd
  }
  const dTotal = row('总额', c.total, p.total)
  const dOver = row('3个月以上', c.over3m, p.over3m)
  const dDoc = row('单据数', c.doc_count, p.doc_count, false)
  const dSp = row('业务员数', c.salesperson_count, p.salesperson_count, false)

  // 与接口对账（账号密码 / 服务地址走环境变量，默认值与 .env 一致）
  const API_BASE = process.env.XCHECK_API_BASE || 'http://localhost:3000'
  const USER = process.env.XCHECK_USER || '4111'
  const PASS = process.env.XCHECK_PASSWORD || 'tuoben'
  const r = await fetch(`${API_BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  }).then(x => x.json())
  const token = r.token || r.authToken
  const api = await fetch(`${API_BASE}/api/summary?bizType=${biz}`, {
    headers: { 'X-Auth-Token': token },
  }).then(x => x.json())

  const checks = [
    ['总额', dTotal, Math.round((api.total - api.prev.total) * 100) / 100],
    ['3个月以上', dOver, Math.round((api.over3m - api.prev.over3m) * 100) / 100],
    ['单据数', dDoc, api.invoiceCount - api.prev.invoiceCount],
    ['业务员数', dSp, api.salespersonCount - api.prev.salespersonCount],
  ]
  console.log('  --- 与 /api/summary 对账 ---')
  let allOk = true
  for (const [name, sqlVal, apiVal] of checks) {
    const ok = Math.abs(Number(sqlVal) - Number(apiVal)) < 0.005
    if (!ok) allOk = false
    console.log(`    ${ok ? '✅' : '❌'} ${name.padEnd(10)} SQL=${sqlVal}  接口=${apiVal}`)
  }
  console.log(`    基线日期：SQL 上期批=${prv.d}  接口 prev.snapshotDate=${api.prev.snapshotDate}  ${prv.d === api.prev.snapshotDate ? '✅' : '❌'}`)
  console.log(`  ${allOk ? '✅ 该项一致' : '❌ 该项不一致'}`)
}
