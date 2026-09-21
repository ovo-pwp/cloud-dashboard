/**
 * 登录鉴权
 *
 * 设计：
 *   - 多账号来自 .env 的 LOGIN_USERS（`用户名=密码` 逗号分隔），兼容单个 LOGIN_USER/LOGIN_PASSWORD
 *   - 验证通过后签发 HMAC 签名的令牌（无状态，不需要服务端 session 存储）
 *   - 令牌内含「用户名 + 用途 + 过期时间」，并区分普通登录与「记住我」两档有效期
 *   - 签名密钥绑定用户名，因此某个账号改密码只影响该账号的令牌
 *   - 用 timingSafeEqual 做定长比较，避免时序侧信道
 *
 * 同步动作（「立即同步」按钮）复用登录令牌：登录即授权。
 *
 * 注意：这是「防止局域网内他人随意访问」级别的保护，不是对抗专业攻击的强认证。
 *       HTTP 明文传输，若要对外网暴露，请配合 HTTPS 与反向代理的认证。
 */
import crypto from 'node:crypto'
import os from 'node:os'

const LOGIN_TTL_HOURS = Number(process.env.LOGIN_TTL_HOURS) || 12
const REMEMBER_TTL_HOURS = Number(process.env.LOGIN_REMEMBER_TTL_HOURS) || 168 // 7 天

// 用途区分：令牌带 scope，避免被挪作他用
const SCOPE_LOGIN = 'login'

/** 取配置值并去掉首尾空白 */
const cfg = (k) => String(process.env[k] || '').trim()

// ------------------------------------------------------------
// 账号表
// ------------------------------------------------------------

/**
 * 解析账号列表。
 * 优先读 LOGIN_USERS（`user=pass,user2=pass2`），否则退回 LOGIN_USER + LOGIN_PASSWORD。
 * @returns {Map<string, string>} 用户名 → 密码
 */
export function getUsers() {
  const map = new Map()

  const multi = cfg('LOGIN_USERS')
  if (multi) {
    for (const pair of multi.split(',')) {
      const s = pair.trim()
      if (!s) continue
      const i = s.indexOf('=')
      if (i <= 0) continue // 没有 = 或用户名为空，跳过
      const u = s.slice(0, i).trim()
      const p = s.slice(i + 1).trim()
      if (u && p) map.set(u, p)
    }
  }

  // 兼容旧写法（若已用 LOGIN_USERS 配了同名用户，不覆盖）
  const singleUser = cfg('LOGIN_USER')
  const singlePass = cfg('LOGIN_PASSWORD')
  if (singleUser && singlePass && !map.has(singleUser)) {
    map.set(singleUser, singlePass)
  }

  return map
}

/** 是否已配置登录账号 */
export function isLoginEnabled() {
  return getUsers().size > 0
}

/** 列出用户名（不含密码，供页面展示） */
export function listUsernames() {
  return [...getUsers().keys()]
}

// ------------------------------------------------------------
// 通用工具
// ------------------------------------------------------------

/** 派生签名密钥：绑定用户名 + 主机名，避免令牌被搬运到别的机器或账号复用 */
function secret(scope, username = '') {
  const base = `${username}::${getUsers().get(username) || ''}`
  return crypto
    .createHash('sha256')
    .update(`${base}::${os.hostname()}::cloud-dashboard::${scope}`)
    .digest()
}

/** 定长安全比较，防止时序攻击 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  // 长度不同时也要走完比较流程，避免通过耗时判断长度
  const len = Math.max(ba.length, bb.length, 1)
  const pa = Buffer.alloc(len)
  const pb = Buffer.alloc(len)
  ba.copy(pa)
  bb.copy(pb)
  return crypto.timingSafeEqual(pa, pb) && ba.length === bb.length
}

/** 签发令牌：base64url(payload).hex(HMAC) */
function issue(scope, ttlHours, extra = {}, username = '') {
  const payload = JSON.stringify({
    scope,
    exp: Date.now() + ttlHours * 3600 * 1000,
    ...extra,
  })
  const body = Buffer.from(payload, 'utf8').toString('base64url')
  const sig = crypto.createHmac('sha256', secret(scope, username)).update(body).digest('hex')
  return `${body}.${sig}`
}

/** 校验令牌：用途匹配、签名正确、未过期 */
function verify(token, scope) {
  if (typeof token !== 'string' || !token.includes('.')) return null

  const idx = token.lastIndexOf('.')
  const body = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  if (!body || !sig) return null

  // 先解出 payload 拿到用户名（密钥与用户名绑定），再验签
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (payload.scope !== scope) return null

  const expect = crypto
    .createHmac('sha256', secret(scope, payload.user || ''))
    .update(body)
    .digest('hex')
  if (!safeEqual(sig, expect)) return null

  if (typeof payload.exp !== 'number' || Date.now() >= payload.exp) return null
  return payload
}

/** 从请求中取令牌 */
function pickToken(req) {
  return req.get('X-Auth-Token') || req.query.authToken || ''
}

// ------------------------------------------------------------
// 登录（整个看板）
// ------------------------------------------------------------

export { LOGIN_TTL_HOURS as LOGIN_TTL, REMEMBER_TTL_HOURS as REMEMBER_TTL }

/** 生成纯数字的随机码，用于模糊化失败原因（避免暴露哪个字段错） */
function dummyCompare() {
  safeEqual(crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex'))
}

/**
 * 校验用户名 + 密码。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyLogin(user, password) {
  const users = getUsers()
  if (users.size === 0) return { ok: true }

  if (typeof user !== 'string' || typeof password !== 'string') {
    dummyCompare()
    return { ok: false, reason: '参数缺失' }
  }

  const name = user.trim()
  const expected = users.get(name)

  if (expected === undefined) {
    // 用户不存在：也做一次等长比较，避免通过耗时区分「用户不存在」和「密码错误」
    dummyCompare()
    return { ok: false, reason: '账号不存在' }
  }

  if (!safeEqual(password, expected)) {
    return { ok: false, reason: '密码错误' }
  }

  return { ok: true }
}

/**
 * 签发登录令牌。
 * @param {string} username
 * @param {boolean} remember 勾选「记住我」→ 用更长的有效期
 */
export function issueLoginToken(username, remember = false) {
  const ttl = remember ? REMEMBER_TTL_HOURS : LOGIN_TTL_HOURS
  return issue(SCOPE_LOGIN, ttl, { user: username, remember: !!remember }, username)
}

/** 校验登录令牌，返回 payload 或 null */
export function verifyLoginToken(token) {
  if (!isLoginEnabled()) return { scope: SCOPE_LOGIN, user: 'anonymous' }
  return verify(token, SCOPE_LOGIN)
}

/**
 * Express 中间件：保护整个看板。
 * 未登录返回 401，前端据此跳转到登录页。
 */
export function requireLogin(req, res, next) {
  if (!isLoginEnabled()) return next()

  const payload = verifyLoginToken(pickToken(req))
  if (payload) {
    req.user = payload.user
    return next()
  }

  return res.status(401).json({
    error: '未登录或登录已过期',
    code: 'LOGIN_REQUIRED',
    loginEnabled: true,
  })
}

// ------------------------------------------------------------
// 同步授权
// ------------------------------------------------------------

/**
 * Express 中间件：保护「立即同步」动作。
 *
 * 登录已开启：登录即授权 —— 能登录看板说明是自己人，直接放行。
 * 登录未开启：不做额外校验（此时看板本身已对局域网完全开放）。
 */
export function requireSyncAuth(req, res, next) {
  if (!isLoginEnabled()) return next()

  if (verifyLoginToken(pickToken(req))) return next()

  return res.status(401).json({
    error: '未登录或登录已过期',
    code: 'LOGIN_REQUIRED',
    loginEnabled: true,
  })
}
