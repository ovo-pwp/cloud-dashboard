import { onMounted, onBeforeUnmount } from 'vue'

/**
 * 看板自动刷新：每 intervalMs 毫秒静默重拉一次数据（不带 loading 遮罩），
 * 组件卸载时自动清理定时器。
 * @param {(silent: boolean) => void} loader 数据加载函数，接收 silent=true 表示后台刷新
 * @param {number} intervalMs 轮询间隔
 */
export function useAutoRefresh(loader, intervalMs = 30000) {
  let timer = null
  onBeforeUnmount(() => clearInterval(timer))
  onMounted(() => {
    timer = setInterval(() => loader(true), intervalMs)
  })
}