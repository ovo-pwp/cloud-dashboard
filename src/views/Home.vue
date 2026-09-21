<template>
  <div class="home" v-loading="loading">
    <div class="page-header">
      <h2 class="page-title">{{ summary.bizLabel || biz.label }} 概览</h2>
      <div class="snapshot" v-if="summary.snapshotDate">
        {{ summary.snapshotDate }}
      </div>
    </div>

    <el-empty v-if="!loading && !summary.hasData" description="该业务类型暂无数据">
      <div class="empty-tip">
        导入命令：<br />
        <code>node server/db/import-excel.js {{ biz.current }} "文件路径"</code>
      </div>
    </el-empty>

    <template v-else>
      <!-- 数据质量提示 -->
      <el-alert
        v-if="summary.warnCount > 0 || summary.skippedCount > 0"
        type="warning"
        :closable="false"
        show-icon
        class="warn-alert"
      >
        <template #title>
          数据质量提示
        </template>
        <div class="warn-body">
          <span v-if="summary.skippedCount > 0">
            导入时跳过 <b>{{ summary.skippedCount }}</b> 行脏数据（分类为空且账龄分档全为 0）
          </span>
          <span v-if="summary.warnCount > 0">
            <b>{{ summary.warnCount }}</b> 行账龄分档与总额不符，已在明细分页中标记
          </span>
        </div>
      </el-alert>

      <!-- 核心指标 -->
      <el-row :gutter="20" class="stat-row">
        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="hover" class="stat-card">
            <div class="stat-label">总额</div>
            <div class="stat-value danger">{{ fmt(summary.total) }}</div>
            <div class="stat-unit">元</div>
          </el-card>
        </el-col>

        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="hover" class="stat-card">
            <div class="stat-label">3个月以上</div>
            <div class="stat-value warning">{{ fmt(summary.over3m) }}</div>
            <div class="stat-unit">占比 {{ (summary.over3mRatio * 100).toFixed(1) }}%</div>
          </el-card>
        </el-col>

        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="hover" class="stat-card">
            <div class="stat-label">单据数</div>
            <div class="stat-value primary">{{ summary.invoiceCount }}</div>
            <div class="stat-unit">{{ summary.customerCount }} 个客户</div>
          </el-card>
        </el-col>

        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="hover" class="stat-card">
            <div class="stat-label">涉及业务员</div>
            <div class="stat-value">{{ summary.salespersonCount }}</div>
            <div class="stat-unit">人</div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 账龄结构 -->
      <el-card shadow="never" class="block-card">
        <template #header><span class="card-title">账龄结构</span></template>

        <div v-for="item in agingList" :key="item.category" class="aging-row">
          <div class="aging-name">{{ item.category }}</div>
          <div class="aging-bar-wrap">
            <div
              class="aging-bar"
              :style="{
                width: agingPercent(item.total) + '%',
                background: agingColor(item.category),
              }"
            />
          </div>
          <div class="aging-amount">{{ fmt(item.total) }}</div>
          <div class="aging-count">{{ item.docCount }} 单</div>
        </div>
      </el-card>

      <!-- 业务员排行（按账龄分档） -->
      <el-card shadow="never" class="block-card">
        <template #header><span class="card-title">业务员排行（按账龄分档）</span></template>
        <div v-for="g in agingGroups" :key="g.label" class="aging-group">
          <div class="group-title">
            <span class="group-name">{{ g.label }}</span>
            <span class="group-total">合计 {{ fmt(g.subtotal) }} 元</span>
          </div>
          <div v-for="it in g.items" :key="g.label + it.name" class="sp-row">
            <span class="sp-name">
              {{ it.name }}
              <el-tag v-if="it.dept" size="small" type="info" style="margin-left: 6px">
                {{ it.dept }}
              </el-tag>
            </span>
            <div class="sp-bar-wrap">
              <div
                class="sp-bar"
                :style="{ width: percent(it.amount, g.subtotal) + '%', background: agingColor(g.label) }"
              />
            </div>
            <span class="sp-amount">{{ fmt(it.amount) }}</span>
            <span class="sp-ratio">{{ percent(it.amount, g.subtotal) }}%</span>
          </div>
        </div>
      </el-card>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useBizStore } from '@/stores/biz'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import { getSummary, getAgingSummary, getAgingBySalesperson } from '@/api'

const biz = useBizStore()
const { current } = storeToRefs(biz)

const loading = ref(false)
const agingList = ref([])
const salespersonList = ref([])

const summary = reactive({
  hasData: false,
  bizLabel: '',
  snapshotDate: null,
  total: 0,
  invoiceCount: 0,
  customerCount: 0,
  salespersonCount: 0,
  over3m: 0,
  over3mRatio: 0,
  warnCount: 0,
  skippedCount: 0,
})

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function agingPercent(amount) {
  if (!summary.total) return 0
  return Math.max((amount / summary.total) * 100, 1)
}

function percent(amount, base) {
  if (!base) return '0.0'
  return ((amount / base) * 100).toFixed(1)
}

// 按账龄分档的业务员排行：每档一个区块，内部按金额倒序
const AGING_SECTIONS = [
  { label: '开票3个月以上未回款', field: 'over3m' },
  { label: '开票3个月未回款', field: 'm3' },
  { label: '开票2个月未回款', field: 'm2' },
  { label: '开票1个月未回款', field: 'm1' },
  { label: '当月未回款', field: 'currentMonth' },
]

const agingGroups = computed(() =>
  AGING_SECTIONS.map((sec) => {
    const items = salespersonList.value
      .map((r) => ({ name: r.salesperson, dept: r.department, amount: Number(r[sec.field] || 0) }))
      .filter((i) => i.amount !== 0)
      .sort((a, b) => b.amount - a.amount)
    const subtotal = items.reduce((s, i) => s + i.amount, 0)
    return { label: sec.label, items, subtotal }
  })
)

function agingColor(category) {
  if (category.includes('三个月以上')) return '#f56c6c'
  if (category === '三个月未回款' || category === '三个月未开票') return '#e6a23c'
  if (category === '两个月未回款' || category === '两个月未开票') return '#d4b106'
  if (category === '一个月未回款' || category === '一个月未开票') return '#409eff'
  if (category === '未分类') return '#c0c4cc'
  return '#67c23a'
}

async function loadAll(silent) {
  if (!silent) loading.value = true
  try {
    const [s, aging, bysp] = await Promise.all([
      getSummary(current.value),
      getAgingSummary(current.value),
      getAgingBySalesperson(current.value),
    ])
    Object.assign(summary, s)
    agingList.value = (aging.records || []).filter((r) => r.total !== 0)
    salespersonList.value = bysp.records || []
  } catch (err) {
    console.error('[Home] 加载失败:', err)
  } finally {
    if (!silent) loading.value = false
  }
}

watch(current, loadAll)
onMounted(loadAll)
useAutoRefresh(loadAll)
</script>

<style scoped>
.home { padding: 4px; }
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 20px;
}
.page-title { margin: 0; font-size: 22px; color: #303133; }
.snapshot { font-size: 13px; color: #909399; }
.warn-alert { margin-bottom: 18px; }
.warn-body { font-size: 13px; line-height: 1.9; }
.stat-row { row-gap: 20px; }
.stat-card { border-radius: 8px; }
.stat-label { font-size: 14px; color: #909399; margin-bottom: 12px; }
.stat-value { font-size: 26px; font-weight: 700; color: #303133; line-height: 1.2; }
.stat-value.primary { color: #409eff; }
.stat-value.warning { color: #e6a23c; }
.stat-value.danger  { color: #f56c6c; }
.stat-unit { font-size: 12px; color: #c0c4cc; margin-top: 6px; }
.block-card { margin-top: 20px; border-radius: 8px; }
.card-title { font-weight: 600; color: #303133; }
.aging-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
.aging-name { width: 130px; font-size: 14px; color: #606266; flex-shrink: 0; }
.aging-bar-wrap { flex: 1; height: 18px; background: #f5f7fa; border-radius: 9px; overflow: hidden; }
.aging-bar { height: 100%; border-radius: 9px; transition: width 0.6s ease; }
.aging-amount { width: 150px; text-align: right; font-size: 14px; font-weight: 600; color: #303133; flex-shrink: 0; }
.aging-count { width: 70px; text-align: right; font-size: 13px; color: #909399; flex-shrink: 0; }
.strong { font-weight: 600; color: #f56c6c; }
.aging-group { margin-bottom: 22px; }
.group-title { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.group-name { font-size: 14px; font-weight: 600; color: #303133; }
.group-total { font-size: 13px; color: #909399; }
.sp-row { display: flex; align-items: center; gap: 12px; padding: 5px 0; }
.sp-name { width: 150px; font-size: 13px; color: #606266; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-bar-wrap { flex: 1; height: 16px; background: #f5f7fa; border-radius: 8px; overflow: hidden; }
.sp-bar { height: 100%; border-radius: 8px; transition: width 0.5s ease; }
.sp-amount { width: 140px; text-align: right; font-size: 13px; font-weight: 600; color: #303133; flex-shrink: 0; }
.sp-ratio { width: 50px; text-align: right; font-size: 12px; color: #909399; flex-shrink: 0; }
.empty-tip { margin-top: 12px; font-size: 13px; color: #909399; line-height: 2; }
.empty-tip code { background: #f5f7fa; padding: 2px 8px; border-radius: 4px; font-family: Consolas, Monaco, monospace; }
</style>
