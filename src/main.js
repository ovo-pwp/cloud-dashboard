import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'
import { setUnauthorizedHandler, clearAuthToken } from './api'

const app = createApp(App)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

// 任何接口返回 401（登录过期）时，清令牌并跳登录页
setUnauthorizedHandler(() => {
  clearAuthToken()
  const current = router.currentRoute.value
  if (current.path !== '/login') {
    router.replace({ path: '/login', query: { redirect: current.fullPath } })
  }
})

app.use(createPinia())
app.use(ElementPlus, { locale: zhCn })
app.use(router)
app.mount('#app')

// ------------------------------------------------------------
// 修复「改了代码但页面还是旧的」——Vite HMR 断线后自动整页刷新
//
// 背景：Vite 在文件被整体重写时，会因「无法安全热替换」而静默放弃推送，
// 标签页就停在旧模块图上，不弹任何提示。更常见的情况是 dev server 重启过
// （进程换了 PID），旧标签页的 HMR websocket 早已断开，而页面不会自己重建。
//
// 这里监听 websocket 的「断开 → 重连」，一旦重连成功就整页刷新一次，
// 保证拿到最新模块。只在开发模式生效，生产构建时 import.meta.hot 为 undefined。
// ------------------------------------------------------------
if (import.meta.hot) {
  let everDisconnected = false
  import.meta.hot.on('vite:ws:disconnect', () => {
    // 首次连接前的 disconnect 不算（页面刚加载时会有一次）
    everDisconnected = true
  })
  import.meta.hot.on('vite:ws:connect', () => {
    if (everDisconnected) location.reload()
  })
}

