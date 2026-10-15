import { createRouter, createWebHistory } from 'vue-router'
import Layout from '@/layout/index.vue'
import { getAuthToken } from '@/api'
// 角色/登录态的**唯一真相源**：守卫不再自建缓存（见下方注释说明的 bug）
import { loadAuth, useAuth } from '@/composables/useAuth'
// 旧页面 + 新发布 → chunk 404 时给出可操作的提示，而不是静默卡住
import { markStaleModule } from '@/composables/useVersionCheck'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    component: Layout,
    redirect: '/homepage',
    children: [
      {
        path: 'homepage',
        name: 'Homepage',
        component: () => import('@/views/Homepage.vue'),
        meta: { title: '首页' },
      },
      {
        path: 'system-hub',
        name: 'SystemHub',
        component: () => import('@/views/SystemHub.vue'),
        meta: { title: '总系统' },
      },
      {
        path: 'my-performance',
        name: 'MyPerformance',
        component: () => import('@/views/MyPerformance.vue'),
        meta: { title: '我的业绩' },
      },
      {
        // roles 是「进这一页需要什么角色」。不在列表里的一律会被守卫挡回首页，
        // 菜单里也会隐藏（前端隐藏只是体验，真正的拦截在后端 requireRole）
        path: 'system',
        name: 'System',
        component: () => import('@/views/System.vue'),
        meta: { title: '系统管理', roles: ['admin'] },
      },
      {
        path: 'home',
        name: 'Home',
        component: () => import('@/views/Home.vue'),
        meta: { title: '数据总览' },
      },
      {
        path: 'detail',
        name: 'Detail',
        component: () => import('@/views/Detail.vue'),
        meta: { title: '明细查询' },
      },
      {
        path: 'trend',
        name: 'Trend',
        component: () => import('@/views/Trend.vue'),
        meta: { title: '每日趋势' },
      },
      {
        path: 'customer-platform-unpaid',
        name: 'CustomerPlatformUnpaid',
        component: () => import('@/views/CustomerPlatformUnpaid.vue'),
        meta: { title: '客户平台未回款金额看板' },
      },
      {
        path: 'customer-platform-detail',
        name: 'CustomerPlatformDetail',
        component: () => import('@/views/CustomerPlatformDetail.vue'),
        meta: { title: '客户平台订单明细' },
      },
      {
        // 「待处理优先级清单」是独立新增页（2026-09-29），
        // 不改动任何既有页面；数据来自只读接口 /api/priority/actions
        path: 'priority-actions',
        name: 'PriorityActions',
        component: () => import('@/views/PriorityActions.vue'),
        meta: { title: '待处理优先级清单' },
      },
      {
        // 「单号追溯」独立页（2026-10-12）——
        // 明细页的搜索框只查最新批，查不到「已消失」的单；这一页跨全部历史批次查，
        // 数据来自只读接口 /api/trace。不改动任何既有页面。
        path: 'trace',
        name: 'TraceDoc',
        component: () => import('@/views/TraceDoc.vue'),
        meta: { title: '单号追溯' },
      },
      {
        // 「每日发货 · 回款明细」独立页（2026-10-12）——
        // 使用者要求：既嵌进「数据总览」，也单独给一个菜单页；两边共用同一个组件
        path: 'invoice-daily',
        name: 'InvoiceDaily',
        component: () => import('@/views/InvoiceDaily.vue'),
        meta: { title: '每日发货·回款明细' },
      },

    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// ------------------------------------------------------------
// 全局路由守卫：未登录一律拦到登录页；角色不够的页面挡回首页
//
// 🔴 2026-09-30 修 bug：这里原来自己维护了两个模块级缓存
//     `loginEnabledCache` / `roleCache`，**只在「首次导航」时赋值**
//     （`if (loginEnabledCache === null)`），之后登出、换账号、重新登录
//     都不会重置 —— 因为登出/切换只调了 `resetAuth()`，那清的是 useAuth 那一份。
//
//     复现过的后果：先用【成员】账号导航一次（roleCache='member'）→ 换成
//     【管理员】账号登录（登录后是 router.replace 的 SPA 内导航，页面不重载）
//     → 点「系统管理」被按陈旧角色挡回首页，而右上角明明白白写着「管理员」。
//     整页刷新反而正常 —— 因为刷新把模块级缓存清了。
//
// 修法：守卫不再自建角色缓存，只认 `useAuth()` 这一份真相源；
// 并且**以「令牌是否变化」作为失效条件**去调 `loadAuth(force)`：
//   令牌没变 → 走 loadAuth 的内部缓存，不重复打接口（正常导航零开销）
//   令牌变了 → 强制重新验证（换账号 / 重新登录 / 登出 / 令牌被外部替换）
// 为什么不只依赖 resetAuth()：那条路径只有「登出」和「切换账号」会走，
// 任何绕过它们的令牌变更（401 后重登、直接改 localStorage）都会留下陈旧角色。
// ------------------------------------------------------------
let lastVerifiedToken = null

router.beforeEach(async (to) => {
  document.title = to.meta.title ? `${to.meta.title} · 云端看板` : '云端看板'

  // 登录页本身放行
  if (to.meta.public) return true

  // 本地没有令牌 → 直接去登录页（带上来源以便登录后跳回）
  if (!getAuthToken()) {
    return { path: '/login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
  }

  // 有令牌：确认它对应的是**哪个角色**。
  // 令牌变了就强制重取（见上方说明），没变则走 loadAuth 的内部缓存。
  const tk = getAuthToken()
  await loadAuth(tk !== lastVerifiedToken)
  lastVerifiedToken = tk

  const { loginEnabled, username, role } = useAuth()

  // 后端未启用登录保护：整站本来就是开放的，不拿角色卡任何人
  if (!loginEnabled.value) return true

  // 令牌失效 / 未登录（loadAuth 会把 username 置空）→ 去登录页，带上来源以便登录后跳回
  if (!username.value) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  // 角色不够的页面挡回首页，并带上 denied 让布局给出明确原因
  // （前端拦截只是体验，真正的拦截在后端 requireRole）
  const need = to.meta.roles
  if (need && need.length && !need.includes(role.value)) {
    return { path: '/homepage', query: { denied: to.meta.title || to.path } }
  }

  return true
})

// ------------------------------------------------------------
// 懒加载 chunk 拉不到 —— 几乎一定是「浏览器里是旧页面，服务器上已经换了一批文件名」。
//
// 为什么必须接住：默认行为是导航静默失败，**页面停在原地不动**，
// 地址和面包屑却已经变了（看起来像「点不动 / 一直转圈」），极难自查。
// 接住它 → 右下角给出「页面已过期，请刷新」，一秒解决。
// ------------------------------------------------------------
router.onError((err) => {
  const msg = String(err?.message || err || '')
  if (
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk .* failed/i.test(
      msg
    )
  ) {
    markStaleModule()
  }
})

export default router
