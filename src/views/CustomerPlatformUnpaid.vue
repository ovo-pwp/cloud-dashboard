<template>
  <div class="container" v-loading="loading">
    <div class="page-header">
      <h1 class="main-title">客户平台未回款金额看板</h1>
      <span class="sub" v-if="summary.snapshotDate">{{ summary.snapshotDate }}（每周四更新）</span>
    </div>

    <el-row :gutter="16" class="cards">
      <el-col :span="6">
        <div class="card">
          <div class="card-label">未回款金额（元）</div>
          <div class="card-value amount">{{ fmt(summary.total) }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="card">
          <div class="card-label">客户数</div>
          <div class="card-value">{{ summary.customerCount }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="card">
          <div class="card-label">平台数</div>
          <div class="card-value">{{ summary.platformCount }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="card">
          <div class="card-label">订单数</div>
          <div class="card-value">{{ summary.orderCount }}</div>
        </div>
      </el-col>
    </el-row>

    <div class="search-row">
      <el-select
        v-model="salesperson"
        placeholder="按业务员筛选"
        clearable
        style="width: 220px"
        @change="loadBreakdown"
      >
        <el-option v-for="sp in salespersons" :key="sp" :label="sp" :value="sp" />
      </el-select>
      <el-input
        v-model="keyword"
        placeholder="搜客户（挂账客户）"
        clearable
        :prefix-icon="Search"
        style="width: 280px"
      />
    </div>

    <el-table
      :data="displayRecords"
      border
      style="width: 100%"
      :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
      row-key="customer"
    >
      <el-table-column type="index" label="#" width="60" align="center" />
      <el-table-column prop="customer" label="挂账客户" min-width="220" show-overflow-tooltip />
      <el-table-column
        v-for="p in platforms"
        :key="p"
        :label="p"
        min-width="150"
        align="right"
        sortable
      >
        <template #default="{ row }">
          <span class="amount">{{ fmt(row.platformMap[p]) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="total" label="未回款合计(元)" min-width="170" align="right" sortable>
        <template #default="{ row }">
          <span class="amount">{{ fmt(row.total) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="占比" width="160" align="center">
        <template #default="{ row }">
          <div class="ratio-wrap">
            <div class="ratio-bar" :style="{ width: Math.abs(ratio(row.total)) + '%' }" />
            <span class="ratio-text">{{ ratio(row.total) }}%</span>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <div class="summary-bar">
      <span>金额合计 <b class="amount">{{ fmt(total) }}</b> 元 · 共 {{ records.length }} 个客户</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import {
  getCustomerPlatformSummary,
  getCustomerPlatformBreakdown,
  getCustomerPlatformSalespersons,
  getCustomerPlatformList,
} from '@/api'

const loading = ref(false)
const summary = ref({ total: 0, customerCount: 0, platformCount: 0, orderCount: 0, snapshotDate: null })
const records = ref([])
const total = ref(0)
const keyword = ref('')
const salesperson = ref('')
const salespersons = ref([])
const platforms = ref([])

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
  const rows = records.value.map((r) => ({
    ...r,
    platformMap: Object.fromEntries(r.platforms.map((p) => [p.platform, p.total])),
  }))
  if (!keyword.value) return rows
  const k = keyword.value.toLowerCase()
  return rows.filter((r) => r.customer.toLowerCase().includes(k))
})

async function loadBreakdown() {
  const params = salesperson.value ? { salesperson: salesperson.value } : {}
  const b = await getCustomerPlatformBreakdown(params)
  records.value = b.records || []
  total.value = b.total || 0
}

async function loadData(silent) {
  if (!silent) loading.value = true
  try {
    const [s, sp, pl] = await Promise.all([
      getCustomerPlatformSummary(),
      getCustomerPlatformSalespersons(),
      getCustomerPlatformList(),
    ])
    summary.value = s
    salespersons.value = sp.salespersons || []
    platforms.value = pl.platforms || []
    await loadBreakdown()
  } catch (err) {
    console.error('[CustomerPlatformUnpaid] 加载失败:', err)
  } finally {
    if (!silent) loading.value = false
  }
}

onMounted(loadData)
useAutoRefresh(loadData)
</script>

<style scoped>
.container { padding: 20px; background: #fff; border-radius: 8px; }
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 16px;
}
.main-title { font-size: 22px; margin: 0; color: #303133; }
.sub { font-size: 13px; color: #909399; }
.cards { margin-bottom: 16px; }
.card {
  background: #f5f7fa;
  border-radius: 8px;
  padding: 16px 18px;
}
.card-label { font-size: 13px; color: #909399; margin-bottom: 8px; }
.card-value { font-size: 24px; font-weight: 700; color: #303133; }
.card-value.amount { color: #f56c6c; }
.search-row { display: flex; gap: 12px; margin-bottom: 14px; }
.expand-panel { padding: 8px 24px; background: #fafafa; }
.amount { font-weight: 600; color: #f56c6c; }
.summary-bar { margin-top: 12px; font-size: 14px; color: #606266; }
.summary-bar .amount { font-size: 17px; }
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
</style>