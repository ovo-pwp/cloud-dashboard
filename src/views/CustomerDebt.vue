<template>
  <div class="container">
    <!-- 2026-11-19 使用者定案：
         · 这一页只留明细，不要汇总卡
         · 不要「开票方案数」列
         · 销售直接在看板里填进度，Excel 不再同步
         · 筛选换形式：不用表头小三角弹层，改成标题栏上**一排可见的下拉**（2026-11-19）
         · 每天的变化记录起来（「较昨日」列 + 后台日快照表） -->

    <el-card shadow="never" class="block-card">
      <template #header>
        <div class="card-head">
          <span class="card-title">
            客户明细（{{ filteredRows.length }}<template v-if="filteredRows.length !== rows.length"> / {{ rows.length }}</template>）
          </span>
          <div class="filters">
            <el-input
              v-model="q"
              placeholder="客户名"
              clearable
              size="small"
              style="width:140px"
            />
            <el-select
              v-model="fDept"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="部门"
              clearable
              size="small"
              style="width:130px"
            >
              <el-option v-for="d in depts" :key="d" :label="d" :value="d" />
            </el-select>
            <el-select
              v-model="fSalesman"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="业务员"
              clearable
              size="small"
              style="width:120px"
            >
              <el-option v-for="s in salesmanList" :key="s" :label="s" :value="s" />
            </el-select>
            <el-select
              v-model="fProduct"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="产品线"
              clearable
              size="small"
              style="width:130px"
            >
              <el-option v-for="p in productLineMeta" :key="p.key" :label="p.label" :value="p.key" />
            </el-select>
            <el-select
              v-model="fFeedback"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="销售反馈"
              clearable
              size="small"
              style="width:120px"
            >
              <el-option label="有反馈" value="any" />
              <el-option label="无反馈" value="none" />
            </el-select>
            <el-select
              v-model="fDiff"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="较昨日"
              clearable
              size="small"
              style="width:120px"
            >
              <el-option label="有变化" value="changed" />
              <el-option label="金额增加" value="up" />
              <el-option label="金额减少" value="down" />
              <el-option label="新增客户" value="new" />
            </el-select>
            <el-select
              v-model="fAmount"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="合计应收"
              clearable
              size="small"
              style="width:130px"
            >
              <el-option label="有金额" value="any" />
              <el-option label="≥ 10 万" value="10" />
              <el-option label="≥ 50 万" value="50" />
              <el-option label="≥ 100 万" value="100" />
            </el-select>
            <el-button size="small" @click="clearFilters">清除</el-button>
          </div>
        </div>
      </template>

      <el-table
        :data="filteredRows"
        border
        size="small"
        max-height="640"
        :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
        :cell-style="{ padding: '6px 0' }"
      >
        <el-table-column prop="customer_name" label="挂账客户" min-width="220" fixed="left" show-overflow-tooltip />
        <el-table-column prop="dept" label="部门" width="115" show-overflow-tooltip />
        <el-table-column prop="salesperson" label="业务员" width="100" show-overflow-tooltip />
        <el-table-column prop="contract_count" label="合同数" width="90" align="right" />
        <el-table-column prop="ship_amount" label="实际出库金额" width="140" align="right">
          <template #default="{ row }"><span class="mx-amt">{{ num(row.ship_amount) }}</span></template>
        </el-table-column>
        <el-table-column prop="uninvoiced_amount" label="已发货未开票" width="150" align="right">
          <template #default="{ row }">
            <span class="mx-amt">{{ num(row.uninvoiced_amount) }}</span>
            <span class="mx-sub">{{ row.uninvoiced_count || 0 }} 单</span>
          </template>
        </el-table-column>
        <el-table-column prop="invoiced_amount" label="开票金额" width="140" align="right">
          <template #default="{ row }"><span class="mx-amt">{{ num(row.invoiced_amount) }}</span></template>
        </el-table-column>
        <el-table-column prop="paid_amount" label="回款金额" width="140" align="right">
          <template #default="{ row }"><span class="mx-amt">{{ num(row.paid_amount) }}</span></template>
        </el-table-column>
        <el-table-column prop="unpaid_amount" label="已开票未回款" width="150" align="right">
          <template #default="{ row }">
            <span class="mx-amt">{{ num(row.unpaid_amount) }}</span>
            <span class="mx-sub">{{ row.unpaid_count || 0 }} 单</span>
          </template>
        </el-table-column>
        <el-table-column prop="total_receivable" label="合计应收" width="150" align="right">
          <template #default="{ row }"><span class="mx-amt strong">{{ num(row.total_receivable) }}</span></template>
        </el-table-column>

        <!-- 较昨日变化（每天的快照对比） -->
        <el-table-column prop="diff_total" label="较昨日" width="135" align="right">
          <template #default="{ row }">
            <span v-if="row.is_new_customer" class="mx-new">新增</span>
            <span v-else-if="Math.abs(Number(row.diff_total || 0)) < 0.005" class="mx-zero">—</span>
            <span v-else class="mx-diff" :class="Number(row.diff_total) > 0 ? 'mx-up' : 'mx-down'">
              {{ Number(row.diff_total) > 0 ? '+' : '' }}{{ num(row.diff_total) }}
            </span>
          </template>
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

        <!-- 销售反馈（可编辑） -->
        <el-table-column label="销售反馈" min-width="290">
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

// ====== 筛选（标题栏上一排下拉，可多选）======
const q = ref('')
const fDept = ref([])
const fSalesman = ref([])
const fProduct = ref([])
const fFeedback = ref([])
const fDiff = ref([])
const fAmount = ref([])

const salesmanList = computed(() => {
  const set = new Set()
  rows.value.forEach((r) => { if (r.salesperson) set.add(r.salesperson) })
  return [...set].sort()
})

const filteredRows = computed(() => {
  const kw = q.value.trim()
  return rows.value.filter((r) => {
    if (kw && !String(r.customer_name || '').includes(kw)) return false
    if (fDept.value.length && !fDept.value.includes(r.dept)) return false
    if (fSalesman.value.length && !fSalesman.value.includes(r.salesperson)) return false
    // 产品线：选中任一产品线，即显示「该产品线有金额」的客户
    if (fProduct.value.length && !fProduct.value.some((k) => Number(r[k] || 0) !== 0)) return false
    if (fFeedback.value.length) {
      const has = !!r.board_note
      if (!fFeedback.value.includes(has ? 'any' : 'none')) return false
    }
    if (fDiff.value.length) {
      const d = Number(r.diff_total || 0)
      const ok = fDiff.value.some((v) => {
        if (v === 'changed') return r.is_new_customer || Math.abs(d) >= 0.005
        if (v === 'new') return !!r.is_new_customer
        if (v === 'up') return !r.is_new_customer && d >= 0.005
        if (v === 'down') return !r.is_new_customer && d <= -0.005
        return true
      })
      if (!ok) return false
    }
    if (fAmount.value.length) {
      const t = Number(r.total_receivable || 0)
      const ok = fAmount.value.some((v) => (v === 'any' ? t !== 0 : t >= Number(v) * 10000))
      if (!ok) return false
    }
    return true
  })
})

function clearFilters() {
  q.value = ''
  fDept.value = []
  fSalesman.value = []
  fProduct.value = []
  fFeedback.value = []
  fDiff.value = []
  fAmount.value = []
}

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
.block-card { margin-bottom: 12px; }
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.card-title { font-weight: 500; color: #2c3e50; white-space: nowrap; }
.filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

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
