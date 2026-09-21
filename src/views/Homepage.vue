<template>
  <div class="container" v-loading="loading">
    <div class="hero">
      <h1>回款/开票管理系统</h1>
      <p class="hero-sub">已开票未回款 · 已发货未开票 · 客户平台未回款，统一看板</p>
    </div>

    <el-row :gutter="16" class="cards">
      <el-col :span="6">
        <div class="card">
          <div class="card-label">未回款总额（元）</div>
          <div class="card-value amount">{{ fmt(billedUnpaid?.total) }}</div>
          <div class="card-sub">{{ billedUnpaid?.snapshotDate }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="card">
          <div class="card-label">未开票总额（元）</div>
          <div class="card-value amount">{{ fmt(shipped?.total) }}</div>
          <div class="card-sub">{{ shipped?.snapshotDate }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="card">
          <div class="card-label">客户平台未回款（元）</div>
          <div class="card-value amount">{{ fmt(cpSummary.total) }}</div>
          <div class="card-sub">{{ cpSummary.snapshotDate }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="card">
          <div class="card-label">在管客户数（三家合计）</div>
          <div class="card-value">{{ totalCustomers }}</div>
          <div class="card-sub">未回款 {{ billedUnpaid?.customerCount }} · 客户平台 {{ cpSummary.customerCount }}</div>
        </div>
      </el-col>
    </el-row>

    <el-card class="block" shadow="never">
      <template #header><b>数据源明细</b></template>
      <el-table :data="rows" border :header-cell-style="{ background: '#2c3e50', color: '#fff' }">
        <el-table-column prop="label" label="数据源" width="170" />
        <el-table-column prop="snapshotDate" label="日期" width="110" align="center" />
        <el-table-column prop="amount" label="金额(元)" min-width="150" align="right">
          <template #default="{ row }"><span class="amount">{{ fmt(row.amount) }}</span></template>
        </el-table-column>
        <el-table-column prop="invoiceCount" label="订单/条数" min-width="100" align="center" />
        <el-table-column prop="customerCount" label="客户数" min-width="90" align="center" />
        <el-table-column prop="salespersonCount" label="业务员数" min-width="90" align="center" />
        <el-table-column prop="extra" label="其他" min-width="140" align="center">
          <template #default="{ row }">{{ row.extra }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <h2 class="section-title">快捷入口</h2>
    <el-row :gutter="16" class="entries">
      <el-col :span="6">
        <el-card shadow="hover" class="entry" @click="go('/home')">
          <el-icon class="e-ico"><DataAnalysis /></el-icon>
          <div class="e-name">未回款/未开票 数据概览</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="entry" @click="go('/detail')">
          <el-icon class="e-ico"><Document /></el-icon>
          <div class="e-name">未回款/未开票 明细查询</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="entry" @click="go('/customer-platform-unpaid')">
          <el-icon class="e-ico"><Money /></el-icon>
          <div class="e-name">客户平台未回款金额看板</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="entry" @click="go('/system')">
          <el-icon class="e-ico"><Setting /></el-icon>
          <div class="e-name">系统管理</div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { DataAnalysis, Document, Money, Setting } from '@element-plus/icons-vue'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import { getSummary, getCustomerPlatformSummary } from '@/api'

const router = useRouter()
const loading = ref(false)
const billedUnpaid = ref({})
const shipped = ref({})
const cpSummary = ref({ total: 0, orderCount: 0, customerCount: 0, platformCount: 0, snapshotDate: null })

const totalCustomers = computed(
  () =>
    Number(billedUnpaid.value.customerCount || 0) +
    Number(shipped.value.customerCount || 0) +
    Number(cpSummary.value.customerCount || 0)
)

const rows = computed(() => [
  {
    label: '已开票未回款',
    snapshotDate: billedUnpaid.value.snapshotDate,
    amount: billedUnpaid.value.total,
    invoiceCount: billedUnpaid.value.invoiceCount,
    customerCount: billedUnpaid.value.customerCount,
    salespersonCount: billedUnpaid.value.salespersonCount,
    extra: `≥3月 ${fmt(billedUnpaid.value.over3m)}`,
  },
  {
    label: '已发货未开票',
    snapshotDate: shipped.value.snapshotDate,
    amount: shipped.value.total,
    invoiceCount: shipped.value.invoiceCount,
    customerCount: shipped.value.customerCount,
    salespersonCount: shipped.value.salespersonCount,
    extra: `≥3月 ${fmt(shipped.value.over3m)}`,
  },
  {
    label: '客户平台未回款',
    snapshotDate: cpSummary.value.snapshotDate,
    amount: cpSummary.value.total,
    invoiceCount: cpSummary.value.orderCount,
    customerCount: cpSummary.value.customerCount,
    salespersonCount: cpSummary.value.platformCount,
    extra: '平台数 ' + cpSummary.value.platformCount,
  },
])

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function go(path) {
  router.push(path)
}

async function loadData(silent) {
  if (!silent) loading.value = true
  try {
    const [bu, s, cp] = await Promise.all([
      getSummary('billed_unpaid'),
      getSummary('shipped_uninvoiced'),
      getCustomerPlatformSummary(),
    ])
    billedUnpaid.value = bu
    shipped.value = s
    cpSummary.value = cp
  } catch (err) {
    console.error('[首页] 加载失败:', err)
  } finally {
    if (!silent) loading.value = false
  }
}

onMounted(loadData)
useAutoRefresh(loadData)
</script>

<style scoped>
.container { padding: 20px; }
.hero {
  background: linear-gradient(135deg, #1f3c5c, #2c5f8a);
  color: #fff;
  border-radius: 10px;
  padding: 32px 28px;
  margin-bottom: 20px;
}
.hero h1 { margin: 0 0 8px; font-size: 26px; }
.hero-sub { margin: 0; color: #cfe0f2; font-size: 14px; }
.cards { margin-bottom: 16px; }
.card { background: #fff; border-radius: 8px; padding: 16px 18px; }
.card-label { font-size: 13px; color: #909399; margin-bottom: 8px; }
.card-value { font-size: 22px; font-weight: 700; color: #303133; }
.card-value.amount { color: #f56c6c; }
.card-sub { font-size: 12px; color: #c0c4cc; margin-top: 6px; }
.block { margin-bottom: 20px; }
.amount { font-weight: 600; color: #f56c6c; }
.section-title { font-size: 16px; color: #303133; margin: 4px 0 12px; }
.entry { text-align: center; cursor: pointer; padding: 20px 8px; color: #606266; }
.entry:hover { color: #2c5f8a; }
.e-ico { font-size: 40px; color: #2c5f8a; margin-bottom: 10px; }
.e-name { font-size: 13px; }
</style>