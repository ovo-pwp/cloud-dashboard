/**
 * 本机保存过的账号 —— 用于顶栏「一键切换账号」
 *
 * 只存**登录令牌**，不存密码：
 *   - 令牌本身有有效期（普通 12h / 勾了记住我 7 天），过期或后端换密钥后会失效；
 *     切换前会用 /api/me 实测一次，失效就退回登录页，不会把人放进一个半死的会话里。
 *   - 改密码会让该账号已发的令牌立刻失效（签名密钥绑定了密码），所以这里不需要额外失效逻辑。
 *
 * 安全边界（与使用者 2026-09-23 确认的规则）：
 *   免密切换**不允许提权** —— 只能切到权限不高于当前账号的账号。
 *   管理员 → 成员：一键即可；成员 → 管理员：必须回到登录页输密码。
 *   判定看的是「切换后 /api/me 返回的真实角色」，不是缓存在这里的旧角色，
 *   所以哪天在 `.env` 里把某人降权，这里也会立刻按新角色处理。
 */

const KEY = 'cloud-dashboard:accounts'
// 最多留几个账号，避免 localStorage 无限长
const MAX = 6

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    if (!Array.isArray(arr)) return []
    return arr.filter((a) => a && typeof a.u === 'string' && a.u && typeof a.t === 'string' && a.t)
  } catch {
    return []
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)))
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 已保存的账号列表（含令牌，供切换用；不要直接渲染出去） */
export function listSaved() {
  return read()
}

/** 登录成功后记一笔（同账号覆盖旧的令牌） */
export function saveAccount({ username, role, token }) {
  if (!username || !token) return
  const rest = read().filter((a) => a.u !== username)
  rest.push({ u: username, r: role || '', t: token, at: Date.now() })
  write(rest)
}

/** 令牌失效时把它从列表里摘掉，免得下次又点一次无效项 */
export function removeAccount(username) {
  write(read().filter((a) => a.u !== username))
}
