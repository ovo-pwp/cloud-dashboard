import axios from 'axios'
import { ElMessage } from 'element-plus'

const request = axios.create({
  // 开发环境走 vite 代理，生产环境走同源
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 15000,
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
