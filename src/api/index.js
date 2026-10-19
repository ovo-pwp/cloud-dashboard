import request from './request'
import { setUnauthorizedHandler } from './request'

// 供 main.js 注入「401 跳登录页」的回调，避免 api 层直接依赖 router
export { setUnauthorizedHandler }

// ------------------------------------------------------------
// 登录令牌本地存取（localStorage：刷新/重开浏览器都保持登录）
// ------------------------------------------------------------
const AUTH_KEY = 'cloud-dashboard:auth-token'

export function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_KEY) || ''
  } catch {
    return ''
  }
}

export function setAuthToken(token) {
  try {
    if (token) localStorage.setItem(AUTH_KEY, token)
    else localStorage.removeItem(AUTH_KEY)
  } catch {
    /* 隐私模式下可能不可用，忽略 */
  }
}

export function clearAuthToken() {
  setAuthToken('')
}

/** 登录：用户名 + 密码 (+ 验证码) → 令牌；remember=true 时用更长的有效期 */
export function login(username, password, remember = false, captcha = null) {
  const body = { username, password, remember: !!remember }
  if (captcha) {
    body.captchaToken = captcha.token || ''
    body.captchaAnswer = captcha.answer || ''
  }
  return request.post('/login', body)
}

/** 取一道登录验证码（算术题）；本机回环按配置会返回 enabled:false */
export function getCaptcha() {
  return request.get('/captcha')
}

/** 查当前登录状态 */
export function getMe() {
  return request.get('/me')
}

/** 退出登录 */
export function logout() {
  return request.post('/logout')
}

/** 登录记录（分页 + 过滤）：谁在什么时候从哪个 IP 登录了平台 */
export function getLoginLog(params = {}) {
  return request.get('/login-log', { params })
}

/** 已配置的账号列表（不含密码） */
export function getLoginUsers() {
  return request.get('/login-users')
}

/** 业务类型常量 */
export const BIZ = {
  BILLED_UNPAID: 'billed_unpaid',
  SHIPPED_UNINVOICED: 'shipped_uninvoiced',
}

export const BIZ_LABEL = {
  [BIZ.BILLED_UNPAID]: '已开票未回款',
  [BIZ.SHIPPED_UNINVOICED]: '已发货未开票',
}

/** 可用业务类型及最新快照 */
export function getBizTypes() {
  return request.get('/biz-types')
}

/** 顶部汇总 */
export function getSummary(bizType) {
  return request.get('/summary', { params: { bizType } })
}

/** 看板主表：业务员 × 账龄档 */
export function getAgingBySalesperson(bizType) {
  return request.get('/aging-by-salesperson', { params: { bizType } })
}

/**
 * 两条销售线的「本批 vs 上批」差异（新增 / 补录 / 回款或已开票 / 金额改动）。
 *
 * 2026-10-14 提到这里：以前只有 DailyShipPay 内部直接 request.get，现在 /home 的
 * 「当日回款」卡也要用，统一走这个封装，别再各写各的路径。
 */
export function getLineDelta(bizType, salesperson) {
  const params = { bizType }
  if (salesperson) params.salesperson = salesperson
  return request.get('/customer-invoice/line-delta', { params })
}

/** 账龄分档汇总 */
export function getAgingSummary(bizType) {
  return request.get('/aging-summary', { params: { bizType } })
}

/** 明细查询（分页 + 筛选 + 排序） */
export function getDetail(bizType, params = {}) {
  return request.get('/detail', { params: { bizType, ...params } })
}

/** 修改某条单据的进度反馈。按「单据号」一份、存独立表，与源表导入解耦 */
export function updateDetailNote(bizType, docNo, note) {
  return request.put('/detail/note', { bizType, docNo, note })
}

/** 修改某条明细的人工提醒（与系统自动的 data_warning 是两个字段） */
export function updateDetailReminder(id, reminder) {
  return request.put('/detail/reminder', { id, reminder })
}

/** 按客户汇总 */
export function getByCustomer(bizType) {
  return request.get('/by-customer', { params: { bizType } })
}

/** 筛选选项 */
export function getFilters(bizType) {
  return request.get('/filters', { params: { bizType } })
}

/** 每日快照趋势 */
export function getTrend(bizType) {
  return request.get('/trend', { params: { bizType } })
}

/** 数据质量告警 */
export function getWarnings(bizType) {
  return request.get('/warnings', { params: { bizType } })
}

/** 客户平台未回款 —— 顶部汇总（含上期对比） */
export function getCustomerPlatformSummary() {
  return request.get('/customer-platform-unpaid/summary')
}

/** 客户平台未回款 —— 账龄分布（3个月以上 / 2个月 / 1个月 / 当月） */
export function getCustomerPlatformAging() {
  return request.get('/customer-platform-unpaid/aging')
}

/** 客户平台未回款 —— 按业务员汇总 */
export function getCustomerPlatformBySalesperson() {
  return request.get('/customer-platform-unpaid/by-salesperson')
}

/** 客户平台未回款 —— 按下单平台汇总 */
export function getCustomerPlatformByPlatform() {
  return request.get('/customer-platform-unpaid/by-platform')
}

/** 客户平台未回款 —— 客户+平台两级汇总 */
export function getCustomerPlatformBreakdown(params = {}) {
  return request.get('/customer-platform-unpaid/breakdown', { params })
}

/** 客户平台未回款 —— 业务员列表（筛选用） */
export function getCustomerPlatformSalespersons() {
  return request.get('/customer-platform-unpaid/salespersons')
}

/** 客户平台未回款 —— 平台列表（列展示用） */
export function getCustomerPlatformList() {
  return request.get('/customer-platform-unpaid/platforms')
}

/** 客户平台未回款 —— 订单级明细 */
export function getCustomerPlatformDetail(params = {}) {
  return request.get('/customer-platform-unpaid/detail', { params })
}

/** 系统配置（监控参数 + 各数据源快照） */
export function getSystemConfig() {
  return request.get('/system-config')
}

/** 启动一次数据同步（抓云端 → 入库），后台执行；需登录 */
export function startSync() {
  return request.post('/sync')
}

/** 查询同步进度（含滚动日志） */
export function getSyncStatus() {
  return request.get('/sync/status')
}

/** 最近若干次同步记录（持久化在数据库，后端重启也不丢） */
export function getSyncRuns(limit = 20) {
  return request.get('/sync/runs', { params: { limit } })
}

/** 数据新鲜度（所有角色可用，只含时间/成功/进行中三个字段） */
export function getFreshness() {
  return request.get('/freshness')
}

// ------------------------------------------------------------
// Excel 导出
// ------------------------------------------------------------
/**
 * 把后端返回的 Blob 存成本地文件。
 * 走 Blob + a[download] 而不是 window.open —— 后者带不上 X-Auth-Token 头。
 */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 交给浏览器读完后释放
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** 导出台账明细（未回款 / 未开票），条件是当前页面筛选条件 */
export async function exportDetail(bizType, params, filename) {
  const blob = await request.get('/export/detail', {
    params: { bizType, ...params },
    responseType: 'blob',
  })
  saveBlob(blob, filename)
}

/** 导出客户平台订单明细 */
export async function exportCustomerPlatformDetail(params, filename) {
  const blob = await request.get('/export/customer-platform-detail', {
    params,
    responseType: 'blob',
  })
  saveBlob(blob, filename)
}
