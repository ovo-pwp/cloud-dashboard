<template>
  <div class="container">
    <PageHeader :title="`${biz.label} 明细`">
      <template #meta>
        <el-tag v-if="snapshotDate" class="snapshot-tag" type="info" effect="plain">
          数据日期 {{ snapshotDate }}
        </el-tag>
      </template>
    </PageHeader>

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
        v-if="hasCity"
        v-model="filters.city"
        placeholder="全部城市"
        clearable
        filterable
        style="width: 130px"
        @change="reload"
      >
        <el-option v-for="c in filterOptions.cities" :key="c" :label="c" :value="c" />
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
      <!-- 导出对管理员和成员都开放；将来若有「不能导出」的角色，这里会自动置灰 -->
      <el-tooltip :disabled="canExport" content="当前账号没有导出权限，请联系管理员" placement="top">
        <span class="export-wrap">
          <el-button
            type="success"
            plain
            :icon="Download"
            :loading="exporting"
            :disabled="!total || !canExport"
            @click="onExport"
          >
            {{ exporting ? '导出中…' : '导出 Excel' }}
          </el-button>
        </span>
      </el-tooltip>
    </div>

    <!-- 汇总条：只保留「筛选全量」这一个口径，与表尾合计一致；
         原来这里并排放着「金额合计（筛选全量）」和表尾「本页合计」两个不同数字，
         同一屏两个合计会让人怀疑系统算得不准 -->
    <div class="summary-bar">
      <span>共 <b>{{ total }}</b> 条</span>
      <span>金额合计（筛选全量）<b class="amount">{{ fmt(sumTotal) }}</b> 元</span>
      <span v-if="total">第 {{ page }} / {{ totalPages }} 页，每页 {{ pageSize }} 条</span>
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
      sum-text="筛选合计"
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
      <el-table-column prop="agingCategory" label="账龄" width="135" align="center" sortable="custom">
        <template #default="{ row }">
          <el-tag :type="agingTagType(row.agingCategory)" size="small" effect="dark">
            {{ row.agingCategory }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="customer" label="挂账客户" min-width="190" show-overflow-tooltip />
      <el-table-column prop="salesperson" label="业务员" width="100" align="center" />
      <!-- 地区（=源表「地址」归一化到市）只有「已开票未回款」的源表有，未开票不显示这列，免得整列都是空的 -->
      <el-table-column v-if="hasCity" prop="city" label="地区" width="90" align="center">
        <template #default="{ row }">
          <span :class="{ 'date-missing': !row.city }">{{ row.city || '—' }}</span>
        </template>
      </el-table-column>
      <!-- 行系（工行/中行/建行…）与地区相反：只有「已发货未开票」的源表有 -->
      <el-table-column v-if="hasRowSystem" prop="rowSystem" label="行系" width="110" align="center">
        <template #default="{ row }">
          <span :class="{ 'date-missing': !row.rowSystem }">{{ row.rowSystem || '—' }}</span>
        </template>
      </el-table-column>
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
      <el-table-column prop="m3" label="3个月" width="120" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.m3 < 0 ? 'negative' : ''">{{ row.m3 ? fmt(row.m3) : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="m2" label="2个月" width="120" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.m2 < 0 ? 'negative' : ''">{{ row.m2 ? fmt(row.m2) : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="m1" label="1个月" width="120" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.m1 < 0 ? 'negative' : ''">{{ row.m1 ? fmt(row.m1) : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="currentMonth" label="当月" width="120" align="right" sortable="custom">
        <template #default="{ row }">
          <span :class="row.currentMonth < 0 ? 'negative' : ''">
            {{ row.currentMonth ? fmt(row.currentMonth) : '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="进度反馈" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">
          <!-- 管理员与成员都能点进入编辑 -->
          <el-input
            v-if="canEditDetail && editingId === row.id"
            ref="noteInputs"
            v-model="editValue"
            type="textarea"
            :rows="1"
            :autosize="{ minRows: 1, maxRows: 4 }"
            placeholder="填写进度反馈（Enter 保存，Esc 取消）"
            @blur="saveNote(row)"
            @keydown.enter.prevent="saveNote(row)"
            @keydown.esc.stop="cancelNote(row)"
          />
          <template v-else>
            <span
              class="note"
              :class="{ 'note-editable': canEditDetail }"
              :title="canEditDetail ? '点击修改进度反馈' : ''"
              @click="startEdit(row)"
            >
              {{ row.note || '—' }}
            </span>
          </template>
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
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { Search, RefreshLeft, Download } from '@element-plus/icons-vue'
import { useBizStore } from '@/stores/biz'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import { useAuth } from '@/composables/useAuth'
import { getDetail, getFilters, exportDetail, updateDetailNote } from '@/api'
import PageHeader from '@/components/PageHeader.vue'

const biz = useBizStore()
const { current } = storeToRefs(biz)
// canExport 管「导出 Excel」，canEditDetail 管「改明细上的人工字段（备注）」
// ——两者目前都含成员，但各自命名，将来单独收紧某一项时不用回头改另一处
const { canExport, canEditDetail } = useAuth()

const loading = ref(false)
const exporting = ref(false)
const records = ref([])
const total = ref(0)
const sumTotal = ref(0)
// 全量分列合计（后端返回）：表尾用它，与汇总条同口径
const sumColumns = ref({})
const page = ref(1)
const pageSize = ref(20)
const totalPages = ref(0)
const snapshotDate = ref(null)
const dateRange = ref([])

// 备注行内编辑：editingId 标记正在编辑的行，editValue 存输入框暂存值
const editingId = ref(null)
const editValue = ref('')

// 服务端排序：默认按「账龄」老 → 新（3个月以上 在前），与后端默认一致。
// 同档内的次序由后端补 amount_total DESC，前端不用管。
const sortBy = ref('agingCategory')
const sortOrder = ref('asc')
const defaultSortOrder = 'ascending'

const filters = reactive({
  salesperson: null,
  agingCategory: null,
  customer: null,
  city: null,
  keyword: '',
})

const filterOptions = reactive({
  salespeople: [],
  customers: [],
  agingCategories: [],
  cities: [],
  rowSystems: [],
})

// 城市列只有「已开票未回款」有数据；未开票不显示这一列与筛选项
const hasCity = computed(() => (filterOptions.cities || []).length > 0)
// 行系同理：只有「已发货未开票」源表有这列，那条线才有值，否则整列是空就不显示
const hasRowSystem = computed(() => (filterOptions.rowSystems || []).length > 0)

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// 表尾合计：与源表一致，逐列累加金额类字段
//
// 口径说明（重要，别再改回按本页算）：
//   这里显示的是**当前筛选条件下的全量合计**（后端 sumColumns），不是本页 20 行的合计。
//   原因：同一屏上原本并排放着「金额合计（筛选全量）」和「本页合计」两个不同数字，
//   看的人没法判断哪个是真的。现在统一成一个口径：表尾 = 筛选全量 = 汇总条那个数。
const SUM_PROPS = ['amountTotal', 'over3m', 'm3', 'm2', 'm1', 'currentMonth']

function summaryMethod({ columns }) {
  return columns.map((col, i) => {
    if (i === 0) return '筛选合计'
    const p = col.property
    if (!SUM_PROPS.includes(p)) return i === columns.length - 1 ? `共 ${total.value} 条` : ''
    return fmt(sumColumns.value[p])
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
  // order: 'ascending' | 'descending' | null（取消排序 → 回到默认的账龄排序）
  if (!prop || !order) {
    sortBy.value = 'agingCategory'
    sortOrder.value = 'asc'
  } else {
    sortBy.value = prop
    sortOrder.value = order === 'ascending' ? 'asc' : 'desc'
  }
  page.value = 1
  loadData()
}

// 备注输入框引用（编辑态每次只渲染一行）
const noteInputs = ref([])

/**
 * 聚焦某个编辑框。
 *
 * 为什么不能直接写 `ref.value?.[0]?.focus()`：
 *   同一时刻只有一行在编辑，这个 ref **不在 v-for 里**，Vue 赋给它的就是
 *   ElInput 组件实例本身（不是数组）。`实例[0]` 是 undefined → `.focus()` 被静默跳过，
 *   表现就是「输入框弹出来了，但光标不在里面，得再点一下才能打字」。
 *   两种形态都兜住，免得以后把它挪进 v-for 又反过来失效。
 */
function focusEditor(r) {
  const el = Array.isArray(r.value) ? r.value[0] : r.value
  el?.focus?.()
}

/** 进入备注编辑态 */
function startEdit(row) {
  if (!canEditDetail.value) return
  editingId.value = row.id
  editValue.value = row.note || ''
  nextTick(() => focusEditor(noteInputs))
}

/** 取消编辑（不保存） */
function cancelNote(row) {
  if (editingId.value !== row.id) return
  editingId.value = null
  editValue.value = ''
}

/** 保存备注：写库成功才更新行；失败回退原值 */
async function saveNote(row) {
  if (editingId.value !== row.id) return
  const value = editValue.value.trim()
  const original = row.note || ''
  editingId.value = null
  editValue.value = ''
  if (value === original) return
  try {
    await updateDetailNote(current.value, row.docNo, value)
    row.note = value || null
    ElMessage.success('进度反馈已保存')
  } catch (err) {
    row.note = original
    console.error('[Detail] 保存备注失败:', err)
  }
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
  if (filters.city) params.city = filters.city
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
    sumColumns.value = data.sumColumns || {}
    totalPages.value = data.totalPages || 0
    snapshotDate.value = data.snapshotDate || null
  } catch (err) {
    console.error('[Detail] 加载失败:', err)
    records.value = []
    total.value = 0
    sumTotal.value = 0
    sumColumns.value = {}
  } finally {
    if (!silent) loading.value = false
  }
}

/** 导出当前筛选条件下的**全部**行（不受分页限制） */
async function onExport() {
  if (exporting.value) return
  if (!canExport.value) {
    ElMessage.warning('当前账号没有导出权限，请联系管理员')
    return
  }
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
  filters.city = null
  filters.keyword = ''
  dateRange.value = []
  sortBy.value = 'agingCategory'
  sortOrder.value = 'asc'
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
/* 头部已交给 PageHeader 组件统一 */
/* 置灰按钮不触发鼠标事件，tooltip 得靠外面这层 span 接住悬停 */
.export-wrap { display: inline-block; }
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
.note-editable { color: #606266; cursor: pointer; }
.note-editable:hover { color: #409eff; text-decoration: underline; }
.date-missing { color: #c0c4cc; }
.pagination { margin-top: 18px; display: flex; justify-content: flex-end; }
/* 数据质量异常的行整行浅黄标记（原「提醒」列已移除，这里保留这层提示） */
:deep(.warn-row) { background-color: #fdf6ec; }
/* 表尾合计行：与表头呼应，便于核对总额与各账龄分档 */
:deep(.el-table__footer-wrapper td) {
  background: #f5f7fa;
  font-weight: 700;
  color: #303133;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .container { padding: 10px; }
  /* 头部字号/间距由 PageHeader 组件自己处理 */

  .toolbar { flex-wrap: wrap; gap: 8px; padding: 10px; }
  .toolbar .el-select,
  .toolbar .el-input { width: 140px !important; }
  .toolbar .el-button { flex: 1; }

  .summary-bar { flex-wrap: wrap; gap: 8px; }

  :deep(.el-table) { font-size: 11px; min-width: 600px; }
  :deep(.el-table th),
  :deep(.el-table td) { padding: 6px 4px !important; }

  .pagination { justify-content: center; }
}
</style>
