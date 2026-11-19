<template>
  <div class="container">
    <PageHeader title="客户欠款 · 产品线" :sub="subText" />

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
      <el-select v-model="product" placeholder="全部产品线" clearable style="width:170px" @change="load">
        <el-option v-for="p in productLineMeta" :key="p.key" :label="p.label" :value="p.key" />
      </el-select>
      <el-button size="small" @click="load">刷新</el-button>
      <span class="filter-tip">产品线筛选 = 只看该产品线有欠款的客户</span>
    </el-card>

    <!-- 产品线分布 -->
    <el-card shadow="never" class="block-card">
      <template #header><span class="card-title">产品线欠款分布</span></template>
      <el-table
        :data="productLines"
        border
        size="small"
        :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
        :cell-style="{ padding: '6px 0' }"
      >
        <el-table-column prop="label" label="产品线" width="180" />
        <el-table-column label="欠款金额（元）" min-width="160" align="right">
          <template #default="{ row }">
            <span class="mx-amt">{{ num(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="customerCount" label="客户数" width="110" align="right" />
        <el-table-column label="占合计应收" width="150" align="right">
          <template #default="{ row }">
            <span v-if="summary && summary.totalReceivable">
              {{ ((row.amount / summary.totalReceivable) * 100).toFixed(1) }}%
            </span>
            <span v-else>—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 明细 -->
    <el-card shadow="never" class="block-card">
      <template #header>
        <span class="card-title">客户明细（{{ rows.length }}）</span>
      </template>
      <el-table
        :data="rows"
        border
        size="small"
        max-height="560"
        :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
        :cell-style="{ padding: '6px 0' }"
      >
        <el-table-column prop="customer_name" label="挂账客户" min-width="230" fixed="left" show-overflow-tooltip />
        <el-table-column prop="dept" label="部门" width="120" show-overflow-tooltip />
        <el-table-column prop="salesperson" label="业务员" width="100" show-overflow-tooltip />
        <el-table-column prop="contract_count" label="合同数" width="90" align="right" />
        <el-table-column prop="shipped_amount" label="实际出库" width="140" align="right">
          <template #default="{ row }"><span class="mx-amt">{{ num(row.shipped_amount) }}</span></template>
        </el-table-column>
        <el-table-column prop="uninvoiced_amount" label="已发货未开票" width="150" align="right">
          <template #default="{ row }"><span class="mx-amt">{{ num(row.uninvoiced_amount) }}</span></template>
        </el-table-column>
        <el-table-column prop="unpaid_amount" label="已开票未回款" width="150" align="right">
          <template #default="{ row }"><span class="mx-amt">{{ num(row.unpaid_amount) }}</span></template>
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
        <el-table-column prop="remark" label="备注" width="150" show-overflow-tooltip />
        <el-table-column prop="progress_note" label="沟通回款进度" min-width="240" show-overflow-tooltip />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getCustomerDebt } from '@/api'
import PageHeader from '@/components/PageHeader.vue'

const loading = ref(false)
const q = ref('')
const dept = ref('')
const product = ref('')

const snapshotDate = ref(null)
const summary = ref(null)
const productLines = ref([])
const productLineMeta = ref([])
const rows = ref([])
const depts = ref([])

const subText = computed(() => {
  if (!snapshotDate.value) return '数据源：客户欠款-按产品线拆分（每 6 小时更新一次）'
  return `数据日期 ${snapshotDate.value}　｜　来源：客户欠款-按产品线拆分（每 6 小时更新一次）`
})

const sumCards = computed(() => {
  const s = summary.value
  if (!s) return []
  // 选中某个产品线时，第一张卡换成「该产品线欠款」——避免看成客户全部应收
  const pl = product.value ? productLines.value.find((p) => p.key === product.value) : null
  const head = pl
    ? { label: `${pl.label}（元）`, value: pl.amount, sub: `${pl.customerCount} 个客户有此项欠款` }
    : { label: '合计应收（元）', value: s.totalReceivable, sub: `${s.customerCount} 个客户` }
  return [
    head,
    { label: '已发货未开票（元）', value: s.uninvoicedAmount, sub: '货已发、票未开' },
    { label: '已开票未回款（元）', value: s.unpaidAmount, sub: '票已开、钱未收' },
    { label: '实际出库金额（元）', value: s.shippedAmount, sub: `开票 ${num(s.invoicedAmount)} / 回款 ${num(s.paidAmount)}` },
  ]
})

/** 金额千分位；空值显示 — */
function num(v) {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function load() {
  loading.value = true
  try {
    const params = {}
    if (q.value) params.q = q.value
    if (dept.value) params.dept = dept.value
    if (product.value) params.product = product.value
    const d = await getCustomerDebt(params)
    snapshotDate.value = d.snapshotDate
    summary.value = d.summary
    productLines.value = d.productLines || []
    productLineMeta.value = d.productLineMeta || []
    rows.value = d.rows || []
    depts.value = d.depts || []
  } catch (e) {
    // 静默：页面保留上次数据，避免闪空
  } finally {
    loading.value = false
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

.mx-amt { font-variant-numeric: tabular-nums; }
.mx-amt.strong { font-weight: 500; color: #2c3e50; }
.mx-zero { color: #c0c4cc; }
</style>
