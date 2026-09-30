/**
 * 登录态与角色（模块级共享缓存）
 *
 * 为什么不做成每个页面各自查一次 /api/me：
 *   角色要参与「菜单显不显示、导出按钮能不能点、路由放不放行」三处判断，
 *   分散去查会出现「菜单已按只读渲染、但页面还以为自己是管理员」的错位。
 *   这里统一缓存一次，谁都用同一份。
 *
 * 角色只有两档：
 *   admin  管理员 —— 全部功能（同步 / 导出 / 改备注 / 系统管理）
 *   member 成员   —— 看数据 + 导出 Excel + 改备注（同步、系统管理用不了）
 */
import { ref, computed } from 'vue'
import { getMe } from '@/api'

export const ROLE_ADMIN = 'admin'
export const ROLE_MEMBER = 'member'
export const ROLE_LABEL = { [ROLE_ADMIN]: '管理员', [ROLE_MEMBER]: '成员' }

const username = ref('')
const role = ref('')
// 后端是否启用了登录保护。未启用时整站本来就是开放的，此时不应拿角色卡任何人
const loginEnabled = ref(true)
const loaded = ref(false)

let inflight = null

/**
 * 拉一次 /api/me 并缓存。
 * @param {boolean} force 强制重取（改过账号、退出登录后用）
 */
export function loadAuth(force = false) {
  if (!force && loaded.value) return Promise.resolve()
  if (!force && inflight) return inflight

  inflight = getMe()
    .then((me) => {
      loginEnabled.value = me.loginEnabled !== false
      username.value = me.loggedIn ? me.username || '' : ''
      role.value = me.loggedIn ? me.role || '' : ''
      loaded.value = true
    })
    .catch(() => {
      // 失败不置 loaded，下次导航会重试；401 由拦截器统一跳登录页
      username.value = ''
      role.value = ''
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** 退出登录后清掉缓存，避免换账号后还留着上一个人的角色 */
export function resetAuth() {
  loaded.value = false
  inflight = null
  username.value = ''
  role.value = ''
}

export function useAuth() {
  // 未启用登录保护 = 没有任何权限门槛，按管理员对待（否则菜单会莫名其妙消失）
  const isAdmin = computed(() => !loginEnabled.value || role.value === ROLE_ADMIN)
  // 成员：登录已开启、且不是管理员。
  const isMember = computed(() => loginEnabled.value && role.value === ROLE_MEMBER)
  // 能导出 = 管理员或成员（当前等于「已登录」）——单独留一个名字，
  // 免得每处都写 !isAdmin 之类的反向判断；将来要收紧只改这一行
  const canExport = computed(() => !loginEnabled.value || isAdmin.value || isMember.value)
  // 能改明细上的人工字段：备注（写库操作）。原「人工提醒」列已从界面移除，
  // 后端接口与数据仍在，将来要把那列加回来，这个权限位可直接复用。
  // 与 canExport 目前等价（都 = 已登录），但**刻意分开**：
  // 哪天要「成员能导不能改」，只改这一行，不用去动导出按钮
  const canEditDetail = computed(() => !loginEnabled.value || isAdmin.value || isMember.value)
  const roleText = computed(() => (loginEnabled.value ? ROLE_LABEL[role.value] || '' : ''))

  return {
    username,
    role,
    roleText,
    loginEnabled,
    loaded,
    isAdmin,
    isMember,
    canExport,
    canEditDetail,
    loadAuth,
    resetAuth,
  }
}
