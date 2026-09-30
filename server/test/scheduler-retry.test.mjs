/**
 * 定时调度器「失败重试」的单元测试。
 *
 * 为什么专门测这个：调度逻辑写错的后果是**静默且持续**的 ——
 * 比如失败后不回退会一直被 2 分钟重试刷屏、被锁跳过也跟着重试会跟手动同步打架。
 * 这类问题不会报错，只能靠断言守着。
 *
 * 只测纯函数 computeNextDelay（不启动真调度器、不连库、不起子进程）。
 * 跑法：npm run test:scheduler
 */
import 'dotenv/config'
import assert from 'node:assert/strict'

const { computeNextDelay } = await import('../scheduler.js')

const MIN = 60 * 1000
const INTERVAL = 60 * MIN              // 与 .env KDOCS_SCHEDULER_INTERVAL_MIN=60 一致
const RETRIES = [2 * MIN, 5 * MIN, 15 * MIN]

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✔ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✖ ${name}\n      ${e.message.split('\n')[0]}`)
  }
}

console.log('\n=== 调度器失败重试 ===')

t('成功 → 回到正常周期，重试计数归零', () => {
  const r = computeNextDelay('ok', 0, INTERVAL, RETRIES)
  assert.equal(r.delayMs, INTERVAL)
  assert.equal(r.nextRetryIdx, 0)
})

t('重试过程中成功 → 也回正常周期并清零', () => {
  const r = computeNextDelay('ok', 2, INTERVAL, RETRIES)
  assert.equal(r.delayMs, INTERVAL)
  assert.equal(r.nextRetryIdx, 0, '成功后必须清零，否则下次失败会从第 3 次起算')
})

t('被同步锁跳过 → 回正常周期，且不计入重试', () => {
  const r = computeNextDelay('skipped', 0, INTERVAL, RETRIES)
  assert.equal(r.delayMs, INTERVAL, '被锁挡住说明另一路在跑，跟着重试会打架')
  assert.equal(r.nextRetryIdx, 0)
})

t('失败第 1 次 → 2 分钟后重试', () => {
  const r = computeNextDelay('failed', 0, INTERVAL, RETRIES)
  assert.equal(r.delayMs, 2 * MIN)
  assert.equal(r.nextRetryIdx, 1)
})

t('失败第 2 次 → 5 分钟后重试', () => {
  const r = computeNextDelay('failed', 1, INTERVAL, RETRIES)
  assert.equal(r.delayMs, 5 * MIN)
  assert.equal(r.nextRetryIdx, 2)
})

t('失败第 3 次 → 15 分钟后重试', () => {
  const r = computeNextDelay('failed', 2, INTERVAL, RETRIES)
  assert.equal(r.delayMs, 15 * MIN)
  assert.equal(r.nextRetryIdx, 3)
})

t('重试用尽 → 回正常周期并清零（不会无限 2 分钟重试）', () => {
  const r = computeNextDelay('failed', 3, INTERVAL, RETRIES)
  assert.equal(r.delayMs, INTERVAL)
  assert.equal(r.nextRetryIdx, 0, '必须清零，否则会一直卡在「重试用尽」分支')
})

t('连续失败的完整序列符合预期', () => {
  const seq = []
  let idx = 0
  for (const res of ['failed', 'failed', 'failed', 'failed', 'ok']) {
    const r = computeNextDelay(res, idx, INTERVAL, RETRIES)
    seq.push(r.delayMs / MIN)
    idx = r.nextRetryIdx
  }
  assert.deepEqual(seq, [2, 5, 15, 60, 60], `实际: ${seq.join(', ')}`)
})

t('重试间隔严格递增（短间隔重试的意义就在于此）', () => {
  for (let i = 1; i < RETRIES.length; i++) {
    assert.ok(RETRIES[i] > RETRIES[i - 1], `第 ${i} 个间隔不比前一个大`)
  }
  assert.ok(RETRIES[0] < INTERVAL, '首次重试必须比正常周期短，否则重试没意义')
})

t('间隔都换算成分钟可读（防毫秒/分钟单位写混）', () => {
  const r = computeNextDelay('failed', 0, INTERVAL, RETRIES)
  assert.equal(Math.round(r.delayMs / 60000), 2)
})

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`)
// 显式退出：scheduler.js 会 import db/pool.js，连接池会让进程不自动结束
process.exit(fail ? 1 : 0)
