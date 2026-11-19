<template>
  <div class="container">
    <!-- 2026-11-19 使用者定案：
         · 这一页**只留明细**，不要汇总卡、不要顶部筛选行
         · 不要「开票方案数」列
         · 每一列都要能筛选
         · 每天的变化记录起来（「较昨日」列 + 后台日快照表） -->

    <!-- 明细 -->
    <el-card shadow="never" class="block-card">
      <template #header>
        <span class="card-title">客户明细（{{ rows.length }}）</span>
        <span class="card-hint">
          数据来自利润管控系统（每天自动取数后汇总）；「较昨日」对比每日快照
        </span>
        <el-button size="small" class="card-btn" @click="clearTableFilters">清除列筛选</el-button>
      </template>
      <el-table
        ref="tableRef"
        :data="rows"
        border
        size="small"
        max-height="640"
        :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
        :cell-style="{ padding: '6px 0' }"
      >
        <!-- 客户 -->
        <el-table-column
          prop="customer_name"
          label="挂账客户"
          min-width="220"
          fixed="left"
          show-overflow-tooltip
          :filters="customerFilters"
          :filter-method="filterCustomer"
          filter-placement="bottom-end"
        />

        <!-- 部门 -->
        <el-table-column
          prop="dept"
          label="部门"
          width="115"
          show-overflow-tooltip
          :filters="deptFilters"
          :filter-method="filterDept"
          filter-placement="bottom-end"
        />

        <!-- 业务员 -->
        <el-table-column
          prop="salesperson"
          label="业务员"
          width="100"
          show-overflow-tooltip
          :filters="salesmanFilters"
          :filter-method="filterSalesman"
          filter-placement="bottom-end"
        />

        <!-- 合同数 -->
        <el-table-column
          prop="contract_count"
          label="合同数"
          width="90"
          align="right"
          :filters="countFilters"
          :filter-method="filterCount('contract_count')"
          filter-placement="bottom-end"
        />

        <!-- 实际出库金额 -->
        <el-table-column
          prop="ship_amount"
          label="实际出库金额"
          width="140"
          align="right"
          :filters="amountFilters"
          :filter-method="filterAmount('ship_amount')"
          filter-placement="bottom-end"
        >
          <template #default="{ row }"><span class="mx-amt">{{ num(row.ship_amount) }}</span></template>
        </el-table-column>

        <!-- 已发货未开票 -->
        <el-table-column
          prop="uninvoiced_amount"
          label="已发货未开票"
          width="150"
          align="right"
          :filters="amountFilters"
          :filter-method="filterAmount('uninvoiced_amount')"
          filter-placement="bottom-end"
        >
          <template #default="{ row }">
            <span class="mx-amt">{{ num(row.uninvoiced_amount) }}</span>
            <span class="mx-sub">{{ row.uninvoiced_count || 0 }} 单</span>
          </template>
        </el-table-column>

        <!-- 开票金额 -->
        <el-table-column
          prop="invoiced_amount"
          label="开票金额"
          width="140"
          align="right"
          :filters="amountFilters"
          :filter-method="filterAmount('invoiced_amount')"
          filter-placement="bottom-end"
        >
          <template #default="{ row }"><span class="mx-amt">{{ num(row.invoiced_amount) }}</span></template>
        </el-table-column>

        <!-- 回款金额 -->
        <el-table-column
          prop="paid_amount"
          label="回款金额"
          width="140"
          align="right"
          :filters="amountFilters"
          :filter-method="filterAmount('paid_amount')"
          filter-placement="bottom-end"
        >
          <template #default="{ row }"><span class="mx-amt">{{ num(row.paid_amount) }}</span></template>
        </el-table-column>

        <!-- 已开票未回款 -->
        <el-table-column
          prop="unpaid_amount"
          label="已开票未回款"
          width="150"
          align="right"
          :filters="amountFilters"
          :filter-method="filterAmount('unpaid_amount')"
          filter-placement="bottom-end"
        >
          <template #default="{ row }">
            <span class="mx-amt">{{ num(row.unpaid_amount) }}</span>
            <span class="mx-sub">{{ row.unpaid_count || 0 }} 单</span>
          </template>
        </el-table-column>

        <!-- 合计应收 -->
        <el-table-column
          prop="total_receivable"
          label="合计应收"
          width="150"
          align="right"
          :filters="amountFilters"
          :filter-method="filterAmount('total_receivable')"
          filter-placement="bottom-end"
        >
          <template #default="{ row }"><span class="mx-amt strong">{{ num(row.total_receivable) }}</span></template>
        </el-table-column>

        <!-- 较昨日变化（每天的快照对比，2026-11-19 使用者要求「每天的变化记录起来」） -->
        <el-table-column
          prop="diff_total"
          label="较昨日"
          width="135"
          align="right"
          :filters="diffFilters"
          :filter-method="filterDiff"
          filter-placement="bottom-end"
        >
          <template #default="{ row }">
            <span v-if="row.is_new_customer" class="mx-new">新增</span>
            <span
              v-else-if="Math.abs(Number(row.diff_total || 0)) < 0.005"
              class="mx-zero"
            >—</span>
            <span v-else class="mx-diff" :class="Number(row.diff_total) > 0 ? 'mx-up' : 'mx-down'">
              {{ Number(row.diff_total) > 0 ? '+' : '' }}{{ num(row.diff_total) }}
            </span>
          </template>
        </el-table-column>

        <!-- 8 个产品线 -->
        <el-table-column
          v-for="p in productLineMeta"
          :key="p.key"
          :prop="p.key"
          :label="p.label"
          width="125"
          align="right"
          :filters="productFilters"
          :filter-method="filterProduct(p.key)"
          filter-placement="bottom-end"
        >
          <template #default="{ row }">
            <span v-if="Number(row[p.key] || 0) !== 0" class="mx-amt">{{ num(row[p.key]) }}</span>
            <span v-else class="mx-zero">—</span>
          </template>
        </el-table-column>

        <!-- 销售反馈（可编辑） -->
        <el-table-column
          label="销售反馈"
          min-width="290"
          :filters="feedbackFilters"
          :filter-method="filterFeedback"
          filter-placement="bottom-end"
        >
          <template #default="{ row }">
            <el-input
              v-if="canEditDetail && editingKey === row.customer_name"
              ref="noteInputs"
              v-model="editValue"
              type="textarea"
              :rows="1"
              :autosize="{ minRows: 1, maxRows: 4 }"
              placeholder="填写进度反馈（Enter 保存，Esc 取消）"
              @blur="saveNote(row)"
              @keydown.enter.prevent="saveNote(row)"
              @keydown.esc.stop="cancelNote"
            />
            <div v-else class="fb-list">
              <div class="fb-item" :class="{ 'fb-edit': canEditDetail }" @click="startEdit(row)">
                <el-tag size="small" type="success" effect="plain">反馈</el-tag>
                <el-tooltip v-if="row.board_note" :content="row.board_note" placement="top" :show-after="300">
                  <span class="fb-text">{{ row.board_note }}</span>
                </el-tooltip>
                <span v-else class="fb-text fb-muted">{{ canEditDetail ? '点击填写进度' : '未填写' }}</span>
                <span v-if="row.board_note_at" class="mx-sub">{{ fmtTime(row.board_note_at) }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { getCustomerDebt, updateDetailNote } from '@/api'
import { useAuth } from '@/composables/useAuth'

const { canEditDetail } = useAuth()

const summary = ref(null)
const productLineMeta = ref([])
const rows = ref([])
const depts = ref([])
const tableRef = ref(null)

// ====== 进度反馈就地编辑（与「明细查询」「我的业绩」同一套交互）======
// 键用客户名（本页是客户级，没有行 id）；存库仍按 **单据号**
// （detail_note 主键是 biz_type + doc_no，后端已给出该客户的代表单据号）。
const editingKey = ref(null)
const editValue = ref('')
const noteInputs = ref([])

function startEdit(row) {
  if (!canEditDetail.value) return
  editingKey.value = row.customer_name
  editValue.value = row.board_note || ''
  nextTick(() => {
    const el = noteInputs.value && noteInputs.value[0]
    if (el && el.focus) el.focus()
  })
}

function cancelNote() {
  editingKey.value = null
  editValue.value = ''
}

/** 保存：写库成功才改行上的值；失败回退原值（不留下「看着存了其实没存」的假象） */
async function saveNote(row) {
  if (editingKey.value !== row.customer_name) return
  const value = editValue.value.trim()
  const original = row.board_note || ''
  cancelNote()
  if (value === original) return
  if (!row.note_doc_no) {
    ElMessage.warning('该客户在最新批次里找不到单据号，无法保存')
    return
  }
  try {
    await updateDetailNote(row.note_biz_type, row.note_doc_no, value)
    row.board_note = value || null
    row.board_note_at = new Date().toISOString()
    ElMessage.success('进度反馈已保存')
  } catch (err) {
    row.board_note = original
    console.error('[客户欠款] 保存反馈失败:', err)
    ElMessage.error('保存失败')
  }
}

// ====== 列筛选器（每一列都有）======
const ALL = { text: '全部', value: 'all' }

/** 金额列：0 / 非 0 / 10万 / 50万 / 100万 */
const amountFilters = [
  ALL,
  { text: '无（0）', value: 'zero' },
  { text: '有金额', value: 'nonzero' },
  { text: '≥ 10 万', value: 'w10' },
  { text: '≥ 50 万', value: 'w50' },
  { text: '≥ 100 万', value: 'w100' },
]
function filterAmount(field) {
  return ({ row, value }) => {
    const n = Number(row[field] || 0)
    if (value === 'zero') return n === 0
    if (value === 'nonzero') return n !== 0
    if (value === 'w10') return n >= 100000
    if (value === 'w50') return n >= 500000
    if (value === 'w100') return n >= 1000000
    return true
  }
}

/** 整数列（合同数 / 开票方案数） */
const countFilters = [
  ALL,
  { text: '无（0）', value: 'zero' },
  { text: '有', value: 'nonzero' },
  { text: '≥ 3', value: 'c3' },
  { text: '≥ 10', value: 'c10' },
]
function filterCount(field) {
  return ({ row, value }) => {
    const n = Number(row[field] || 0)
    if (value === 'zero') return n === 0
    if (value === 'nonzero') return n > 0
    if (value === 'c3') return n >= 3
    if (value === 'c10') return n >= 10
    return true
  }
}

/** 产品线列：0 / 非 0 / 10万 / 50万 */
const productFilters = [
  ALL,
  { text: '无（0）', value: 'zero' },
  { text: '有金额', value: 'nonzero' },
  { text: '≥ 10 万', value: 'w10' },
  { text: '≥ 50 万', value: 'w50' },
]
function filterProduct(field) {
  return ({ row, value }) => {
    const n = Number(row[field] || 0)
    if (value === 'zero') return n === 0
    if (value === 'nonzero') return n !== 0
    if (value === 'w10') return n >= 100000
    if (value === 'w50') return n >= 500000
    return true
  }
}

/** 客户列 */
const customerFilters = [
  ALL,
  { text: '有未回款', value: 'unpaid' },
  { text: '无未回款', value: 'nounpaid' },
  { text: '有未开票', value: 'uninvoiced' },
]
function filterCustomer({ row, value }) {
  if (value === 'unpaid') return Number(row.unpaid_amount || 0) > 0
  if (value === 'nounpaid') return Number(row.unpaid_amount || 0) === 0
  if (value === 'uninvoiced') return Number(row.uninvoiced_amount || 0) > 0
  return true
}

/** 部门 / 业务员：按当前数据动态生成选项 */
function distinctFilters(field) {
  return computed(() => {
    const set = new Set()
    rows.value.forEach((r) => {
      const v = (r[field] || '').trim()
      if (v) set.add(v)
    })
    return [ALL, ...[...set].sort().map((v) => ({ text: v, value: v }))]
  })
}
const deptFilters = distinctFilters('dept')
const salesmanFilters = distinctFilters('salesperson')
function matchField(field) {
  return ({ row, value }) => (value === 'all' ? true : (row[field] || '') === value)
}
const filterDept = matchField('dept')
const filterSalesman = matchField('salesperson')

/** 销售反馈 */
const feedbackFilters = [
  ALL,
  { text: '有反馈', value: 'any' },
  { text: '无反馈', value: 'none' },
]
function filterFeedback({ row, value }) {
  if (value === 'any') return !!row.board_note
  if (value === 'none') return !row.board_note
  return true
}

/** 「较昨日」列 */
const diffFilters = [
  ALL,
  { text: '有变化', value: 'changed' },
  { text: '无变化', value: 'same' },
  { text: '金额增加', value: 'up' },
  { text: '金额减少', value: 'down' },
  { text: '新增客户', value: 'new' },
]
function filterDiff({ row, value }) {
  const d = Number(row.diff_total || 0)
  if (value === 'changed') return row.is_new_customer || Math.abs(d) >= 0.005
  if (value === 'same') return !row.is_new_customer && Math.abs(d) < 0.005
  if (value === 'up') return !row.is_new_customer && d >= 0.005
  if (value === 'down') return !row.is_new_customer && d <= -0.005
  if (value === 'new') return !!row.is_new_customer
  return true
}

/** 一键清掉所有列筛选（表头那些 ▼ 的选中项） */
function clearTableFilters() {
  const t = tableRef.value
  if (!t) return
  t.clearFilter()
  ElMessage.success('已清除列筛选')
}

/** 金额千分位；空值显示 — */
function num(v) {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtTime(s) {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function load() {
  try {
    const d = await getCustomerDebt()
    summary.value = d.summary
    productLineMeta.value = d.productLineMeta || []
    rows.value = d.rows || []
    depts.value = d.depts || []
  } catch (e) {
    // 静默：保留上次数据
  }
}

onMounted(load)
</script>

<style scoped>
.sum-row { margin-bottom: 12px; }
.sum-card :deep(.el-card__body) { padding: 14px 16px; }
.sum-label { font-size: 12px; color: #909399; }
.sum-value {
  font-size: 22px;
  font-weight: 500;
  color: #2c3e50;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.sum-sub { font-size: 12px; color: #a8abb2; margin-top: 4px; }

.filter-card { margin-bottom: 12px; }
.filter-card :deep(.el-card__body) {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.filter-tip { font-size: 12px; color: #a8abb2; }

.block-card { margin-bottom: 12px; }
.card-title { font-weight: 500; color: #2c3e50; }
.card-hint { font-size: 12px; color: #a8abb2; margin-left: 10px; }

.mx-amt { font-variant-numeric: tabular-nums; }
.mx-amt.strong { font-weight: 500; color: #2c3e50; }
.mx-sub { font-size: 11px; color: #a8abb2; margin-left: 6px; }
.mx-zero { color: #c0c4cc; }
.mx-diff { font-variant-numeric: tabular-nums; }
.mx-up { color: #cf1322; }
.mx-down { color: #389e0d; }
.mx-new {
  display: inline-block;
  padding: 0 6px;
  border-radius: 4px;
  background: #e6f4ff;
  color: #1677ff;
  font-size: 11px;
}
.card-btn { margin-left: 12px; }

.fb-list { display: flex; flex-direction: column; gap: 2px; padding: 2px 0; }
.fb-item { display: flex; align-items: baseline; gap: 6px; line-height: 1.6; }
.fb-item.fb-edit { cursor: pointer; }
.fb-item.fb-edit:hover .fb-text { color: #409eff; text-decoration: underline; }
.fb-text {
  font-size: 12px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.fb-muted { color: #c0c4cc; }
</style>
