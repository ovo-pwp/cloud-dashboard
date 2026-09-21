/**
 * 临时测试：同步状态持久化（sync_run）与跨进程互斥锁
 *   node _test_sync_run.mjs
 * 跑完自动清理测试产生的数据行。
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { query, pool } from './server/db/pool.js'
import {
  initSyncState,
  getSyncState,
  acquireSyncLock,
  acquireSyncLockWithRecovery,
  releaseSyncLock,
  listSyncRuns,
  reapOrphan,
} from './server/services/syncRunner.js'

let passed = 0
const created = []
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

console.log('\n=== A. 表结构 ===')
await t('sync_run 表存在', async () => {
  const { rows } = await query(`SELECT to_regclass('public.sync_run') AS t`)
  assert.notEqual(rows[0].t, null)
})

await t('唯一部分索引存在（互斥的基石）', async () => {
  const { rows } = await query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'sync_run' AND indexname = 'uniq_sync_run_active'`
  )
  assert.equal(rows.length, 1)
  assert.match(rows[0].indexdef, /UNIQUE/)
  assert.match(rows[0].indexdef, /WHERE active/)
})

console.log('\n=== B. 锁语义 ===')
let id1
await t('第一次抢锁成功', async () => {
  const lock = await acquireSyncLock({ trigger: 'manual', reflect: false })
  assert.equal(lock.ok, true)
  id1 = lock.id
  created.push(id1)
})

await t('第二次抢锁被拒（busy），且数据库里仍只有一条 active', async () => {
  const lock = await acquireSyncLock({ trigger: 'manual', reflect: false })
  assert.equal(lock.ok, false)
  assert.equal(lock.reason, 'busy')
  const { rows } = await query(`SELECT count(*)::int AS c FROM sync_run WHERE active`)
  assert.equal(rows[0].c, 1)
})

await t('reflect:false 不污染内存状态', async () => {
  assert.equal(getSyncState().running, false)
})

await t('释放锁写入结果（active=false / ok / message / 日志行数）', async () => {
  await releaseSyncLock(id1, {
    ok: true,
    message: '测试完成',
    step: 'done',
    log: '第一行\n第二行',
    reflect: false,
  })
  const { rows } = await query(`SELECT * FROM sync_run WHERE id = $1`, [id1])
  assert.equal(rows[0].active, false)
  assert.equal(rows[0].ok, true)
  assert.equal(rows[0].message, '测试完成')
  assert.equal(rows[0].step, 'done')
  assert.notEqual(rows[0].finished_at, null)
  assert.equal(rows[0].log, '第一行\n第二行')
})

console.log('\n=== C. 重启恢复 ===')
// 模拟「同步跑到一半后端被杀」：留一条 active 记录，再走一遍启动流程
let id2
await t('模拟中断：留下一条 active 记录', async () => {
  const lock = await acquireSyncLock({ trigger: 'manual', reflect: false })
  assert.equal(lock.ok, true)
  id2 = lock.id
  created.push(id2)
  await query(`UPDATE sync_run SET pid = $2, step = 'import' WHERE id = $1`, [id2, 999999])
})

await t('initSyncState 把它判定为「中断」并落库', async () => {
  const res = await initSyncState()
  assert.equal(res.ok, true)
  const st = getSyncState()
  assert.equal(st.running, false)
  assert.equal(st.interrupted, true)
  assert.equal(st.step, 'interrupted')
  assert.equal(st.ok, false)
  assert.match(st.message, /未跑完/)
  assert.equal(st.runId, id2)
})

await t('中断记录已写回数据库（active=false）', async () => {
  const { rows } = await query(`SELECT * FROM sync_run WHERE id = $1`, [id2])
  assert.equal(rows[0].active, false)
  assert.equal(rows[0].step, 'interrupted')
  assert.notEqual(rows[0].finished_at, null)
  const { rows: act } = await query(`SELECT count(*)::int AS c FROM sync_run WHERE active`)
  assert.equal(act[0].c, 0)
})

await t('中断后锁是空的，可以重新同步', async () => {
  const lock = await acquireSyncLock({ trigger: 'manual', reflect: false })
  assert.equal(lock.ok, true)
  created.push(lock.id)
  await releaseSyncLock(lock.id, { ok: true, message: '重跑成功', step: 'done', reflect: false })
})

await t('再启动一次：能恢复「上次同步成功」', async () => {
  await initSyncState()
  const st = getSyncState()
  assert.equal(st.running, false)
  assert.equal(st.ok, true)
  assert.equal(st.step, 'done')
  assert.equal(st.message, '重跑成功')
  assert.match(st.startedAt, /^\d{4}-/)
})

await t('恢复后带上了数据源快照', async () => {
  const st = getSyncState()
  assert.ok(Array.isArray(st.sources))
  assert.ok(st.sources.length >= 3, `期望 >=3 个数据源，实际 ${st.sources?.length}`)
})

console.log('\n=== D. 卡死的锁：自愈判定 ===')
// 造一条「很旧 + PID 已消失」的活跃记录
let staleId
await t('准备：60 分钟前、PID=999999 的活跃记录', async () => {
  const { rows } = await query(
    `INSERT INTO sync_run (trigger, host, step, started_at, pid)
     VALUES ('manual', 'test-stale', 'import', now() - interval '60 minutes', 999999)
     RETURNING id`
  )
  staleId = Number(rows[0].id)
  created.push(staleId)
})

let healedId
await t('陈旧 + PID 已消失 → 自动回收并成功抢到锁', async () => {
  const lock = await acquireSyncLockWithRecovery({ trigger: 'manual', reflect: false })
  assert.equal(lock.ok, true, '应自愈成功')
  healedId = lock.id
  created.push(healedId)
  assert.ok(healedId > staleId, '应是一条全新的记录')
})

await t('那条卡死记录被标记为中断', async () => {
  const { rows } = await query(`SELECT * FROM sync_run WHERE id = $1`, [staleId])
  assert.equal(rows[0].active, false)
  assert.equal(rows[0].step, 'interrupted')
  assert.match(rows[0].message, /失去响应/)
})

await t('自愈时不覆盖内存状态（reflect:false）', async () => {
  assert.equal(getSyncState().running, false)
})

await t('释放后，陈旧 + PID 仍存活 → 不回收，老实返回 busy', async () => {
  await releaseSyncLock(healedId, { ok: true, message: 'ok', step: 'done', reflect: false })

  // 这次 PID 用「本测试进程」——它是活的，不该被当成卡死
  const { rows } = await query(
    `INSERT INTO sync_run (trigger, host, step, started_at, pid)
     VALUES ('manual', 'test-alive', 'import', now() - interval '60 minutes', $1)
     RETURNING id`,
    [process.pid]
  )
  const aliveId = Number(rows[0].id)
  created.push(aliveId)

  const lock = await acquireSyncLockWithRecovery({ trigger: 'manual', reflect: false })
  assert.equal(lock.ok, false)
  assert.equal(lock.reason, 'busy')

  // 那条记录必须原封不动
  const { rows: keep } = await query(`SELECT * FROM sync_run WHERE id = $1`, [aliveId])
  assert.equal(keep[0].active, true)
  assert.equal(keep[0].step, 'import')

  await releaseSyncLock(aliveId, { ok: false, message: '测试清理', step: 'interrupted', reflect: false })
})

await t('没记录 PID 的陈旧记录也会被回收', async () => {
  const { rows } = await query(
    `INSERT INTO sync_run (trigger, host, step, started_at, pid)
     VALUES ('manual', 'test-nopid', 'pull', now() - interval '60 minutes', NULL)
     RETURNING id`
  )
  const noPidId = Number(rows[0].id)
  created.push(noPidId)

  const lock = await acquireSyncLockWithRecovery({ trigger: 'manual', reflect: false })
  assert.equal(lock.ok, true)
  created.push(lock.id)
  const { rows: old } = await query(`SELECT active, step FROM sync_run WHERE id = $1`, [noPidId])
  assert.equal(old[0].active, false)
  assert.equal(old[0].step, 'interrupted')
  await releaseSyncLock(lock.id, { ok: true, message: 'ok', step: 'done', reflect: false })
})

console.log('\n=== E. 历史列表 ===')
await t('listSyncRuns 返回记录且字段完整', async () => {
  const runs = await listSyncRuns({ limit: 5 })
  assert.ok(runs.length >= 3)
  const r = runs[0]
  for (const k of ['id', 'trigger', 'startedAt', 'finishedAt', 'ok', 'step', 'message', 'elapsedMs']) {
    assert.ok(k in r, `缺少字段 ${k}`)
  }
  assert.equal(typeof r.id, 'number')
  assert.ok(r.elapsedMs === null || r.elapsedMs >= 0)
})

await t('listSyncRuns limit 被夹住（1..200）', async () => {
  assert.ok((await listSyncRuns({ limit: 99999 })).length <= 200)
  assert.equal((await listSyncRuns({ limit: 1 })).length, 1)
})

console.log('\n=== F. 孤儿进程回收：安全性 ===')
await t('没有 PID → 不动手', async () => {
  const r = await reapOrphan(null)
  assert.equal(r.reaped, false)
  assert.equal(r.reason, 'no-pid')
})

await t('PID 不存在 → 不动手', async () => {
  const r = await reapOrphan(999999)
  assert.equal(r.reaped, false)
  assert.equal(r.reason, 'gone')
})

await t('PID 存在但不是 sync.js（本测试进程）→ 只告警，绝不误杀', async () => {
  const r = await reapOrphan(process.pid)
  assert.equal(r.reaped, false)
  assert.equal(r.reason, 'unverified', `意外结果：${JSON.stringify(r)}`)
  // 证明验证链路真的读到了命令行（不是 PowerShell 失败导致的假阴性）
  assert.ok(r.cmdline && r.cmdline.length > 0, '没能读到命令行，回收功能实际不可用')
  assert.ok(/node/i.test(r.cmdline), `命令行里应有 node：${r.cmdline}`)
  // 本进程必须还活着
  assert.equal(process.kill(process.pid, 0), true)
})

// ---------------- 清理 ----------------
console.log('\n=== 清理 ===')
if (created.length) {
  const { rowCount } = await query(`DELETE FROM sync_run WHERE id = ANY($1::bigint[])`, [created])
  console.log(`  已删除测试产生的 ${rowCount} 条记录`)
}
const left = await query(`SELECT count(*)::int AS c FROM sync_run WHERE active`)
assert.equal(left.rows[0].c, 0, '清理后不应残留 active 记录')
console.log(`  剩余活跃记录：${left.rows[0].c}`)

console.log(`\n通过 ${passed} 项断言组${process.exitCode ? '（有失败）' : ''}\n`)
await pool.end()
