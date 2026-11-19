<template>
  <div class="container">
    <!-- 2026-11-19 使用者定案：这一页不要页头、不要产品线分布表，只要明细 -->
    <!-- 汇总 -->
    <el-row :gutter="12" class="sum-row">
      <el-col v-for="c in sumCards" :key="c.label" :span="6">
        <el-card shadow="never" class="sum-card">
          <div class="sum-label">{{ c.label }}</div>
          <div class="sum-value">{{ num(c.value) }}</div>
          <div v-if="c.sub" class="sum-sub">{{ c.sub }}</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 筛选 -->
    <el-card shadow="never" class="filter-card no-export">
      <el-input
        v-model="q"
        placeholder="客户名"
        clearable
        style="width:200px"
        @keyup.enter="load"
        @clear="load"
      />
      <el-select v-model="dept" placeholder="全部部门" clearable style="width:140px" @change="load">
        <el-option v-for="d in depts" :key="d" :label="d" :value="d" />
      </el-select>
      <el-button size="small" :type="onlyUnpaid ? 'primary' : ''" @click="toggleOnly">
        {{ onlyUnpaid ? '✓ ' : '' }}只看有未回款
      </el-button>
      <el-button size="small" @click="load">刷新</el-button>
      <span class="filter-tip">表头右侧 ▼ 可按「逾期」「金额」「销售反馈」筛选</span>
    </el-card>

    <!-- 明细 -->
    <el-card shadow="never" class="block-card">
      <template #header>
        <span class="card-title">客户明细（{{ rows.length }}）</span>
        <span class="card-hint">
          反馈合并：看板「进度反馈」（可点开填写）＋ 源表 Excel「沟通回款进度」
        </span>
      </template>
      <el-table
        :data="rows"
        border
        size="small"
        max-height="640"
        :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
        :cell-style="{ padding: '6px 0' }"
      >
        <el-table-column prop="customer_name" label="挂账客户" min-width="220" fixed="left" show-overflow-tooltip />
        <el-table-column prop="dept" label="部门" width="110" show-overflow-tooltip />
        <el-table-column prop="salesperson" label="业务员" width="95" show-overflow-tooltip />

        <el-table-column label="已发货未开票" width="150" align="right">
          <template #default="{ row }">
            <span class="mx-amt">{{ num(row.uninvoiced_amount) }}</span>
            <span class="mx-sub">{{ row.uninvoiced_count || 0 }} 单</span>
          </template>
        </el-table-column>
        <el-table-column label="已开票未回款" width="150" align="right">
          <template #default="{ row }">
            <span class="mx-amt">{{ num(row.unpaid_amount) }}</span>
            <span class="mx-sub">{{ row.unpaid_count || 0 }} 单</span>
          </template>
        </el-table-column>
        <el-table-column
          label="其中 3 个月以上"
          width="140"
          align="right"
          :filters="overdueFilters"
          :filter-method="filterOverdue"
          filter-placement="bottom-end"
        >
          <template #default="{ row }">
            <span
              class="mx-amt"
              :class="{ 'mx-danger': Number(row.unpaid_over3m || 0) + Number(row.uninvoiced_over3m || 0) > 0 }"
            >
              {{ num((row.unpaid_over3m || 0) + (row.uninvoiced_over3m || 0)) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column
          prop="total_receivable"
          label="合计应收"
          width="145"
          align="right"
          :filters="amountFilters"
          :filter-method="filterAmount"
          filter-placement="bottom-end"
        >
          <template #default="{ row }"><span class="mx-amt strong">{{ num(row.total_receivable) }}</span></template>
        </el-table-column>

        <el-table-column
          v-for="p in productLineMeta"
          :key="p.key"
          :prop="p.key"
          :label="p.label"
          width="125"
          align="right"
        >
          <template #default="{ row }">
            <span v-if="Number(row[p.key] || 0) !== 0" class="mx-amt">{{ num(row[p.key]) }}</span>
            <span v-else class="mx-zero">—</span>
          </template>
        </el-table-column>

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
                <el-tag size="small" type="success" effect="plain">看板</el-tag>
                <el-tooltip v-if="row.board_note" :content="row.board_note" placement="top" :show-after="300">
                  <span class="fb-text">{{ row.board_note }}</span>
                </el-tooltip>
                <span v-else class="fb-text fb-muted">{{ canEditDetail ? '点击填写进度反馈' : '未填写' }}</span>
                <span v-if="row.board_note_at" class="mx-sub">{{ fmtTime(row.board_note_at) }}</span>
              </div>
              <div v-if="row.excel_progress" class="fb-item">
                <el-tag size="small" type="warning" effect="plain">源表</el-tag>
                <el-tooltip :content="row.excel_progress" placement="top" :show-after="300">
                  <span class="fb-text">{{ row.excel_progress }}</span>
                </el-tooltip>
              </div>
              <div v-if="row.excel_remark" class="fb-item">
                <el-tag size="small" type="info" effect="plain">备注</el-tag>
                <el-tooltip :content="row.excel_remark" placement="top" :show-after="300">
                  <span class="fb-text">{{ row.excel_remark }}</span>
                </el-tooltip>
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

const q = ref('')
const dept = ref('')
const onlyUnpaid = ref(false)

const summary = ref(null)
const productLineMeta = ref([])
const rows = ref([])
const depts = ref([])

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

// ====== 表头列筛选 ======
const overdueFilters = [
  { text: '全部', value: 'all' },
  { text: '有 3 个月以上逾期', value: 'overdue' },
  { text: '无逾期', value: 'none' },
]
function filterOverdue({ row, value }) {
  const over = Number(row.unpaid_over3m || 0) + Number(row.uninvoiced_over3m || 0)
  if (value === 'overdue') return over > 0
  if (value === 'none') return over <= 0
  return true
}

const amountFilters = [
  { text: '全部', value: 'all' },
  { text: '≥ 10 万', value: '10' },
  { text: '≥ 50 万', value: '50' },
  { text: '≥ 100 万', value: '100' },
]
function filterAmount({ row, value }) {
  if (value === 'all') return true
  const w = Number(value || 0) * 10000
  return Number(row.total_receivable || 0) >= w
}

const feedbackFilters = [
  { text: '全部', value: 'all' },
  { text: '有反馈', value: 'any' },
  { text: '无反馈', value: 'none' },
  { text: '仅看板填了', value: 'board' },
  { text: '仅源表填了', value: 'excel' },
]
function filterFeedback({ row, value }) {
  const b = !!row.board_note
  const e = !!row.excel_progress || !!row.excel_remark
  if (value === 'any') return b || e
  if (value === 'none') return !b && !e
  if (value === 'board') return b && !e
  if (value === 'excel') return e && !b
  return true
}

const sumCards = computed(() => {
  const s = summary.value
  if (!s) return []
  return [
    { label: '合计应收（元）', value: s.totalReceivable, sub: `${s.customerCount} 个客户` },
    { label: '已发货未开票（元）', value: s.uninvoicedAmount, sub: '货已发、票未开' },
    { label: '已开票未回款（元）', value: s.unpaidAmount, sub: `其中 3 个月以上 ${num(s.unpaidOver3m)}` },
    {
      label: '有销售反馈的客户',
      value: s.withFeedback,
      sub: `产品线已匹配 ${s.matchedProduct} 家`,
    },
  ]
})

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

function toggleOnly() {
  onlyUnpaid.value = !onlyUnpaid.value
  load()
}

async function load() {
  const params = {}
  if (q.value) params.q = q.value
  if (dept.value) params.dept = dept.value
  if (onlyUnpaid.value) params.only = 'unpaid'
  try {
    const d = await getCustomerDebt(params)
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
.mx-amt.mx-danger { color: #cf1322; }
.mx-sub { font-size: 11px; color: #a8abb2; margin-left: 6px; }
.mx-zero { color: #c0c4cc; }

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
