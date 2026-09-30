<template>
  <div class="container" v-loading="loading" ref="exportEl">
    <PageHeader title="每日快照趋势" sub="每次导入一份数据后，这里会记录变化">
      <template #meta>
        <!-- 这一页不跟顶栏的业务类型切换（展示全部类型），所以不能像其他页那样只标一个日期。
             改为标出「数据范围」，避免看的人以为这里只显示了当前业务类型 -->
        <el-tag v-if="dateRangeText" class="snapshot-tag" type="info" effect="plain">
          数据范围 {{ dateRangeText }}
        </el-tag>
      </template>
      <el-button
        class="no-export"
        type="primary"
        plain
        size="small"
        :loading="exporting"
        :disabled="loading || !trend.length"
        @click="exportImage"
      >
        导出图片
      </el-button>
    </PageHeader>

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
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { toPng } from 'html-to-image'
import { storeToRefs } from 'pinia'
import { useBizStore } from '@/stores/biz'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import { getTrend, BIZ_LABEL } from '@/api'
import PageHeader from '@/components/PageHeader.vue'

const biz = useBizStore()
const { current } = storeToRefs(biz)

const loading = ref(false)
const trend = ref([])
const exporting = ref(false)
const exportEl = ref(null)

// 数据范围：这一页展示全部业务类型，用「最早日期 ~ 最新日期」说明覆盖到哪一天
const dateRangeText = computed(() => {
  const dates = trend.value.map((r) => r.snapshotDate).filter(Boolean)
  if (!dates.length) return ''
  const sorted = [...new Set(dates)].sort()
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return first === last ? first : `${first} ~ ${last}`
})

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

/**
 * 导出趋势表为 PNG。
 * 与「数据概览」「客户平台看板」保持同一套写法：过滤 .no-export，
 * 否则上报图片里会拍进「导出图片」这个按钮本身。
 */
async function exportImage() {
  if (!exportEl.value || exporting.value) return
  exporting.value = true
  try {
    const dataUrl = await toPng(exportEl.value, {
      pixelRatio: 2,
      backgroundColor: '#ffffff',
      filter: (node) =>
        !(node instanceof Element && node.classList && node.classList.contains('no-export')),
    })
    const a = document.createElement('a')
    const today = new Date().toISOString().slice(0, 10)
    a.download = `趋势_${dateRangeText.value || today}.png`
    a.href = dataUrl
    a.click()
    ElMessage.success('已导出趋势图片')
  } catch (err) {
    console.error('[导出趋势图片] 失败:', err)
    ElMessage.error('导出图片失败，请重试')
  } finally {
    exporting.value = false
  }
}

onMounted(loadData)
useAutoRefresh(loadData)
</script>

<style scoped>
.container { padding: 20px; background: #fff; border-radius: 8px; }
/* 头部已交给 PageHeader 组件统一 */
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

/* 移动端适配 */
@media (max-width: 768px) {
  .container { padding: 10px; }
  /* 头部字号/间距/标签换行由 PageHeader 组件自己处理 */

  .toolbar { flex-wrap: wrap; gap: 8px; }
  .toolbar .el-select { width: 130px !important; }

  .chart-wrap { height: 280px !important; }
  .stat-row { row-gap: 10px; }
  .stat-card { padding: 12px 10px; }
  .stat-label { font-size: 12px; }
  .stat-value { font-size: 18px; }

  .trend-table { font-size: 11px; }
  :deep(.trend-table th),
  :deep(.trend-table td) { padding: 6px 4px !important; }
}
</style>
