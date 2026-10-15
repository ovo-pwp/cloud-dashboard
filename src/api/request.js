import axios from 'axios'
import { ElMessage } from 'element-plus'

const request = axios.create({
  // 开发环境走 vite 代理，生产环境走同源
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  // 2026-10-10：15s → 30s。
  // 公网要绕 Cloudflare 的 AMS（阿姆斯特丹）节点，国内一个请求 0.5~1.1s、
  // 抖动时 P95 到 5s，一页 4~7 个请求很容易顶到 15s 上限 → 表现成「偶发加载不出来」。
  timeout: 30000,
})

// ------------------------------------------------------------
// 请求拦截：自动带上登录令牌
// ------------------------------------------------------------
request.interceptors.request.use((config) => {
  try {
    const token = localStorage.getItem('cloud-dashboard:auth-token') || ''
    if (token) config.headers['X-Auth-Token'] = token
    // 记下本次请求是否真的带了令牌：
    // 用来区分「令牌过期」和「压根还没登录」，后者不该弹「已过期」
    config.__sentToken = !!token
  } catch {
    /* 忽略 */
  }
  return config
})

// ------------------------------------------------------------
// 响应拦截：统一解包与报错
// ------------------------------------------------------------
/** 401 时跳登录页的回调，由 main.js / 路由层注入，避免 api 层直接依赖 router */
let onUnauthorized = null
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

let redirecting = false

// 这些错误由登录页自己就地提示（它握着表单，能展示得更贴切），拦截器不再重复弹窗
const SILENT_CODES = new Set(['BAD_CREDENTIALS', 'TOO_MANY_ATTEMPTS'])

request.interceptors.response.use(
  (response) => response.data,
  async (error) => {
    // ------------------------------------------------------------
    // 隧道抖动自动重试（2026-10-10 新增）
    //
    // 公网链路要绕到欧洲节点，偶发一个请求卡 5s+ 甚至断连；页面一次发 4~7 个请求，
    // 撞上就是「加载不出来」。这类失败是**瞬时**的，重试一两次基本就过了。
    //
    // ⚠️ 只重试 GET：POST 可能是登录 / 触发同步，重试会造成副作用。
    // ⚠️ 只重试「超时」和「压根没收到响应」两种；收到 4xx/5xx 说明服务端已明确表态，不重试。
    // ------------------------------------------------------------
    const cfg = error.config
    const transient =
      error.code === 'ECONNABORTED' || (!error.response && !error.code?.startsWith('ERR_CANCELED'))
    const isGet = cfg && String(cfg.method || '').toLowerCase() === 'get'
    const tried = cfg?.__retryCount ?? 0
    if (isGet && transient && tried < 2) {
      cfg.__retryCount = tried + 1
      await new Promise((r) => setTimeout(r, 400 * cfg.__retryCount)) // 400ms → 800ms 退避
      return request(cfg)
    }

    const status = error.response?.status

    // 导出接口用的是 responseType:'blob'，出错时响应体也是 Blob，
    // 直接读 .error 会拿不到，这里先还原成 JSON 再继续
    if (error.response?.data instanceof Blob) {
      try {
        error.response.data = JSON.parse(await error.response.data.text())
      } catch {
        error.response.data = null
      }
    }

    const code = error.response?.data?.code

    // 登录页相关错误：交给调用方处理，避免「拦截器 + 页面」弹两次
    if (SILENT_CODES.has(code)) return Promise.reject(error)

    // 未登录 / 登录过期：清令牌并跳登录页（只提示一次，避免并发请求刷屏）
    if (status === 401 && (code === 'LOGIN_REQUIRED' || !code)) {
      try {
        localStorage.removeItem('cloud-dashboard:auth-token')
      } catch {
        /* 忽略 */
      }
      if (!redirecting) {
        redirecting = true
        // 只有「带着令牌却被拒」才算过期；没带令牌只是还没登录，
        // 这时弹「登录已过期」会让人以为账号出了问题
        if (error.config?.__sentToken) {
          ElMessage.warning('登录已过期，请重新登录')
        }
        onUnauthorized?.()
        setTimeout(() => {
          redirecting = false
        }, 1000)
      }
      return Promise.reject(error)
    }

    let msg = '请求失败，请稍后重试'

    if (error.code === 'ECONNABORTED') {
      msg = '请求超时，请检查网络或后端服务'
    } else if (error.response) {
      msg = error.response.data?.error || `服务端错误 (${status})`
    } else if (error.request) {
      msg = '无法连接后端服务，请确认 API 已启动'
    }

    ElMessage.error(msg)
    return Promise.reject(error)
  }
)

export default request
