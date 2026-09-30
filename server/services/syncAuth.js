/**
 * 登录鉴权 + 账号角色
 *
 * 设计：
 *   - 多账号来自 .env 的 LOGIN_USERS（`用户名=密码[:角色]` 逗号分隔），
 *     兼容单个 LOGIN_USER/LOGIN_PASSWORD
 *   - 验证通过后签发 HMAC 签名的令牌（无状态，不需要服务端 session 存储）
 *   - 令牌内含「用户名 + 用途 + 过期时间」，并区分普通登录与「记住我」两档有效期
 *   - 签名密钥绑定用户名，因此某个账号改密码只影响该账号的令牌
 *   - 用 timingSafeEqual 做定长比较，避免时序侧信道
 *
 * 角色只有两档（见 ROLE_*）：
 *   admin  管理员 —— 全部功能：看板 + 立即同步 + 导出 Excel + 改备注 + 系统管理
 *   member 成员   —— 日常使用：看板 + 导出 Excel + 改备注（同步、系统管理仍限管理员）
 *   不写角色时默认 admin，这样已有部署升级后行为完全不变。
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

// ------------------------------------------------------------
// 角色与权限
//
//   admin  管理员 —— 全部功能：看板 + 立即同步 + 导出 Excel + 改备注 + 系统管理
//   member 成员   —— 日常使用：看板 + 导出 Excel + 改备注（同步与系统管理仍限管理员）
//
// 为什么还认 `viewer` 这个旧名：它曾是「只读」的角色名，`.env` 里可能还写着。
// 若把它当未知角色，`密码:viewer` 会整串被当成密码 → 结果是**登不上**，
// 一个手写的旧配置就表现成「账号或密码错了」，很难联想到是角色名的问题。
// 所以当别名收下（等价于 member）。
// ------------------------------------------------------------
export const ROLE_ADMIN = 'admin'
export const ROLE_MEMBER = 'member'

/** 旧角色名 → 现有角色 */
const ROLE_ALIASES = { viewer: ROLE_MEMBER }

export const ROLES = [ROLE_ADMIN, ROLE_MEMBER]

export const ROLE_LABEL = { [ROLE_ADMIN]: '管理员', [ROLE_MEMBER]: '成员' }

/**
 * 权限分组。
 * 写成具名常量而不是在每个路由上散着写角色，是为了「改权限时只动一行」，
 * 也顺便回答了「新加一个角色要不要给它这个权限」。
 *
 * CAN_EXPORT 与 CAN_EDIT_DETAIL 目前内容相同（都含成员），但**刻意分开命名**：
 * 它们是两件不同的事 —— 「把明细导出去」和「改动库里的人工字段」。
 * 哪天要收紧成「成员能导不能改」，只改 CAN_EDIT_DETAIL 一行即可，
 * 不用去猜「这个数组到底管着几件事」。
 */
/** 能导出 Excel */
export const CAN_EXPORT = [ROLE_ADMIN, ROLE_MEMBER]
/** 能改明细上的人工字段：备注、人工提醒（都是写库操作） */
export const CAN_EDIT_DETAIL = [ROLE_ADMIN, ROLE_MEMBER]
/** 能同步数据 / 进系统管理（含登录记录、同步历史） */
export const CAN_ADMIN = [ROLE_ADMIN]

/** 把配置里写的角色名规整成内部值；不认识的返回 null */
export function normalizeRole(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (ROLES.includes(v)) return v
  return ROLE_ALIASES[v] || null
}

/** 取配置值并去掉首尾空白 */
const cfg = (k) => String(process.env[k] || '').trim()

// ------------------------------------------------------------
// 账号表
// ------------------------------------------------------------

/**
 * 把「密码[:角色]」拆开。
 *
 * 从**末尾**找冒号，且只有当后缀确实是一个已知角色名（含别名）时才认定为角色。
 * 这样两个方向都不会出错：
 *   - 密码本身含冒号（如 `p@ss:word`）不会被误切；
 *   - 角色名写错（如 `abc:viewerr`）时整串仍当密码，
 *     结果是「登不上」而不是「静默按默认角色放行」—— 宁可拒绝，不可提权。
 */
function splitRole(rest) {
  const i = rest.lastIndexOf(':')
  if (i > 0) {
    const head = rest.slice(0, i).trim()
    const tail = rest.slice(i + 1)
    const role = normalizeRole(tail)
    if (head && role) return { password: head, role }
    // `user=密码:` 这种多打一个冒号的写法，忽略尾部空角色（不影响权限，只是别让人登不上）
    if (head && !tail.trim()) return { password: head, role: ROLE_ADMIN }
  }
  return { password: rest, role: ROLE_ADMIN }
}

/**
 * 解析账号列表。
 * 优先读 LOGIN_USERS（`user=pass[:role],user2=pass2`），否则退回 LOGIN_USER + LOGIN_PASSWORD。
 * @returns {Map<string, { password: string, role: string }>} 用户名 → 账号信息
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
      const rest = s.slice(i + 1).trim()
      if (!u || !rest) continue
      const { password, role } = splitRole(rest)
      if (password) map.set(u, { password, role })
    }
  }

  // 兼容旧写法（若已用 LOGIN_USERS 配了同名用户，不覆盖）
  const singleUser = cfg('LOGIN_USER')
  const singlePass = cfg('LOGIN_PASSWORD')
  if (singleUser && singlePass && !map.has(singleUser)) {
    map.set(singleUser, { password: singlePass, role: ROLE_ADMIN })
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

/** 列出「用户名 + 角色」（不含密码，供页面展示） */
export function listAccounts() {
  return [...getUsers()].map(([username, v]) => ({ username, role: v.role }))
}

/** 取单个账号（含角色）；不存在返回 null */
export function getUser(username) {
  return getUsers().get(String(username || '').trim()) || null
}

/**
 * 取某个账号的角色。
 *
 * 两点刻意的选择：
 *   1. 未配置登录账号时返回 admin —— 此时整站本来就对所有人开放，再谈角色没有意义；
 *   2. 账号查不到时返回 member —— 最小权限兜底（这种令牌其实也签不过，
 *      因为签名密钥绑定了密码，账号被删后旧令牌当场失效）。
 */
export function getUserRole(username) {
  if (!isLoginEnabled()) return ROLE_ADMIN
  return getUser(username)?.role || ROLE_MEMBER
}

// ------------------------------------------------------------
// 通用工具
// ------------------------------------------------------------

/** 派生签名密钥：绑定用户名 + 部署盐值，避免令牌被搬运到别的机器或账号复用 */
function secret(scope, username = '') {
  const base = `${username}::${getUser(username)?.password || ''}`
  // 盐值优先取 AUTH_SECRET（部署到公网时务必配置一串长随机值）。
  // 没有配置才退回主机名 —— 那是为了兼容本机/局域网的老行为，但：
  //   1) 容器每次重建都会换主机名 → 所有已签发令牌一起失效（全员掉线）
  //   2) 主机名本身是可猜的，做签名盐太弱，不适合公网
  const anchor = cfg('AUTH_SECRET') || os.hostname()
  return crypto
    .createHash('sha256')
    .update(`${base}::${anchor}::cloud-dashboard::${scope}`)
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
  // Terima token dari berbagai sumber (standar + custom)
  let token = req.get('X-Auth-Token') || ''
  if (!token) {
    const auth = req.get('Authorization') || ''
    if (auth.startsWith('Bearer ')) {
      token = auth.slice(7)
    }
  }
  if (!token) token = req.query.authToken || ''
  return token
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
 * @returns {{ ok: boolean, reason?: string, role?: string }}
 */
export function verifyLogin(user, password) {
  const users = getUsers()
  if (users.size === 0) return { ok: true, role: ROLE_ADMIN }

  if (typeof user !== 'string' || typeof password !== 'string') {
    dummyCompare()
    return { ok: false, reason: '参数缺失' }
  }

  const name = user.trim()
  const entry = users.get(name)

  if (entry === undefined) {
    // 用户不存在：也做一次等长比较，避免通过耗时区分「用户不存在」和「密码错误」
    dummyCompare()
    return { ok: false, reason: '账号不存在' }
  }

  if (!safeEqual(password, entry.password)) {
    return { ok: false, reason: '密码错误' }
  }

  return { ok: true, role: entry.role }
}

/**
 * 签发登录令牌。
 * @param {string} username
 * @param {boolean} remember 勾选「记住我」→ 用更长的有效期
 */
export function issueLoginToken(username, remember = false) {
  const ttl = remember ? REMEMBER_TTL_HOURS : LOGIN_TTL_HOURS
  const role = getUserRole(username)
  return issue(SCOPE_LOGIN, ttl, { user: username, remember: !!remember, role }, username)
}

/** 校验登录令牌，返回 payload 或 null */
export function verifyLoginToken(token) {
  if (!isLoginEnabled()) return { scope: SCOPE_LOGIN, user: 'anonymous', role: ROLE_ADMIN }
  const payload = verify(token, SCOPE_LOGIN)
  if (!payload) return null

  // 角色一律以「当前配置」为准，而不是令牌里签发时的那个值。
  // 否则把某人从 admin 改成 viewer 后，他手里的旧令牌还能当管理员用满 12 小时
  // （「记住我」更是 7 天）。改配置就该立刻生效。
  payload.role = getUserRole(payload.user)
  return payload
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
    req.role = payload.role
    return next()
  }

  return res.status(401).json({
    error: '未登录或登录已过期',
    code: 'LOGIN_REQUIRED',
    loginEnabled: true,
  })
}

// ------------------------------------------------------------
// 角色授权
// ------------------------------------------------------------

/**
 * Express 中间件：限定角色。
 *   router.post('/sync', requireRole(ROLE_ADMIN), handler)
 *
 * 返回 403 而不是 401 —— 403 是「已登录但没这个权限」，401 是「没登录」。
 * 混用会让前端把「成员点了管理员专属操作」误判成登录过期，把人踢回登录页。
 *
 * 未配置登录账号时直接放行：此时整站本来就对所有人开放（见 requireLogin），
 * 再谈角色限制只会让人以为功能坏了。
 */
export function requireRole(...roles) {
  const allowed = roles.flat()

  return function roleGuard(req, res, next) {
    if (!isLoginEnabled()) return next()

    const payload = verifyLoginToken(pickToken(req))
    if (!payload) {
      return res.status(401).json({
        error: '未登录或登录已过期',
        code: 'LOGIN_REQUIRED',
        loginEnabled: true,
      })
    }

    if (allowed.includes(payload.role)) {
      req.user = payload.user
      req.role = payload.role
      return next()
    }

    return res.status(403).json({
      error: `当前账号是${ROLE_LABEL[payload.role] || payload.role}，没有该操作权限`,
      code: 'FORBIDDEN',
      role: payload.role,
      needRoles: allowed,
    })
  }
}
