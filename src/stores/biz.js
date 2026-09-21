import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getBizTypes, BIZ, BIZ_LABEL } from '@/api'

/**
 * 当前业务类型（已开票未回款 / 已发货未开票）
 * 各页面共用，切换后通过 watch 触发重新加载
 */
export const useBizStore = defineStore('biz', () => {
  const current = ref(BIZ.BILLED_UNPAID)

  /** 后端返回的业务类型元信息（含快照日期、行数、金额） */
  const available = ref([])

  const label = computed(() => BIZ_LABEL[current.value] || current.value)

  const currentMeta = computed(
    () => available.value.find((b) => b.bizType === current.value) || null
  )

  /** 从后端同步可用业务类型列表 */
  async function loadBizTypes() {
    try {
      const list = await getBizTypes()
      available.value = list || []
      // 若当前类型无数据但另一个有，自动切到有数据的那个
      const hasCurrent = available.value.some((b) => b.bizType === current.value)
      if (!hasCurrent && available.value.length > 0) {
        current.value = available.value[0].bizType
      }
    } catch (err) {
      console.error('[bizStore] 加载业务类型失败:', err)
      available.value = []
    }
  }

  function setBizType(type) {
    if (BIZ_LABEL[type]) current.value = type
  }

  return { current, available, label, currentMeta, loadBizTypes, setBizType }
})
