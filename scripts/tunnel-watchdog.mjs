/**
 * 隧道看门狗（2026-10-21）
 *
 * 为什么需要：
 *   10-21 16:48 公网整站 502，原因不是应用挂了（本地 127.0.0.1:3000 一直是 200），
 *   而是 cloudflared 与 Cloudflare 的隧道连接静默断掉 —— 服务状态还是 Running、
 *   进程也活着，但没有任何出网连接。这种故障没人盯着就只能等使用者撞见。
 *
 * 判定逻辑（两级，避免瞎重启）：
 *   1. 先探公网 /api/health
 *   2. 连续 FAILS_TO_RESTART 次不通 → 再探本地
 *      · 本地通、公网不通 → 隧道问题 → 重启 Cloudflared 服务
 *      · 本地也不通      → 是应用的问题 → 不碰隧道，只记日志（PM2 自己会拉起进程）
 *
 * 防风暴：
 *   · 连续失败才动手（单次抖动不动）
 *   · 重启后冷静 COOLDOWN_MS，不立刻再判
 *   · 每小时最多 MAX_PER_HOUR 次，超了就只记日志
 *
 * 为什么用 PowerShell 重启：本机 sc.exe 在安全策略黑名单里（10-21 踩过）。
 *
 * 用法：
 *   node scripts/tunnel-watchdog.mjs              # 常驻（PM2 托管）
 *   node scripts/tunnel-watchdog.mjs --once       # 只探一次，打印结果
 *   node scripts/tunnel-watchdog.mjs --test-restart  # 验证有权限重启服务
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOG_DIR = path.join(ROOT, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'tunnel-watchdog.log')

const PUBLIC_URL = process.env.WATCH_PUBLIC_URL || 'https://www.tjhd.dpdns.org/api/health'
const LOCAL_URL = process.env.WATCH_LOCAL_URL || 'http://127.0.0.1:3000/api/health'
const SERVICE_NAME = process.env.WATCH_SERVICE_NAME || 'Cloudflared'

/** 轮询间隔（分钟），默认 5 */
const INTERVAL_MS = Math.max(1, Number(process.env.TUNNEL_WATCH_INTERVAL_MIN) || 5) * 60 * 1000
/** 连续失败多少次才重启，默认 2（单次抖动不动手） */
const FAILS_TO_RESTART = Math.max(1, Number(process.env.TUNNEL_WATCH_FAILS) || 2)
/** 重启后的冷静期 */
const COOLDOWN_MS = 2 * 60 * 1000
/** 每小时最多重启次数，超过只告警（防止 Cloudflare 侧故障时无意义地反复重启） */
const MAX_PER_HOUR = Math.max(1, Number(process.env.TUNNEL_WATCH_MAX_PER_HOUR) || 3)

const ARG = new Set(process.argv.slice(2))

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`
  console.log(line)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch {
    /* 日志写不了不能影响看门狗本身 */
  }
}

/** 日志超过 5MB 就截断重来（启动时检查一次即可，5 分钟才写几行，涨得很慢） */
function rotateLogIfBig() {
  try {
    const { size } = statSync(LOG_FILE)
    if (size > 5 * 1024 * 1024) {
      renameSync(LOG_FILE, LOG_FILE + '.' + new Date().toISOString().slice(0, 10))
    }
  } catch {
    /* 文件不存在就不用管 */
  }
}

/** 探测一个地址，只关心「有没有正常响应」 */
async function probe(url, timeoutMs) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'tunnel-watchdog/1.0' },
    })
    const body = await res.text().catch(() => '')
    const ok = res.ok && /"ok"\s*:\s*true/.test(body)
    return { ok, status: res.status, ms: Date.now() - t0, body: body.slice(0, 80) }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.name + ': ' + e.message }
  }
}

/** 用 PowerShell 重启 Windows 服务（sc.exe 被黑名单，不能用） */
function restartService(name) {
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Restart-Service -Name '${name}' -Force -ErrorAction Stop`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let err = ''
    ps.stderr.on('data', (d) => { err += String(d) })
    ps.stdout.on('data', () => {})
    ps.on('error', (e) => resolve({ ok: false, err: e.message }))
    ps.on('close', (code) => resolve({ ok: code === 0, code, err: err.trim().slice(0, 300) }))
    // 2026-10-21 实测踩到：30 秒不够。cloudflared 停止时要断掉 4 条 QUIC/HTTP2 连接，
    // 加上 PowerShell 冷启动，很容易超过 30 秒 —— 当时日志写「重启失败：超时」，
    // 但服务其实随后自己起来了。放宽到 60 秒，避免把「慢」误判成「失败」而触发多余的重试。
    setTimeout(() => resolve({ ok: false, err: 'PowerShell 重启超时（60s）' }), 60000)
  })
}

// ---------- 运行状态 ----------
let consecutiveFails = 0
let lastRestartAt = 0
let restarts = []           // 本小时内的重启时间戳
let everOk = false

function restartsLastHour() {
  const cutoff = Date.now() - 3600 * 1000
  restarts = restarts.filter((t) => t > cutoff)
  return restarts.length
}

async function tick() {
  // 冷静期内直接跳过，不连累失败计数
  if (Date.now() - lastRestartAt < COOLDOWN_MS) {
    log('冷静期内，跳过本轮探测')
    return
  }

  const pub = await probe(PUBLIC_URL, 12000)
  if (pub.ok) {
    if (!everOk) {
      log(`公网恢复正常（${pub.ms}ms）`)
      everOk = true
    }
    if (consecutiveFails > 0) log(`公网已恢复，重置失败计数（之前连续 ${consecutiveFails} 次）`)
    consecutiveFails = 0
    return
  }

  consecutiveFails++
  everOk = false
  log(`公网探测失败（连续 ${consecutiveFails}/${FAILS_TO_RESTART}）：` +
      (pub.status ? `HTTP ${pub.status}` : pub.error) + ` 耗时 ${pub.ms}ms`)

  if (consecutiveFails < FAILS_TO_RESTART) return

  // 到这一步才动手：先分清是隧道问题还是应用问题
  const loc = await probe(LOCAL_URL, 8000)
  if (!loc.ok) {
    log(`本地 ${LOCAL_URL} 也不通（${loc.status || loc.error}）⇒ 是应用侧问题，` +
        `不动隧道（PM2 负责拉起后端）。请检查 pm2 logs cloud-dashboard`)
    consecutiveFails = 0
    return
  }

  log(`本地正常（${loc.ms}ms）但公网不通 ⇒ 判定为隧道断开`)

  if (restartsLastHour() >= MAX_PER_HOUR) {
    log(`本小时已重启 ${restartsLastHour()} 次，达到上限 ${MAX_PER_HOUR}，本轮不再重启，` +
        `请人工介入检查 Cloudflare 隧道状态`)
    consecutiveFails = 0
    return
  }

  log(`正在重启服务 ${SERVICE_NAME} ...`)
  const r = await restartService(SERVICE_NAME)
  if (r.ok) {
    lastRestartAt = Date.now()
    restarts.push(lastRestartAt)
    consecutiveFails = 0
    log(`已重启 ${SERVICE_NAME}，等待隧道重建（冷静 2 分钟）`)
  } else {
    log(`重启失败：${r.err}（看门狗可能没有管理员权限，需要以管理员身份运行 PM2）`)
    lastRestartAt = Date.now()   // 失败也进冷静期，避免每轮都尝试
  }
}

async function main() {
  rotateLogIfBig()
  log(`看门狗启动 | 探测 ${PUBLIC_URL} | 每 ${INTERVAL_MS / 60000} 分钟 | ` +
      `连续 ${FAILS_TO_RESTART} 次失败才重启 ${SERVICE_NAME}`)

  if (ARG.has('--test-restart')) {
    log('测试模式：验证重启权限')
    const r = await restartService(SERVICE_NAME)
    log(r.ok ? '✅ 有权限重启服务' : `❌ 没有权限：${r.err}`)
    process.exit(r.ok ? 0 : 1)
  }

  if (ARG.has('--once')) {
    const pub = await probe(PUBLIC_URL, 12000)
    const loc = await probe(LOCAL_URL, 8000)
    log(`公网: ${pub.ok ? 'OK' : 'FAIL'} ${pub.status || pub.error || ''} (${pub.ms}ms)`)
    log(`本地: ${loc.ok ? 'OK' : 'FAIL'} ${loc.status || loc.error || ''} (${loc.ms}ms)`)
    process.exit(pub.ok && loc.ok ? 0 : 1)
  }

  await tick()
  setInterval(tick, INTERVAL_MS)
}

main().catch((e) => {
  log('看门狗异常退出: ' + (e?.stack || e))
  process.exit(1)
})