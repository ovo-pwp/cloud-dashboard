/**
 * 同步执行器：从金山文档抓取最新数据 → 导入 PostgreSQL
 *
 * 设计要点：
 *   1. 单例运行 —— 互斥锁分两层：
 *        · 内存态 state.running：快路径，省一次数据库往返
 *        · 数据库 sync_run 的「唯一部分索引」：真正的锁，进程重启也不会丢
 *      （避免两次点击同时写库，出现重复批次或互相覆盖）
 *   2. 状态持久化 —— 每次同步写一行 sync_run，进度/结果/日志落库，
 *      后端重启后前端仍能看到「上次同步跑了什么、结果如何」
 *   3. 孤儿回收 —— 同步中途后端被杀，子进程可能变成孤儿继续写库；
 *      下次启动会校验该 PID 的命令行确实是本项目的 sync.js，再终止它
 *   4. 后台执行 —— spawn 子进程而非阻塞 Express 事件循环
 *
 * 用完即弃的子进程，不是常驻服务：每次点击都新起一个 node sync.js。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, pool } from '../db/pool.js'
import { resolveExecutable } from '../utils/executable.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
// 同步脚本可覆盖（SYNC_SCRIPT_PATH，相对项目根目录）：便于用桩脚本做端到端测试
const SYNC_SCRIPT = path.resolve(PROJECT_ROOT, process.env.SYNC_SCRIPT_PATH || 'sync.js')
const LOG_PATH = path.join(PROJECT_ROOT, 'server', 'logs', 'sync.log')

// 依赖路径（与 sync.js 保持一致，用于前置校验，给出更友好的报错）
// 注意：容器化部署时 PYTHON_PATH 可能是 `python3` 这种「命令名」而非绝对路径，
// 所以不能用 fs.existsSync 直接判断，要走 resolveExecutable 到 PATH 里找。
const PY =
  process.env.PYTHON_PATH ||
  'C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe'
// ⚠ 取数脚本全项目只有这一份（桌面 `看板模板\kdocs_pull.py`），这是唯一的权威副本。
//   2026-09-29 删除了 `deploy/kdocs/kdocs_pull.py`：那份是旧副本，缺一条业务规则
//   （「备注含『无效订单』的行不计入已发货未开票看板」），一旦被误用会让看板凭空多出
//   2 条单 / 25,476.86 元且不报任何错。旧副本已备份到 `.backup/20260929-1830/`。
//   要改取数逻辑，改桌面那份；不要在这里或 deploy/ 下再复制一份。
const KDOCS_PULL =
  process.env.KDOCS_PULL_SCRIPT || 'C:/Users/Administrator/Desktop/看板模板/kdocs_pull.py'

const MAX_LOG_LINES = 400

/** 日志写库的节流间隔：崩溃也能留下大致完整的日志 */
const FLUSH_INTERVAL_MS = 10_000

/** 是否自动回收孤儿同步进程（默认开）。设为 false 则只告警不终止 */
const REAP_ORPHAN = String(process.env.SYNC_REAP_ORPHAN ?? 'true').toLowerCase() !== 'false'

/**
 * 「卡住的锁」判定阈值（分钟）。
 * 只在「重启后仍残留 active 记录」这种异常场景下用到：
 * 超出阈值且记录的 PID 已不存在，才允许回收这条锁。
 */
const STALE_AFTER_MINUTES = Math.max(1, Number(process.env.SYNC_STALE_AFTER_MINUTES) || 20)

const TRIGGER_LABEL = {
  manual: '网页端手动',
  scheduler: '定时轮询',
}

/** 当前任务状态（内存镜像；真实来源是 sync_run 表，重启时由 initSyncState 回填） */
let state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  ok: null,
  message: '',
  step: 'idle',
  log: [],
  sources: null, // 上一次同步结束后的数据源快照
  runId: null,
  trigger: null,
  host: null,
}

function pushLog(line) {
  const text = String(line).replace(/\r$/, '')
  if (!text.trim()) return
  state.log.push(text)
  if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES)
  console.log(`[sync] ${text}`)
}

/** 从日志里粗略推断当前进度，给前端做步骤显示 */
function inferStep(line) {
  if (/\[1\/2\]/.test(line)) return 'pull'
  if (/\[2\/2\]/.test(line)) return 'import'
  if (/全部完成/.test(line)) return 'done'
  return state.step
}

/** 前置检查：脚本和 Python 是否都就位 */
function preflight() {
  const missing = []
  if (!fs.existsSync(SYNC_SCRIPT)) missing.push(`同步脚本：${SYNC_SCRIPT}`)
  if (!fs.existsSync(KDOCS_PULL)) missing.push(`抓取脚本：${KDOCS_PULL}`)
  if (!resolveExecutable(PY)) missing.push(`Python 解释器：${PY}`)
  return missing
}

/** 写一份日志到文件，便于事后排查 */
function appendFileLog(lines) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    const head = `\n===== ${new Date().toISOString()} 同步任务 =====\n`
    fs.appendFileSync(LOG_PATH, head + lines.join('\n') + '\n', 'utf8')
  } catch {
    /* 写日志失败不影响主流程 */
  }
}

// ------------------------------------------------------------
// 持久化：sync_run 表读写
// ------------------------------------------------------------

/** 把数据库行转成内存 state（sources 保留内存里的快照，表里不存） */
function rowToState(row) {
  return {
    running: !!row.active,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    ok: row.ok,
    message: row.message || '',
    step: row.step || 'idle',
    log: row.log ? String(row.log).split('\n').filter((l) => l.trim()) : [],
    sources: state.sources,
    runId: Number(row.id),
    trigger: row.trigger || null,
    host: row.host || null,
    // 标记「这是从数据库恢复来的历史状态」，前端可据此区分本次启动内的实时状态
    persistedAtBoot: !row.active,
  }
}

/** 查询当前「仍在执行」的同步记录（唯一索引保证至多一条） */
async function findActiveRun() {
  const { rows } = await query(
    `SELECT * FROM sync_run WHERE active ORDER BY id LIMIT 1`
  )
  return rows[0] || null
}

/**
 * 申请同步锁。
 * 靠 sync_run 的唯一部分索引做原子互斥：并发时只有一条 INSERT 能成功。
 *
 * @param {object} [opts]
 * @param {string} [opts.trigger] 'manual'（网页按钮）| 'scheduler'（定时轮询）
 * @param {boolean} [opts.reflect] 是否同步更新内存状态供前端轮询（默认是）
 * @returns {Promise<{ok: true, id: number, startedAt: string} | {ok: false, reason: 'busy'}>}
 */
export async function acquireSyncLock({ trigger = 'manual', reflect = true } = {}) {
  let inserted
  try {
    // 这里故意不用 query() 包装：唯一冲突是「锁生效」的正常结果，不该刷成查询失败
    const { rows } = await pool.query(
      `INSERT INTO sync_run (trigger, host) VALUES ($1, $2)
       RETURNING id, started_at`,
      [trigger, os.hostname().slice(0, 64)]
    )
    inserted = rows[0]
  } catch (err) {
    // 23505 = unique_violation：已有别的同步在跑
    if (err.code === '23505') return { ok: false, reason: 'busy' }
    throw err
  }

  const startedAt = new Date(inserted.started_at).toISOString()
  if (reflect) {
    state = {
      running: true,
      startedAt,
      finishedAt: null,
      ok: null,
      message: trigger === 'scheduler' ? '定时轮询正在同步…' : '正在同步…',
      step: 'pull',
      log: [],
      sources: state.sources,
      runId: Number(inserted.id),
      trigger,
      host: os.hostname(),
    }
  }
  return { ok: true, id: Number(inserted.id), startedAt }
}

/**
 * 释放同步锁并写入最终结果。
 * @param {boolean} [opts.reflect] 是否把结果同步回内存状态（默认是，仅当 runId 匹配时生效）
 */
export async function releaseSyncLock(
  id,
  { ok, message, step = 'done', log = null, reflect = true } = {}
) {
  if (!id) return
  try {
    await query(
      `UPDATE sync_run
          SET active = FALSE,
              finished_at = now(),
              ok = $2,
              message = $3,
              step = $4,
              log = COALESCE($5, log)
        WHERE id = $1`,
      [id, ok ?? null, message ?? null, step, log]
    )
  } catch (err) {
    console.error('[sync] 写入同步结果失败:', err.message)
  }

  if (reflect && state.runId === id) {
    state = {
      ...state,
      running: false,
      ok: ok ?? null,
      message: message ?? state.message,
      step,
      finishedAt: new Date().toISOString(),
    }
  }
}

/** 执行中定期刷进度与日志（崩溃也能留痕） */
async function flushRun(id, { step, log }) {
  if (!id) return
  try {
    await query(`UPDATE sync_run SET step = $2, log = $3 WHERE id = $1`, [id, step, log])
  } catch {
    /* 刷进度失败不影响同步本身 */
  }
}

/** 判断 PID 是否还活着（EPERM 说明存在但无权限，也算活着） */
function isPidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

const IS_WIN = process.platform === 'win32'

/**
 * 取某个进程的命令行（用于确认它确实是本项目的 sync.js）。
 *
 * 平台差异：Windows 走 PowerShell/CIM，Linux 直接读 /proc。
 * 容器化部署（Linux）跑的是 /proc 分支 —— 早期只有 PowerShell 分支，
 * 在 Linux 上 spawn 必然 ENOENT，退化成「永远校验不过、永不回收」，
 * 于是 SYNC_REAP_ORPHAN=true 形同虚设。
 */
function readCommandLine(pid) {
  if (!IS_WIN) {
    try {
      // /proc/<pid>/cmdline 以 NUL 分隔各参数，换成空格即可比对
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      return Promise.resolve(raw.replace(/\0/g, ' ').trim())
    } catch {
      // 进程已退出或无权限：返回空串 → 上层按「无法确认」处理，不会误杀
      return Promise.resolve('')
    }
  }

  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ],
      { windowsHide: true }
    )
    let out = ''
    const done = (v) => {
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      try { ps.kill() } catch { /* ignore */ }
      done('')
    }, 5000)
    ps.stdout.on('data', (b) => { out += b })
    ps.on('error', () => done(''))
    ps.on('close', () => done(out.trim()))
  })
}

/** 终止进程树（含其下的 python 子进程） */
function killTree(pid) {
  if (!IS_WIN) {
    // 子进程是以 detached 方式起的，自成进程组（组长 PID = 子进程 PID），
    // 对 -pid 发信号即可整组终止，连带 sync.js 里再 fork 的 python。
    try {
      process.kill(-pid, 'SIGKILL')
      return Promise.resolve({ ok: true, detail: `已终止进程组 ${pid}` })
    } catch {
      /* 可能不是组长（老版本遗留进程），退回单进程终止 */
    }
    try {
      process.kill(pid, 'SIGKILL')
      return Promise.resolve({ ok: true, detail: `已终止进程 ${pid}` })
    } catch (e) {
      return Promise.resolve({ ok: false, detail: e.message })
    }
  }

  return new Promise((resolve) => {
    const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    let out = ''
    tk.stdout.on('data', (b) => { out += b })
    tk.stderr.on('data', (b) => { out += b })
    tk.on('error', () => resolve({ ok: false, detail: 'taskkill 启动失败' }))
    tk.on('close', (code) => resolve({ ok: code === 0, detail: out.trim() }))
  })
}

/**
 * 回收孤儿同步进程。
 * 只在前一次同步被打断、且该 PID 的命令行确实指向本项目的 sync.js 时才终止，
 * 避免 PID 被复用后误杀无关进程。
 */
export async function reapOrphan(pid) {
  if (!REAP_ORPHAN) return { reaped: false, reason: 'disabled' }
  if (!pid) return { reaped: false, reason: 'no-pid' }
  if (!isPidAlive(pid)) return { reaped: false, reason: 'gone' }

  const cmdline = await readCommandLine(pid)
  const want = SYNC_SCRIPT.replace(/\\/g, '/').toLowerCase()
  if (!cmdline || !cmdline.replace(/\\/g, '/').toLowerCase().includes(want)) {
    // 命令行拿不到，或不是我们的脚本 —— 宁可不杀，交给人工确认
    return { reaped: false, reason: 'unverified', cmdline }
  }

  const res = await killTree(pid)
  return { reaped: res.ok, pid, detail: res.detail }
}

/**
 * 把一条「仍在执行」的记录判定为「被中断」并回收其孤儿进程。
 * @returns {{id:number, message:string, reap:object}|null}
 */
async function reconcileActiveRun({ reason, row, reflect = true }) {
  const target = row || (await findActiveRun())
  if (!target) return null

  // pg 会把 BIGSERIAL 读成字符串，统一转成数字，才能和内存里的 runId 对上
  const runId = Number(target.id)
  const message = `同步任务未跑完（${reason}），已标记为中断`
  await releaseSyncLock(runId, { ok: false, message, step: 'interrupted', reflect })

  const reap = await reapOrphan(target.pid)
  console.log(
    reap.reaped
      ? `[sync] 已终止孤儿同步进程 PID=${reap.pid}`
      : `[sync] 孤儿进程处理：${
          { disabled: '自动回收已关闭', 'no-pid': '未记录 PID', gone: '进程已不在', unverified: '无法确认为本项目的 sync.js，未终止' }[reap.reason] ||
          reap.reason
        }${reap.cmdline ? `（实际命令行：${reap.cmdline.slice(0, 120)}）` : ''}`
  )
  return { id: runId, message, reap }
}

/**
 * 后端启动时调用：从数据库回填同步状态。
 * 这是「状态持久化」的入口 —— 重启后前端仍能看到上次同步的结果。
 * @returns {Promise<{ok: boolean, recovered?: object, error?: string}>}
 */
export async function initSyncState() {
  try {
    const { rows } = await query(`SELECT * FROM sync_run ORDER BY id DESC LIMIT 1`)
    if (rows.length) {
      state = rowToState(rows[0])

      // 上一进程留下的「仍在执行」：本进程不可能有同步在跑，判定为中断
      if (rows[0].active) {
        await reconcileActiveRun({ reason: '后端服务重启', row: rows[0] })
        state.persistedAtBoot = false
      } else if (state.message) {
        console.log(
          `[sync] 已恢复上次同步状态（#${state.runId} ${TRIGGER_LABEL[state.trigger] || state.trigger || 'manual'}｜${
            state.ok ? '成功' : '未完全成功'
          }｜${state.finishedAt || '未记录时间'}）`
        )
      }
    }

    // 顺手把数据源快照填上，系统管理页刷新即有内容
    try {
      state.sources = await collectSources()
    } catch {
      /* 拿不到就算了，前端会自己再拉 */
    }
    return { ok: true, runId: state.runId, interrupted: state.step === 'interrupted' }
  } catch (err) {
    console.error('[sync] 恢复同步状态失败（不影响服务启动）:', err.message)
    return { ok: false, error: err.message }
  }
}

/**
 * 各数据源的最新快照，供「系统管理」页展示。
 *
 * 注意两个坑：
 *   1. snapshot_date 是 DATE 类型，pg 会读成「本地零点」的 Date 对象，
 *      再走 toISOString() 在东八区会倒退一天 → 必须用 to_char 直接取字符串。
 *   2. 客户平台表每次同步追加一个快照，统计必须限定在最新快照上，否则行数会翻倍。
 */
export async function collectSources() {
  const { rows: batches } = await query(
    `SELECT biz_type,
            to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date,
            imported_at, row_count, total_amount
       FROM import_batch
      WHERE (biz_type, id) IN (
            SELECT biz_type, MAX(id) FROM import_batch
            GROUP BY biz_type)
      ORDER BY biz_type`
  )
  const sources = batches.map((b) => ({
    key: b.biz_type,
    label: b.biz_type === 'billed_unpaid' ? '已开票未回款' : '已发货未开票',
    snapshotDate: b.snapshot_date,
    importedAt: b.imported_at,
    rows: Number(b.row_count),
    totalAmount: Number(b.total_amount),
  }))

  // 金额口径与看板保持一致：用 sales_amount（销售金额），
  // 不用 sales_amount_total（销售金额合计 = 导单销售金额，大 3 倍）。
  // 见 server/routes/receivable.js 里 CPU_AMOUNT_COL 的说明。
  const cp = await query(
    `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS d,
            COUNT(*)::int AS cnt,
            COALESCE(SUM(sales_amount), 0) AS total
       FROM customer_platform_unpaid
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM customer_platform_unpaid)
      GROUP BY snapshot_date`
  )
  if (cp.rows[0]) {
    sources.push({
      key: 'customer_platform_unpaid',
      label: '客户平台未回款',
      snapshotDate: cp.rows[0].d,
      importedAt: null,
      rows: Number(cp.rows[0].cnt),
      totalAmount: Number(cp.rows[0].total),
    })
  }
  return sources
}

/** 读取当前状态（不含日志时可裁剪） */
export function getSyncState({ withLog = true } = {}) {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    ok: state.ok,
    message: state.message,
    step: state.step,
    elapsedMs: state.startedAt
      ? (state.finishedAt ? new Date(state.finishedAt) : new Date()) - new Date(state.startedAt)
      : 0,
    log: withLog ? state.log.slice(-120) : [],
    sources: state.sources || null,
    // 持久化后新增的字段（前端可选使用）
    runId: state.runId,
    trigger: state.trigger,
    triggerLabel: state.trigger ? TRIGGER_LABEL[state.trigger] || state.trigger : null,
    host: state.host,
    interrupted: state.step === 'interrupted',
    persistedAtBoot: state.persistedAtBoot || false,
  }
}

/** 供定时轮询等其他入口复用：把日志推给前端轮询 */
export function pushSyncLog(line) {
  pushLog(line)
}

/**
 * 同步历史（最近 N 次），用于「系统管理」页展示，重启后仍在。
 */
export async function listSyncRuns({ limit = 20 } = {}) {
  const n = Math.min(200, Math.max(1, Number(limit) || 20))
  const { rows } = await query(
    `SELECT id, trigger, active, started_at, finished_at, ok, step, message, host,
            CASE WHEN finished_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000
                 ELSE NULL END AS elapsed_ms,
            CASE WHEN log IS NULL OR log = '' THEN 0
                 ELSE array_length(string_to_array(log, E'\n'), 1) END AS log_lines
       FROM sync_run
      ORDER BY id DESC
      LIMIT $1`,
    [n]
  )
  return rows.map((r) => ({
    id: Number(r.id),
    trigger: r.trigger,
    triggerLabel: TRIGGER_LABEL[r.trigger] || r.trigger,
    active: r.active,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    ok: r.ok,
    step: r.step,
    message: r.message,
    host: r.host,
    elapsedMs: r.elapsed_ms === null ? null : Math.round(Number(r.elapsed_ms)),
    logLines: Number(r.log_lines || 0),
  }))
}

/**
 * 抢锁，并在遇到「卡死的锁」时自愈一次。
 *
 * 卡死判定同时满足两条才回收，避免误伤真正在跑的任务：
 *   1. 起始时间已超过 SYNC_STALE_AFTER_MINUTES（默认 20 分钟）
 *   2. 记录的 PID 已不存在（或没记录 PID）
 *
 * @returns {Promise<{ok: true, id: number, startedAt: string} | {ok: false, reason: 'busy'}>}
 */
export async function acquireSyncLockWithRecovery({ trigger = 'manual', reflect = true } = {}) {
  let lock = await acquireSyncLock({ trigger, reflect })
  if (lock.ok) return lock

  const active = await findActiveRun().catch(() => null)
  if (!active) return lock // 读不到活跃记录：可能是刚被释放，交给调用方重试

  const ageMin = (Date.now() - new Date(active.started_at).getTime()) / 60000
  if (ageMin > STALE_AFTER_MINUTES && !isPidAlive(active.pid)) {
    console.warn(
      `[sync] 发现卡死的同步锁 #${active.id}（已 ${Math.round(ageMin)} 分钟，PID ${
        active.pid || '未记录'
      } 不存在），自动回收`
    )
    // reflect:false —— 这条是历史遗留，不该覆盖内存里当前的状态
    await reconcileActiveRun({ reason: '历史任务已失去响应', row: active, reflect: false })
    lock = await acquireSyncLock({ trigger, reflect })
  }
  return lock
}

/**
 * 启动一次同步。
 *
 * 「谁在跑」的最终裁决权在数据库：内存 state 只是快路径。
 * 数据库层面的锁不会随进程重启消失，所以不会出现两个进程同时写库。
 *
 * @returns {Promise<{started: boolean, reason?: string, missing?: string[]}>}
 */
export async function startSync({ trigger = 'manual' } = {}) {
  if (state.running) {
    return { started: false, reason: 'busy' }
  }

  const missing = preflight()
  if (missing.length) {
    state = {
      ...state,
      ok: false,
      message: `环境检查未通过，缺少：${missing.join('；')}`,
      step: 'error',
    }
    return { started: false, reason: 'preflight', missing }
  }

  const lock = await acquireSyncLockWithRecovery({ trigger })
  if (!lock.ok) return { started: false, reason: 'busy' }

  // 锁已经拿到，内存状态也已由 acquireSyncLock 置为「运行中」
  pushLog(`收到同步请求（${TRIGGER_LABEL[trigger] || trigger}），开始执行…`)

  const child = spawn(process.execPath, [SYNC_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    windowsHide: true,
    // POSIX 下让子进程自成进程组（组长 PID = 子进程 PID），
    // 这样回收孤儿时能 process.kill(-pid) 整组干掉，不会漏掉它 fork 的 python。
    // Windows 不需要：那边用 taskkill /T 递归整棵树。
    detached: !IS_WIN,
  })

  // 记下子进程 PID，供「后端被杀」后下次启动回收
  if (child.pid) {
    await query(`UPDATE sync_run SET pid = $2 WHERE id = $1`, [lock.id, child.pid]).catch(
      () => {}
    )
  }

  const pending = []
  const onData = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line.trim()) continue
      pushLog(line)
      state.step = inferStep(line)
      pending.push(line)
    }
  }

  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  // 定期把进度和日志写库：中途崩溃也能留下线索
  const flushTimer = setInterval(() => {
    flushRun(lock.id, { step: state.step, log: state.log.join('\n') })
  }, FLUSH_INTERVAL_MS)

  // spawn 失败时 error 与 close 可能先后都触发，用 settled 保证只收尾一次
  let settled = false
  const finish = async ({ code, message, step }) => {
    if (settled) return
    settled = true
    clearInterval(flushTimer)
    state.running = false
    state.ok = code === 0
    state.step = step
    state.finishedAt = new Date().toISOString()
    state.message = message

    pushLog(`— ${message}`)
    appendFileLog(pending)

    await releaseSyncLock(lock.id, {
      ok: state.ok,
      message,
      step,
      log: state.log.join('\n'),
    })

    // 成功与否都尝试刷新快照，失败时前端仍能看到库里当前真实状态
    try {
      state.sources = await collectSources()
    } catch (err) {
      pushLog(`刷新数据源快照失败：${err.message}`)
    }
  }

  child.on('error', (err) => {
    finish({
      code: null,
      step: 'error',
      message: `同步进程启动失败：${err.message}`,
    })
  })

  child.on('close', (code) => {
    // sync.js 退出码：0=全成功，1=云端抓取失败，2=抓取成功但部分文件入库失败
    finish({
      code,
      step: code === 0 ? 'done' : 'error',
      message:
        code === 0
          ? '同步完成，看板已是最新数据'
          : code === 1
            ? '同步未完全成功：云端抓取失败（可能凭证失效或网络不通），已用本地已有文件入库'
            : code === 2
              ? '同步未完全成功：数据已抓到，但部分文件入库失败，请查看下方日志'
              : `同步异常退出（退出码 ${code}）`,
    })
  })

  return { started: true }
}
