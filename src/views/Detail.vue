<template>
  <div class="container">
    <div class="page-header">
      <h1 class="main-title">{{ biz.label }} 明细</h1>
      <div class="header-right">
        <el-tag v-if="snapshotDate" type="info" effect="plain">{{ snapshotDate }}</el-tag>
      </div>
    </div>

    <!-- 筛选栏 -->
    <div class="toolbar">
      <el-select
        v-model="filters.salesperson"
        placeholder="全部业务员"
        clearable
        filterable
        style="width: 160px"
        @change="reload"
      >
        <el-option
          v-for="sp in filterOptions.salespeople"
          :key="sp.name"
          :label="sp.department ? `${sp.name}（${sp.department}）` : sp.name"
          :value="sp.name"
        />
      </el-select>

      <el-select
        v-model="filters.agingCategory"
        placeholder="全部账龄"
        clearable
        style="width: 170px"
        @change="reload"
      >
        <el-option
          v-for="ag in filterOptions.agingCategories"
          :key="ag"
          :label="ag"
          :value="ag"
        />
      </el-select>

      <el-select
        v-model="filters.customer"
        placeholder="全部客户"
        clearable
        filterable
        style="width: 210px"
        @change="reload"
      >
        <el-option v-for="c in filterOptions.customers" :key="c" :label="c" :value="c" />
      </el-select>

      <el-input
        v-model="filters.keyword"
        placeholder="搜单据号 / 客户"
        clearable
        style="width: 175px"
        @keyup.enter="reload"
        @clear="reload"
      />

      <el-date-picker
        v-model="dateRange"
        type="daterange"
        range-separator="至"
        start-placeholder="起始"
        end-placeholder="截止"
        value-format="YYYY-MM-DD"
        style="width: 250px"
        @change="reload"
      />

      <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
      <el-button :icon="RefreshLeft" @click="resetFilters">重置</el-button>
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

    <!-- 汇总条 -->
    <div class="summary-bar">
      <span>共 <b>{{ total }}</b> 条</span>
      <span>金额合计 <b class="amount">{{ fmt(sumTotal) }}</b> 元</span>
      <span v-if="total">第 {{ page }} / {{ totalPages }} 页</span>
    </div>

    <!-- 明细表 -->
    <el-table
      :data="records"
      border
      v-loading="loading"
      style="width: 100%"
      :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
      :row-class-name="rowClass"
      :default-sort="{ prop: sortBy, order: defaultSortOrder }"
      show-summary
      sum-text="本页合计"
      :summary-method="summaryMethod"
      @sort-change="onSortChange"
    >
      <el-table-column prop="docNo" label="单据编号" width="125" align="center" fixed />
      <el-table-column prop="docDate" label="日期" width="110" align="center">
        <template #default="{ row }">
          <span :class="{ 'date-missing': !row.docDate }">
            {{ row.docDate || '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="agingCategory" label="账龄" width="135" align="center">
        <template #default="{ row }">
          <el-tag :type="agingTagType(row.agingCategory)" size="small" effect="dark">
            {{ row.agingCategory }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="customer" label="挂账客户" min-width="190" show-overflow-tooltip />
      <el-table-column prop="salesperson" label="业务员" width="100" align="center" />
      <el-table-column prop="amountTotal" label="金额(元)" width="150" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.amountTotal < 0 ? 'negative' : 'amount'">
            {{ fmt(row.amountTotal) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="over3m" label="3个月以上" width="120" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.over3m < 0 ? 'negative' : ''">{{ row.over3m ? fmt(row.over3m) : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="m3" label="3个月" width="110" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.m3 < 0 ? 'negative' : ''">{{ row.m3 ? fmt(row.m3) : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="m2" label="2个月" width="110" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.m2 < 0 ? 'negative' : ''">{{ row.m2 ? fmt(row.m2) : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="m1" label="1个月" width="110" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.m1 < 0 ? 'negative' : ''">{{ row.m1 ? fmt(row.m1) : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="currentMonth" label="当月" width="110" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.currentMonth < 0 ? 'negative' : ''">
            {{ row.currentMonth ? fmt(row.currentMonth) : '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="note">{{ row.note || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="提醒" width="70" align="center" fixed="right">
        <template #default="{ row }">
          <el-tooltip v-if="row.warning" :content="row.warning" placement="top">
            <el-icon class="warn-icon"><WarningFilled /></el-icon>
          </el-tooltip>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
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
        @size-change="reload"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, watch, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { Search, RefreshLeft, WarningFilled, Download } from '@element-plus/icons-vue'
import { useBizStore } from '@/stores/biz'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import { getDetail, getFilters, exportDetail } from '@/api'

const biz = useBizStore()
const { current } = storeToRefs(biz)

const loading = ref(false)
const exporting = ref(false)
const records = ref([])
const total = ref(0)
const sumTotal = ref(0)
const page = ref(1)
const pageSize = ref(20)
const totalPages = ref(0)
const snapshotDate = ref(null)
const dateRange = ref([])

// 服务端排序：默认按金额降序（与后端默认一致）
const sortBy = ref('amountTotal')
const sortOrder = ref('desc')
const defaultSortOrder = 'descending'

const filters = reactive({
  salesperson: null,
  agingCategory: null,
  customer: null,
  keyword: '',
})

const filterOptions = reactive({
  salespeople: [],
  customers: [],
  agingCategories: [],
})

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// 表尾合计：与源表一致，逐列累加金额类字段
const SUM_PROPS = ['amountTotal', 'over3m', 'm3', 'm2', 'm1', 'currentMonth']

function summaryMethod({ columns, data }) {
  return columns.map((col, i) => {
    if (i === 0) return '本页合计'
    const p = col.property
    if (!SUM_PROPS.includes(p)) return ''
    const sum = data.reduce((s, row) => s + Number(row[p] || 0), 0)
    return fmt(sum)
  })
}

function agingTagType(category) {
  if (category.includes('三个月以上')) return 'danger'
  if (category.includes('三个月')) return 'warning'
  if (category.includes('两个月')) return 'warning'
  if (category.includes('一个月')) return 'primary'
  if (category === '未分类') return 'info'
  return 'success'
}

function rowClass({ row }) {
  return row.warning ? 'warn-row' : ''
}

function onSortChange({ prop, order }) {
  // order: 'ascending' | 'descending' | null（取消排序）
  sortBy.value = prop || 'amountTotal'
  sortOrder.value = order === 'ascending' ? 'asc' : 'desc'
  page.value = 1
  loadData()
}

/**
 * 组装筛选参数。
 * 查询与导出共用同一份，保证「导出 = 当前页面所见」。
 */
function buildFilterParams() {
  const params = {
    sortBy: sortBy.value,
    sortOrder: sortOrder.value,
  }
  if (filters.salesperson) params.salesperson = filters.salesperson
  if (filters.agingCategory) params.agingCategory = filters.agingCategory
  if (filters.customer) params.customer = filters.customer
  if (filters.keyword) params.keyword = filters.keyword
  if (dateRange.value?.length === 2) {
    params.from = dateRange.value[0]
    params.to = dateRange.value[1]
  }
  return params
}

async function loadData(silent) {
  if (!silent) loading.value = true
  try {
    const data = await getDetail(current.value, {
      page: page.value,
      pageSize: pageSize.value,
      ...buildFilterParams(),
    })
    records.value = data.records || []
    total.value = data.total || 0
    sumTotal.value = data.sumTotal || 0
    totalPages.value = data.totalPages || 0
    snapshotDate.value = data.snapshotDate || null
  } catch (err) {
    console.error('[Detail] 加载失败:', err)
    records.value = []
    total.value = 0
  } finally {
    if (!silent) loading.value = false
  }
}

/** 导出当前筛选条件下的**全部**行（不受分页限制） */
async function onExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    const label = biz.label || '台账'
    const datePart = snapshotDate.value || ''
    const filename = `${label}明细_${datePart}_${total.value}行.xlsx`
    await exportDetail(current.value, buildFilterParams(), filename)
    ElMessage.success(`已导出 ${total.value} 行`)
  } catch (err) {
    // 错误提示已由拦截器统一给出（含 blob 错误体解析）
    console.error('[Detail] 导出失败:', err)
  } finally {
    exporting.value = false
  }
}

function reload() {
  page.value = 1
  loadData()
}

function resetFilters() {
  filters.salesperson = null
  filters.agingCategory = null
  filters.customer = null
  filters.keyword = ''
  dateRange.value = []
  sortBy.value = 'amountTotal'
  sortOrder.value = 'desc'
  reload()
}

async function loadFilters() {
  try {
    const data = await getFilters(current.value)
    Object.assign(filterOptions, data)
  } catch (err) {
    console.error('[Detail] 筛选选项加载失败:', err)
  }
}

async function refresh() {
  resetFilters()
  await loadFilters()
  await loadData()
}

watch(current, refresh)
onMounted(async () => {
  await loadFilters()
  await loadData()
})
useAutoRefresh(loadData)
</script>

<style scoped>
.container { padding: 20px; background: #fff; border-radius: 8px; }
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 18px;
}
.main-title { font-size: 24px; margin: 0; color: #303133; }
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 14px;
  background: #fafafa;
  border-radius: 6px;
}
.summary-bar {
  display: flex;
  gap: 24px;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
  color: #606266;
}
.summary-bar b { color: #303133; font-size: 15px; }
.summary-bar .amount { color: #f56c6c; font-weight: 700; }
.amount { font-weight: 600; color: #f56c6c; }
.negative { font-weight: 600; color: #67c23a; }
.note { color: #909399; font-size: 13px; }
.date-missing { color: #c0c4cc; }
.muted { color: #dcdfe6; }
.warn-icon { color: #e6a23c; font-size: 16px; cursor: help; }
.pagination { margin-top: 18px; display: flex; justify-content: flex-end; }
:deep(.warn-row) { background-color: #fdf6ec; }
/* 表尾合计行：与表头呼应，便于核对总额与各账龄分档 */
:deep(.el-table__footer-wrapper td) {
  background: #f5f7fa;
  font-weight: 700;
  color: #303133;
}
</style>
