/**
 * 临时测试：同步持久化在 HTTP 层的表现
 *   node _test_sync_http.mjs      （需要后端已启动）
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { query, pool } from './server/db/pool.js'
import { issueLoginToken } from './server/services/syncAuth.js'

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`
const TOKEN = issueLoginToken('4111', false)
const H = { 'X-Auth-Token': TOKEN }

let passed = 0
async function t(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✔ ${name}`)
  } catch (err) {
    console.log(`  ✖ ${name}\n      ${err.message}`)
    process.exitCode = 1
  }
}
const get = async (p) => {
  const r = await fetch(BASE + p, { headers: H })
  let body = null
  try { body = await r.json() } catch { /* ignore */ }
  return { status: r.status, body, headers: r.headers }
}

console.log('\n=== A. 未登录仍被拦住 ===')
await t('没有令牌访问 /api/sync/runs → 401', async () => {
  const r = await fetch(BASE + '/api/sync/runs')
  assert.equal(r.status, 401)
})

console.log('\n=== B. 只读接口 ===')
await t('GET /api/sync/status 正常，字段齐全', async () => {
  const { status, body } = await get('/api/sync/status')
  assert.equal(status, 200)
  for (const k of ['running', 'step', 'log', 'sources', 'interrupted', 'persistedAtBoot']) {
    assert.ok(k in body, `缺少字段 ${k}`)
  }
  assert.equal(body.running, false)
  assert.ok(Array.isArray(body.sources) && body.sources.length >= 3, '数据源快照应已随启动恢复')
})

await t('GET /api/sync/runs 正常返回数组', async () => {
  const { status, body } = await get('/api/sync/runs?limit=5')
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.runs))
})

console.log('\n=== C. 并发互斥（HTTP 层）===')
let fakeId
await t('数据库里存在活跃同步时，POST /api/sync 返回 409', async () => {
  // 直接插一条 active 记录，模拟「另一个同步正在跑」，避免真的去抓云端
  const { rows } = await query(
    `INSERT INTO sync_run (trigger, host, step) VALUES ('manual', 'test-http', 'import') RETURNING id`
  )
  fakeId = Number(rows[0].id)

  const r = await fetch(BASE + '/api/sync', { method: 'POST', headers: H })
  const body = await r.json()
  assert.equal(r.status, 409, `期望 409，实际 ${r.status}：${JSON.stringify(body)}`)
  assert.match(body.error, /已有同步任务正在执行/)
})

await t('被拒的请求没有污染那条活跃记录', async () => {
  const { rows } = await query(`SELECT * FROM sync_run WHERE id = $1`, [fakeId])
  assert.equal(rows[0].active, true)
  assert.equal(rows[0].step, 'import')
  assert.equal(rows[0].message, null)
})

await t('活跃记录出现在 /api/sync/runs 顶部且 active=true', async () => {
  const { body } = await get('/api/sync/runs?limit=3')
  assert.equal(body.runs[0].id, fakeId)
  assert.equal(body.runs[0].active, true)
  assert.equal(body.runs[0].host, 'test-http')
})

console.log('\n=== D. 清理 ===')
// 这里只清理本测试造出来的那条假记录，不触发任何真实同步
const { rowCount } = await query(`DELETE FROM sync_run WHERE host = 'test-http'`)
console.log(`  已删除测试记录 ${rowCount} 条`)
const { rows: after } = await query(`SELECT count(*)::int AS c FROM sync_run WHERE active`)
assert.equal(after[0].c, 0, '清理后不应残留活跃记录')
console.log('  活跃记录已清零')

console.log(`\n通过 ${passed} 项断言组${process.exitCode ? '（有失败）' : ''}\n`)
await pool.end()
