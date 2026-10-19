/**
 * 登录验证码（2026-10-19 加）
 *
 * 设计取舍：
 *   · 服务端出**算术题**，答案只存在内存里（不下发给前端）；token 一次性、5 分钟过期
 *   · 单进程（PM2 fork 1 实例）足够；将来多实例部署要换成 DB / Redis
 *   · ⚠️ 题面是纯文本，**挡的是「直接 POST 撞库」的脚本**（它们不会去解题），
 *     挡不住会解析题面的定向程序。要更强请换 Cloudflare Turnstile。
 */
import crypto from 'node:crypto'

const TTL_MS = 5 * 60 * 1000

/** token -> { answer, exp } */
const store = new Map()

function sweep() {
  const now = Date.now()
  for (const [k, v] of store) {
    if (v.exp <= now) store.delete(k)
  }
}

/**
 * 出一题（两位数以内的加减法，结果恒非负）。
 * @returns {{token: string, question: string}} —— **不返回答案**
 */
export function issueCaptcha() {
  sweep()
  const plus = Math.random() < 0.5
  const a = 2 + Math.floor(Math.random() * 9) // 2..10
  const b = 1 + Math.floor(Math.random() * 9) // 1..9
  // 减法保证被减数 ≥ 减数，避免出现负数答案
  const x = plus ? a : Math.max(a, b)
  const y = plus ? b : Math.min(a, b)
  const answer = plus ? x + y : x - y

  const token = crypto.randomBytes(16).toString('hex')
  store.set(token, { answer, exp: Date.now() + TTL_MS })
  return { token, question: `${x} ${plus ? '+' : '−'} ${y} = ?` }
}

/**
 * 校验并**立即作废**（同一题不许反复猜）。
 * @returns {boolean}
 */
export function verifyCaptcha(token, answer) {
  sweep()
  const key = String(token || '')
  const rec = store.get(key)
  if (!rec) return false
  store.delete(key) // 不管对错都作废
  if (rec.exp <= Date.now()) return false
  return String(answer ?? '').trim() === String(rec.answer)
}

export const CAPTCHA_TTL_SEC = Math.round(TTL_MS / 1000)
