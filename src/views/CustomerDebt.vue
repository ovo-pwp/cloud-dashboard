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
        style="width:220px"
        @keyup.enter="load"
        @clear="load"
      />
      <el-select v-model="dept" placeholder="全部部门" clearable style="width:150px" @change="load">
        <el-option v-for="d in depts" :key="d" :label="d" :value="d" />
      </el-select>
      <el-button size="small" :type="onlyUnpaid ? 'primary' : ''" @click="toggleOnly">
        {{ onlyUnpaid ? '✓ ' : '' }}只看有未回款
      </el-button>
      <el-button size="small" @click="load">刷新</el-button>
      <span class="filter-tip">
        应收数据为实时同步（每小时）；产品线拆分为手工表（6 小时一次）；销售反馈两处合并
      </span>
    </el-card>

    <!-- 明细 -->
    <el-card shadow="never" class="block-card">
      <template #header>
        <span class="card-title">客户明细（{{ rows.length }}）</span>
        <span class="card-hint">
          反馈列合并：看板「进度反馈」+ 源表 Excel「沟通回款进度」
        </span>
      </template>
      <el-table
        :data="rows"
        border
        size="small"
        max-height="620"
        :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
        :cell-style="{ padding: '6px 0' }"
      >
        <el-table-column prop="customer_name" label="挂账客户" min-width="230" fixed="left" show-overflow-tooltip />
        <el-table-column prop="dept" label="部门" width="120" show-overflow-tooltip />
        <el-table-column prop="salesperson" label="业务员" width="100" show-overflow-tooltip />

        <el-table-column label="已发货未开票" width="160" align="right">
          <template #default="{ row }">
            <span class="mx-amt">{{ num(row.uninvoiced_amount) }}</span>
            <span class="mx-sub">{{ row.uninvoiced_count || 0 }} 单</span>
          </template>
        </el-table-column>
        <el-table-column label="已开票未回款" width="160" align="right">
          <template #default="{ row }">
            <span class="mx-amt">{{ num(row.unpaid_amount) }}</span>
            <span class="mx-sub">{{ row.unpaid_count || 0 }} 单</span>
          </template>
        </el-table-column>
        <el-table-column label="其中 3 个月以上" width="150" align="right">
          <template #default="{ row }">
            <span class="mx-amt" :class="{ 'mx-danger': Number(row.unpaid_over3m || 0) > 0 }">
              {{ num((row.unpaid_over3m || 0) + (row.uninvoiced_over3m || 0)) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="total_receivable" label="合计应收" width="150" align="right">
          <template #default="{ row }"><span class="mx-amt strong">{{ num(row.total_receivable) }}</span></template>
        </el-table-column>

        <el-table-column
          v-for="p in productLineMeta"
          :key="p.key"
          :prop="p.key"
          :label="p.label"
          width="130"
          align="right"
        >
          <template #default="{ row }">
            <span v-if="Number(row[p.key] || 0) !== 0" class="mx-amt">{{ num(row[p.key]) }}</span>
            <span v-else class="mx-zero">—</span>
          </template>
        </el-table-column>

        <el-table-column label="销售反馈" min-width="280">
          <template #default="{ row }">
            <div v-if="row.board_note" class="fb-item">
              <el-tag size="small" type="success" effect="plain">看板</el-tag>
              <span class="fb-text">{{ row.board_note }}</span>
              <span class="mx-sub">{{ fmtTime(row.board_note_at) }}</span>
            </div>
            <div v-if="row.excel_progress" class="fb-item">
              <el-tag size="small" type="warning" effect="plain">源表</el-tag>
              <span class="fb-text">{{ row.excel_progress }}</span>
            </div>
            <div v-if="row.excel_remark" class="fb-item">
              <el-tag size="small" type="info" effect="plain">备注</el-tag>
              <span class="fb-text">{{ row.excel_remark }}</span>
            </div>
            <span v-if="!row.board_note && !row.excel_progress && !row.excel_remark" class="mx-zero">
              未填写
            </span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getCustomerDebt } from '@/api'

const q = ref('')
const dept = ref('')
const onlyUnpaid = ref(false)

const summary = ref(null)
const productLineMeta = ref([])
const rows = ref([])
const depts = ref([])

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

.fb-item { display: flex; align-items: baseline; gap: 6px; line-height: 1.7; }
.fb-text { font-size: 12px; color: #303133; }
</style>
