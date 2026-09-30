<template>
  <div class="container" v-loading="loading">
    <PageHeader :title="`${biz.label} · 按客户汇总`" :sub="`共 ${records.length} 个客户`" />

    <div class="summary-bar">
      <span>金额合计 <b class="amount">{{ fmt(total) }}</b> 元</span>
    </div>

    <div class="search-row">
      <el-input
        v-model="keyword"
        placeholder="搜索客户名"
        clearable
        :prefix-icon="Search"
        style="width: 260px"
      />
      <el-select v-model="sortBy" style="width: 150px">
        <el-option label="按金额排序" value="total" />
        <el-option label="按单数排序" value="docCount" />
        <el-option label="按3个月以上排序" value="over3m" />
      </el-select>
    </div>

    <el-table
      :data="displayRecords"
      border
      style="width: 100%"
      :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
    >
      <el-table-column type="index" label="#" width="60" align="center" />
      <el-table-column prop="customer" label="挂账客户" min-width="220" show-overflow-tooltip />
      <el-table-column prop="docCount" label="单数" width="75" align="center" sortable />
      <el-table-column prop="salespersons" label="业务员" width="130" align="center" show-overflow-tooltip />
      <el-table-column prop="over3m" label="3个月以上" width="150" align="right" sortable>
        <template #default="{ row }">{{ fmt(row.over3m) }}</template>
      </el-table-column>
      <el-table-column prop="total" label="金额合计(元)" width="160" align="right" sortable>
        <template #default="{ row }">
          <span :class="row.total < 0 ? 'negative' : 'amount'">{{ fmt(row.total) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="占比" width="150" align="center">
        <template #default="{ row }">
          <div class="ratio-wrap">
            <div class="ratio-bar" :style="{ width: Math.abs(ratio(row.total)) + '%' }" />
            <span class="ratio-text">{{ ratio(row.total) }}%</span>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { Search } from '@element-plus/icons-vue'
import { useBizStore } from '@/stores/biz'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import { getByCustomer } from '@/api'
import PageHeader from '@/components/PageHeader.vue'

const biz = useBizStore()
const { current } = storeToRefs(biz)

const loading = ref(false)
const records = ref([])
const total = ref(0)
const keyword = ref('')
const sortBy = ref('total')

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function ratio(amount) {
  if (!total.value) return 0
  return Number(((amount / total.value) * 100).toFixed(2))
}

const displayRecords = computed(() => {
  let list = records.value
  if (keyword.value) {
    const k = keyword.value.toLowerCase()
    list = list.filter((r) => r.customer.toLowerCase().includes(k))
  }
  return [...list].sort((a, b) => (b[sortBy.value] || 0) - (a[sortBy.value] || 0))
})

async function loadData(silent) {
  if (!silent) loading.value = true
  try {
    const data = await getByCustomer(current.value)
    records.value = data.records || []
    total.value = data.total || 0
  } catch (err) {
    console.error('[ByCustomer] 加载失败:', err)
  } finally {
    if (!silent) loading.value = false
  }
}

watch(current, loadData)
onMounted(loadData)
useAutoRefresh(loadData)
</script>

<style scoped>
.container { padding: 20px; background: #fff; border-radius: 8px; }
/* 头部已交给 PageHeader 组件统一 */
.summary-bar { margin-bottom: 12px; font-size: 14px; color: #606266; }
.summary-bar .amount { color: #f56c6c; font-weight: 700; font-size: 17px; }
.search-row { display: flex; gap: 12px; margin-bottom: 14px; }
.amount { font-weight: 600; color: #f56c6c; }
.negative { font-weight: 600; color: #67c23a; }
.ratio-wrap {
  position: relative;
  height: 16px;
  background: #f5f7fa;
  border-radius: 8px;
  overflow: hidden;
}
.ratio-bar {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background: linear-gradient(90deg, #f56c6c, #e6a23c);
  border-radius: 8px;
  transition: width 0.6s ease;
}
.ratio-text { position: relative; font-size: 11px; color: #303133; line-height: 16px; }

/* 移动端适配 */
@media (max-width: 768px) {
  .container { padding: 10px; }
  /* 头部字号/间距由 PageHeader 组件自己处理 */

  .toolbar { flex-wrap: wrap; gap: 8px; padding: 10px; }
  .toolbar .el-select,
  .toolbar .el-input { width: 140px !important; }

  :deep(.el-table) { font-size: 11px; min-width: 500px; }
  :deep(.el-table th),
  :deep(.el-table td) { padding: 6px 4px !important; }
}
</style>
