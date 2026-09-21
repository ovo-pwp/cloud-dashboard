<template>
  <div class="container">
    <div class="page-header">
      <h1 class="main-title">客户平台订单明细</h1>
      <span class="sub" v-if="snapshotDate">{{ snapshotDate }}</span>
    </div>

    <div class="toolbar">
      <el-select v-model="platform" placeholder="全部平台" clearable style="width: 160px" @change="openDetail(1)">
        <el-option v-for="p in platforms" :key="p" :label="p" :value="p" />
      </el-select>
      <el-input
        v-model="keyword"
        placeholder="搜单号 / 客户"
        clearable
        :prefix-icon="Search"
        style="width: 240px"
        @keyup.enter="openDetail(1)"
        @clear="openDetail(1)"
      />
      <el-button type="primary" :icon="Search" @click="openDetail(1)">查询</el-button>
      <el-button @click="resetDetail">重置</el-button>
      <el-button
        type="success"
        plain
        :icon="Download"
        :loading="exporting"
        :disabled="!total"
        @click="onExport"
      >
        {{ exporting ? '导出中…' : '导出 Excel' }}
      </el-button>
    </div>

    <div class="summary-bar">
      共 <b>{{ total }}</b> 条 · 金额 <b class="amount">{{ fmt(detailSum) }}</b> 元
    </div>

    <el-table
      :data="records"
      border
      v-loading="loading"
      style="width: 100%"
      :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
    >
      <el-table-column type="index" label="#" width="55" align="center" />
      <el-table-column prop="platform" label="平台" width="110" align="center" />
      <el-table-column prop="orderDate" label="订单日期" width="105" align="center" />
      <el-table-column prop="orderNo" label="订单号" min-width="140" show-overflow-tooltip />
      <el-table-column label="客户" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">{{ row.customerName || row.accountCustomer || '—' }}</template>
      </el-table-column>
      <el-table-column prop="accountCustomer" label="平台账号客户" min-width="140" show-overflow-tooltip />
      <el-table-column prop="product" label="商品" min-width="160" show-overflow-tooltip />
      <el-table-column prop="qty" label="数量" width="80" align="right" />
      <el-table-column prop="amountTotal" label="金额(元)" width="140" align="right">
        <template #default="{ row }">
          <span :class="row.amountTotal < 0 ? 'negative' : 'amount'">{{ fmt(row.amountTotal) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="salesperson" label="业务员" width="100" align="center" />
      <el-table-column prop="paymentStatus" label="回款状态" width="90" align="center" />
      <el-table-column prop="invoiceStatus" label="开票状态" width="90" align="center" />
    </el-table>

    <div class="pagination">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[20, 50, 100, 200]"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        background
        @current-change="loadData"
        @size-change="openDetail(1)"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Download } from '@element-plus/icons-vue'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import {
  getCustomerPlatformDetail,
  getCustomerPlatformList,
  exportCustomerPlatformDetail,
} from '@/api'

const loading = ref(false)
const exporting = ref(false)
const records = ref([])
const total = ref(0)
const detailSum = ref(0)
const page = ref(1)
const pageSize = ref(20)
const snapshotDate = ref(null)
const keyword = ref('')
const platform = ref('')
const platforms = ref([])

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** 组装筛选参数：查询与导出共用，保证导出 = 当前页面所见 */
function buildFilterParams() {
  const params = {}
  if (platform.value) params.platform = platform.value
  if (keyword.value) params.keyword = keyword.value
  return params
}

async function loadData(silent) {
  if (!silent) loading.value = true
  const params = { page: page.value, pageSize: pageSize.value, ...buildFilterParams() }
  try {
    const data = await getCustomerPlatformDetail(params)
    records.value = data.records || []
    total.value = data.total || 0
    detailSum.value = data.sumTotal || 0
    snapshotDate.value = data.snapshotDate || null
    if (silent && platforms.value.length === 0) {
      const pl = await getCustomerPlatformList()
      platforms.value = pl.platforms || []
    }
  } catch (err) {
    console.error('[客户平台明细] 加载失败:', err)
    records.value = []
  } finally {
    if (!silent) loading.value = false
  }
}

function openDetail() {
  page.value = 1
  loadData()
}

function resetDetail() {
  platform.value = ''
  keyword.value = ''
  openDetail()
}

/** 导出当前筛选条件下的**全部**行（不受分页限制） */
async function onExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    const filename = `客户平台订单明细_${snapshotDate.value || ''}_${total.value}行.xlsx`
    await exportCustomerPlatformDetail(buildFilterParams(), filename)
    ElMessage.success(`已导出 ${total.value} 行`)
  } catch (err) {
    // 错误提示已由拦截器统一给出（含 blob 错误体解析）
    console.error('[客户平台明细] 导出失败:', err)
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  const pl = await getCustomerPlatformList()
  platforms.value = pl.platforms || []
  await loadData()
})
useAutoRefresh(loadData)
</script>

<style scoped>
.container { padding: 20px; background: #fff; border-radius: 8px; }
.page-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
.main-title { font-size: 22px; margin: 0; color: #303133; }
.sub { font-size: 13px; color: #909399; }
.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.summary-bar { margin-bottom: 12px; font-size: 14px; color: #606266; }
.summary-bar b { color: #303133; }
.summary-bar .amount { color: #f56c6c; font-weight: 700; }
.amount { font-weight: 600; color: #f56c6c; }
.negative { font-weight: 600; color: #67c23a; }
.pagination { margin-top: 16px; display: flex; justify-content: flex-end; }
</style>