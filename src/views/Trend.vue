<template>
  <div class="container" v-loading="loading">
    <div class="page-header">
      <h1 class="main-title">每日快照趋势</h1>
      <span class="sub">每次导入一份数据后，这里会记录变化</span>
    </div>

    <el-alert
      v-if="trend.length <= 2"
      type="info"
      :closable="false"
      show-icon
      class="tip"
    >
      <template #title>提示</template>
      目前每个业务类型只有一天的数据（{{ trend.length }} 条快照）。每天用
      <code>npm run db:import</code> 导入一份新的，这里就能看到金额增减趋势。
    </el-alert>

    <el-table
      :data="trend"
      border
      style="width: 100%"
      :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
    >
      <el-table-column prop="snapshotDate" label="日期" width="130" align="center" />
      <el-table-column prop="bizType" label="业务类型" width="160" align="center">
        <template #default="{ row }">{{ bizLabel(row.bizType) }}</template>
      </el-table-column>
      <el-table-column prop="rowCount" label="单据数" width="90" align="center" />
      <el-table-column prop="totalAmount" label="金额合计(元)" align="right" min-width="170">
        <template #default="{ row }">
          <span class="amount">{{ fmt(row.totalAmount) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="环比上期" width="150" align="center">
        <template #default="{ row }">
          <span v-if="row.delta === null" class="muted">—</span>
          <span v-else :class="row.delta >= 0 ? 'up' : 'down'">
            {{ row.delta >= 0 ? '▲' : '▼' }} {{ fmt(Math.abs(row.delta)) }}
            <br />
            <small>({{ row.deltaPct >= 0 ? '+' : '' }}{{ row.deltaPct.toFixed(2) }}%)</small>
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="skippedCount" label="跳过" width="80" align="center">
        <template #default="{ row }">
          <span :class="row.skippedCount > 0 ? 'warn' : 'muted'">
            {{ row.skippedCount || '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="sourceFile" label="源文件" min-width="200" show-overflow-tooltip />
      <el-table-column prop="importedAt" label="导入时间" width="150" align="center">
        <template #default="{ row }">{{ formatTime(row.importedAt) }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useBizStore } from '@/stores/biz'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import { getTrend, BIZ_LABEL } from '@/api'

const biz = useBizStore()
const { current } = storeToRefs(biz)

const loading = ref(false)
const trend = ref([])

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function bizLabel(t) {
  return BIZ_LABEL[t] || t
}

function formatTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 计算环比（仅同业务类型内相邻快照可比） */
function withDelta(list) {
  const byType = {}
  list.forEach((r) => {
    if (!byType[r.bizType]) byType[r.bizType] = []
    byType[r.bizType].push(r)
  })

  const out = []
  for (const [type, arr] of Object.entries(byType)) {
    arr.sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))
    arr.forEach((r, i) => {
      if (i === 0) {
        r.delta = null
        r.deltaPct = 0
      } else {
        const prev = arr[i - 1].totalAmount
        r.delta = r.totalAmount - prev
        r.deltaPct = prev !== 0 ? (r.delta / prev) * 100 : 0
      }
      out.push(r)
    })
  }
  // 按日期倒序展示
  return out.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate))
}

async function loadData(silent) {
  if (!silent) loading.value = true
  try {
    const data = await getTrend() // 不传 bizType，看全部
    trend.value = withDelta(data || [])
  } catch (err) {
    console.error('[Trend] 加载失败:', err)
  } finally {
    if (!silent) loading.value = false
  }
}

watch(current, () => {
  // 趋势页展示全部类型，切业务类型无需重载
})

onMounted(loadData)
useAutoRefresh(loadData)
</script>

<style scoped>
.container { padding: 20px; background: #fff; border-radius: 8px; }
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 16px;
}
.main-title { font-size: 24px; margin: 0; color: #303133; }
.sub { font-size: 13px; color: #909399; }
.tip { margin-bottom: 16px; }
.tip code {
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 6px;
  border-radius: 3px;
  font-family: Consolas, Monaco, monospace;
}
.amount { font-weight: 600; color: #303133; }
.up { color: #f56c6c; font-weight: 600; }
.down { color: #67c23a; font-weight: 600; }
.warn { color: #e6a23c; font-weight: 600; }
.muted { color: #c0c4cc; }
small { font-size: 11px; }
</style>
