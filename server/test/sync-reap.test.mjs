/**
 * 回归测试：孤儿同步进程的「确认 + 终止」真的会动手
 *
 *   npm run test:sync:reap
 *
 * 背景：后端同步中途被杀，子进程可能变成孤儿继续写库。
 * 后端启动时会按 sync_run.pid 回收，但必须先用命令行确认「那确实是本项目的 sync.js」。
 *
 * 本机终端会连整棵进程树一起回收，造不出真正的孤儿，所以换个等价办法：
 * 本脚本自己拉一个「命令行与 SYNC_SCRIPT 完全一致」的活进程，再交给 reapOrphan
 * —— 这正是后端启动时走的那段逻辑。
 */
import 'dotenv/config'

// 必须在导入 syncRunner 之前设置：这两个值在模块加载时读取
process.env.SYNC_SCRIPT_PATH = 'server/test/stub-sync.mjs'
process.env.SYNC_REAP_ORPHAN = 'true'

import assert from 'node:assert/strict'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pool } from '../db/pool.js'
const { reapOrphan } = await import('../services/syncRunner.js')

const STUB = path.resolve('server/test/stub-sync.mjs')
let passed = 0
let failed = 0

async function t(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✔ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✖ ${name}\n      ${err.message}`)
  }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
const waitExit = (child, ms) =>
  Promise.race([
    new Promise((r) => child.on('close', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ])

console.log('\n=== 回收一个命令行匹配的活进程 ===')
let child
await t('拉起一个与 SYNC_SCRIPT 命令行一致的进程（停留 2 分钟）', async () => {
  child = spawn(process.execPath, [STUB], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, STUB_SLEEP_MS: '120000', STUB_QUIET: '1' },
  })
  await new Promise((r) => setTimeout(r, 1000))
  assert.ok(child.pid, '进程没起来')
  assert.equal(isAlive(child.pid), true, '拉起后应处于存活状态')
  console.log(`      （被测进程 PID=${child.pid}）`)
})

await t('reapOrphan 确认它就是同步脚本，并终止它', async () => {
  const res = await reapOrphan(child.pid)
  assert.equal(res.reaped, true, `未回收：${JSON.stringify(res)}`)
  assert.equal(res.pid, child.pid)
})

await t('该进程确实已经消失', async () => {
  assert.equal(await waitExit(child, 5000), true, '进程没有退出')
  assert.equal(isAlive(child.pid), false, '进程仍然存活')
})

await t('对已消失的 PID 再调一次 → gone（幂等）', async () => {
  const res = await reapOrphan(child.pid)
  assert.equal(res.reaped, false)
  assert.equal(res.reason, 'gone')
})

console.log('\n=== 关闭自动回收时的行为 ===')
await t('SYNC_REAP_ORPHAN=false → 拒绝动手', async () => {
  // REAP_ORPHAN 在模块加载时读取，所以换个进程验证
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `process.env.SYNC_REAP_ORPHAN='false';
       const { reapOrphan } = await import('./server/services/syncRunner.js');
       console.log(JSON.stringify(await reapOrphan(process.pid)));`,
    ],
    { encoding: 'utf8', cwd: process.cwd() }
  )
  const line = (r.stdout || '').trim().split('\n').pop()
  const res = JSON.parse(line)
  assert.equal(res.reaped, false)
  assert.equal(res.reason, 'disabled')
})

console.log(`\n通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}\n`)
await pool.end()
process.exit(failed ? 1 : 0)
