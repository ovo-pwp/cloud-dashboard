import { createApp } from 'vue'
import { createPinia } from 'pinia'
// ------------------------------------------------------------
// Element Plus 按需引入（2026-10-10 改）
//
// 原先是 `app.use(ElementPlus)` 全量引入 —— 主包 954KB / gzip 314KB，
// 是首屏下载的大头（公网每次往返约 230ms，多出的体积直接变成等待时间）。
// 实测：只引 3 个组件时主包掉到 307KB / gzip 110KB，说明 tree-shaking 有效。
//
// ⚠️ 白名单式注册：**源码里新用到 el-xxx 组件时，必须同步加到这里**，
//    否则 Vue 会静默渲染成未知元素（不报错、只是没样式/没功能）。
//    查漏命令：grep -rhoE "<el-[a-z-]+" src/ | sed 's/<//' | sort -u
// ------------------------------------------------------------
import {
  ElAlert,
  ElAside,
  ElAvatar,
  ElButton,
  ElCard,
  ElCheckbox,
  ElCol,
  ElCollapse,
  ElCollapseItem,
  ElContainer,
  ElDatePicker,
  ElDescriptions,
  ElDescriptionsItem,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElHeader,
  ElIcon,
  ElInput,
  ElLoading,
  ElMain,
  ElMenu,
  ElMenuItem,
  ElOption,
  ElPagination,
  ElRadioButton,
  ElRadioGroup,
  ElRow,
  ElSelect,
  ElSubMenu,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTooltip,
} from 'element-plus'
// 样式仍用全量 CSS（体积小；逐组件引样式容易漏，收益也不大）
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'
import { setUnauthorizedHandler, clearAuthToken } from './api'

const app = createApp(App)

const EP_COMPONENTS = [
  ElAlert,
  ElAside,
  ElAvatar,
  ElButton,
  ElCard,
  ElCheckbox,
  ElCol,
  ElCollapse,
  ElCollapseItem,
  ElContainer,
  ElDatePicker,
  ElDescriptions,
  ElDescriptionsItem,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElHeader,
  ElIcon,
  ElInput,
  ElMain,
  ElMenu,
  ElMenuItem,
  ElOption,
  ElPagination,
  ElRadioButton,
  ElRadioGroup,
  ElRow,
  ElSelect,
  ElSubMenu,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTooltip,
]
for (const c of EP_COMPONENTS) {
  if (c && c.name) app.component(c.name, c)
}

// v-loading 指令：ElLoading 的 install 会 app.directive('loading', ...)
app.use(ElLoading)

// 图标仍全局注册 —— SystemHub.vue 用**字符串名**引用图标（icon: 'DataAnalysis'），
// 没有全局注册就渲染不出来。别删。
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
// 注意：按需注册后不能再 app.use(ElementPlus)，中文 locale 交给 App.vue 里的
// <el-config-provider :locale="zhCn"> 提供
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

