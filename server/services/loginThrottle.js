/**
 * 登录限流：防止局域网内有人暴力破解密码
 *
 * 设计：
 *   - 直接以 login_log 表为数据源统计失败次数，**不引入额外状态**
 *     （天然跨进程、跨重启生效，也不怕后端重启后计数被清零）
 *   - 滑动窗口：只统计最近 N 分钟内的失败；窗口一过自动解锁
 *   - 仅按来源 IP 计数，不按账号计数 —— 按账号会让攻击者「顺手锁死」正常用户
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

export const THROTTLE = {
  maxFails: MAX_FAILS,
  windowMinutes: WINDOW_MINUTES,
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

  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n,
              MIN(created_at) AS oldest
         FROM login_log
        WHERE NOT success
          AND reason = ANY($1::text[])
          AND ip = $2
          AND created_at > now() - ($3::int * INTERVAL '1 minute')`,
      [COUNTED_REASONS, ip, WINDOW_MINUTES]
    )
    failed = rows[0]?.n || 0
    oldest = rows[0]?.oldest || null
  } catch (err) {
    // 审计表读不到时不能把所有人挡在门外，放行并告警
    console.warn('[login-throttle] 查询失败，本次放行：', err.message)
    return { blocked: false, failed: 0, remaining: MAX_FAILS, retryAfterSec: 0 }
  }

  if (failed < MAX_FAILS) {
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

  return { blocked: true, failed, remaining: 0, retryAfterSec }
}
