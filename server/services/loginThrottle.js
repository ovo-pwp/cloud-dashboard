/**
 * 登录限流：防止局域网内有人暴力破解密码
 *
 * 设计：
 *   - 直接以 login_log 表为数据源统计失败次数，**不引入额外状态**
 *     （天然跨进程、跨重启生效，也不怕后端重启后计数被清零）
 *   - 滑动窗口：只统计最近 N 分钟内的失败；窗口一过自动解锁
 *   - 主判据按来源 IP 计数（不按账号 —— 按账号会让攻击者「顺手锁死」正常用户）
 *   - 另有一道 **总闸**（所有来源累计失败上限，见 MAX_FAILS_TOTAL 的注释），
 *     因为启用 TRUST_PROXY 后转发头可被伪造，需要兜底
 *
 * 为什么必须要有它：
 *   密码是短口令，若允许无限次尝试，脚本几分钟就能穷举完。
 *   审计表原本只记录、不拦截，这里补上「拦截」那一步。
 *
 * 配置（.env）：
 *   LOGIN_MAX_FAILS=5                  窗口内允许的失败次数
 *   LOGIN_FAIL_WINDOW_MINUTES=15       统计窗口 / 锁定时长（分钟）
 */
import { query } from '../db/pool.js'

const MAX_FAILS = Math.max(1, Number(process.env.LOGIN_MAX_FAILS) || 5)
const WINDOW_MINUTES = Math.max(1, Number(process.env.LOGIN_FAIL_WINDOW_MINUTES) || 15)
/**
 * 总闸：窗口内**所有来源**的失败次数上限。
 *
 * 为什么要有：2026-10-10 起 TRUST_PROXY=true（公网走 Cloudflare Tunnel，
 * 不采信转发头的话所有公网访问都会被记成同一个 ::1）。
 * 采信转发头之后，局域网里有人可以随手伪造 X-Forwarded-For 来轮换"身份"，
 * 从而绕过按 IP 的单点限流 —— 这个总闸就是那道兜底：
 * 无论换多少 IP，整个窗口内累计失败到 MAX_FAILS_TOTAL 就一律拒绝。
 */
const MAX_FAILS_TOTAL = Math.max(MAX_FAILS, Number(process.env.LOGIN_MAX_FAILS_TOTAL) || 30)

export const THROTTLE = {
  maxFails: MAX_FAILS,
  windowMinutes: WINDOW_MINUTES,
  maxFailsTotal: MAX_FAILS_TOTAL,
}

/**
 * 计入限流的失败原因。
 * 「触发限流」本身不计入 —— 否则被拦的请求会不断把窗口续期，变成永久封禁。
 */
const COUNTED_REASONS = ['密码错误', '账号不存在']

/**
 * 查询某个 IP 当前的失败情况。
 * @returns {Promise<{blocked:boolean, failed:number, remaining:number, retryAfterSec:number}>}
 */
export async function checkThrottle(ip) {
  let failed = 0
  let oldest = null
  let totalFailed = 0

  try {
    const { rows } = await query(
      `SELECT COUNT(*) FILTER (WHERE ip = $2)::int    AS n,
              MIN(created_at) FILTER (WHERE ip = $2)  AS oldest,
              COUNT(*)::int                           AS total
         FROM login_log
        WHERE NOT success
          AND reason = ANY($1::text[])
          AND created_at > now() - ($3::int * INTERVAL '1 minute')`,
      [COUNTED_REASONS, ip, WINDOW_MINUTES]
    )
    failed = rows[0]?.n || 0
    oldest = rows[0]?.oldest || null
    totalFailed = rows[0]?.total || 0
  } catch (err) {
    // 审计表读不到时不能把所有人挡在门外，放行并告警
    console.warn('[login-throttle] 查询失败，本次放行：', err.message)
    return { blocked: false, failed: 0, remaining: MAX_FAILS, retryAfterSec: 0 }
  }

  // 总闸优先：整个窗口内所有来源累计失败太多，一律拒绝（防伪造转发头轮换身份）
  const hitTotal = totalFailed >= MAX_FAILS_TOTAL
  if (!hitTotal && failed < MAX_FAILS) {
    return {
      blocked: false,
      failed,
      remaining: MAX_FAILS - failed,
      retryAfterSec: 0,
    }
  }

  // 解锁时刻 = 窗口内最早那次失败 + 窗口长度
  let retryAfterSec = WINDOW_MINUTES * 60
  if (oldest) {
    const unlockAt = new Date(oldest).getTime() + WINDOW_MINUTES * 60_000
    retryAfterSec = Math.max(1, Math.ceil((unlockAt - Date.now()) / 1000))
  }
  if (!oldest && hitTotal) retryAfterSec = WINDOW_MINUTES * 60

  return {
    blocked: true,
    failed: hitTotal ? totalFailed : failed,
    remaining: 0,
    retryAfterSec,
    by: hitTotal && failed < MAX_FAILS ? 'total' : 'ip',
  }
}
