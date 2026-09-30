import { createRouter, createWebHistory } from 'vue-router'
import Layout from '@/layout/index.vue'
import { getAuthToken, getMe } from '@/api'

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
        meta: { title: '数据概览' },
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
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// ------------------------------------------------------------
// 全局路由守卫：未登录一律拦到登录页；角色不够的页面挡回首页
// ------------------------------------------------------------
// 缓存一次"登录是否已开启"与当前角色，避免每次跳转都请求后端
let loginEnabledCache = null
let roleCache = null

router.beforeEach(async (to) => {
  document.title = to.meta.title ? `${to.meta.title} · 云端看板` : '云端看板'

  // 登录页本身放行
  if (to.meta.public) return true

  // 本地没有令牌 → 直接去登录页（带上来源以便登录后跳回）
  if (!getAuthToken()) {
    return { path: '/login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
  }

  // 有令牌：向后端确认是否仍有效（令牌可能已过期或后端重启换了密钥）
  // 每个会话只验一次，之后依赖 401 拦截器兜底
  if (loginEnabledCache === null) {
    try {
      const me = await getMe()
      loginEnabledCache = !!me.loginEnabled
      roleCache = me.role || null
      // 后端未启用登录保护，本地令牌无意义，清掉继续
      if (!me.loginEnabled) return true
      if (!me.loggedIn) {
        return { path: '/login', query: { redirect: to.fullPath } }
      }
    } catch {
      // 校验失败（网络/未登录）交给登录页处理
      return { path: '/login', query: { redirect: to.fullPath } }
    }
  }

  // 角色不够的页面挡回首页，并带上 denied 让布局给出明确原因
  // （前端拦截只是体验，真正的拦截在后端 requireRole）
  const need = to.meta.roles
  if (need && need.length && !need.includes(roleCache)) {
    return { path: '/homepage', query: { denied: to.meta.title || to.path } }
  }

  return true
})

export default router
