import { ref } from 'vue'

/**
 * 版本自检：防止「旧页面 + 新发布」导致的页面卡死。
 *
 * 为什么需要它：
 *   每次 `npm run build` 都会**清空 dist 并生成全新的文件名**（`index-<hash>.js`、
 *   `Detail-<hash>.js` …）。浏览器里已经打开的那份旧页面仍然拿着**旧的文件名**，
 *   一旦它去站内跳转到懒加载路由（明细查询 / 趋势 / 我的业绩…），请求的就是
 *   服务器上**已经不存在的文件** → 动态 import 失败 → 页面停在原地不动、转圈。
 *   现象很有迷惑性：地址和面包屑已经变了，内容却还是上一页。
 *
 * 这个模块做两件事：
 *   1. 定时（+ 切回标签页时）对比「线上主包文件名」是否变过 → 变了就提示刷新；
 *   2. 供路由的 chunk 加载失败回调调用（markStaleModule）→ 立刻提示。
 *
 * 刻意**不自动刷新**：页面上可能有正在编辑的备注，替他刷新会丢东西。
 * 只提示、给一个按钮，由使用者决定何时点。
 *
 * 🔴 唯一例外：登录页（2026-10-21 使用者反馈「登不上去」）。
 *   登录页上没有任何可丢的东西，而旧页面卡在登录的最典型表现就是
 *   「输完账号密码点登录没反应 / 白屏」，这时让人去按 Ctrl+F5 是多余的门槛。
 *   所以登录页检测到新版本就直接刷新；其余页面一律保持「只提示」。
 */
const CHECK_MS = 5 * 60 * 1000
/**
 * 两次检查之间的最短间隔（节流）。
 *
 * 🔴 为什么必须有：`focus` 事件触发得非常频繁 —— 切窗口、点 DevTools、点地址栏都会触发。
 * 不加节流就会变成「每点一下就拉一次首页」的请求风暴（实测开着 DevTools 时十几秒内刷了 14 条），
 * 既浪费带宽，又会跟真正的数据请求抢连接、把页面拖卡。
 * （这个 bug 是 2026-10-10 上线当天被使用者用 F12 网络面板抓出来的。）
 */
const MIN_GAP_MS = 60 * 1000

/** 线上有更新版本（主包文件名变了） */
export const hasNewVersion = ref(false)
/** 当前页面已经不可用（懒加载 chunk 拉不到），必须刷新才能继续 */
export const mustReload = ref(false)

let bootHash = null
let started = false
let lastCheckAt = 0

/** 读取线上 index.html 引用的主包文件名，作为「当前发布版本」的指纹 */
async function fetchLiveHash() {
  try {
    // 带唯一查询串 + no-store：绕开浏览器缓存，也绕开 Cloudflare 的 URL 缓存
    const res = await fetch(`/?_v=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const html = await res.text()
    const m = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
    return m ? m[1] : null
  } catch {
    // 断网 / 后端挂了：静默放弃，绝不因此打扰使用者
    return null
  }
}

async function check() {
  if (!bootHash) return
  // 节流：短时间内的重复触发直接丢弃（见 MIN_GAP_MS 的说明）
  const now = Date.now()
  if (now - lastCheckAt < MIN_GAP_MS) return
  lastCheckAt = now
  const live = await fetchLiveHash()
  if (live && live !== bootHash) {
    hasNewVersion.value = true
    maybeAutoReloadOnLogin()
  }
}

/**
 * 登录页自动刷新（防循环）。
 *
 * 为什么要防循环：如果 CDN/代理还在返回旧的 index.html，刷新后拿到的仍是旧主包，
 * 下次检查依旧「发现新版本」→ 无限刷新，用户会看到页面不停闪。
 * 用 sessionStorage 记一次时间戳，60 秒内只允许自动刷一次；
 * 超时后仍未解决就退回原来的「只提示」，把决定权交回给人。
 */
const AUTO_RELOAD_KEY = 'cloud-dashboard:auto-reload-at'

function maybeAutoReloadOnLogin() {
  // 只在登录页自动刷：这里没有未保存的输入，刷新零成本
  if (!window.location.pathname.startsWith('/login')) return
  try {
    const last = Number(window.sessionStorage.getItem(AUTO_RELOAD_KEY) || 0)
    if (Date.now() - last < 60 * 1000) return
    window.sessionStorage.setItem(AUTO_RELOAD_KEY, String(Date.now()))
  } catch {
    // 隐私模式下 sessionStorage 可能不可用：宁可只提示，也别冒无限刷新的风险
    return
  }
  reloadPage()
}

function onVisible() {
  if (document.visibilityState === 'visible') check()
}

/** 路由的 chunk 加载失败 → 基本可以断定是「旧页面 + 新发布」 */
export function markStaleModule() {
  mustReload.value = true
  // 登录页同样直接刷新：这里「必须刷新才能继续」，与其让人瞪着不动的页面，不如替他刷
  maybeAutoReloadOnLogin()
}

export function reloadPage() {
  window.location.reload()
}

/** 只调用一次（App.vue 启动时） */
export function startVersionWatch() {
  if (started) return
  started = true
  // 开发服务器下 `/` 引的是 /src/main.js，正则匹配不到 → bootHash 为 null → 自动不生效
  fetchLiveHash().then((h) => {
    bootHash = h
    // 启动这一次也算「刚查过」，否则紧接着一个 focus 事件会立刻再拉一次
    lastCheckAt = Date.now()
  })
  setInterval(check, CHECK_MS)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', check)
}
