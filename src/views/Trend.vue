<template>
  <div class="container" v-loading="loading" ref="exportEl">
    <!-- 副标题只说版式；口径统一放下面那段，避免两处重复（10-13 使用者「删掉重复的没有用的」） -->
    <PageHeader title="每日快照趋势" sub="一行 = 一个快照日期，两条业务线并排（口径见下方说明）">
      <template #meta>
        <!-- 这一页不跟顶栏的业务类型切换（展示全部类型），所以不能像其他页那样只标一个日期。
             改为标出「数据范围」，避免看的人以为这里只显示了当前业务类型 -->
        <el-tag v-if="dateRangeText" class="snapshot-tag" type="info" effect="plain">
          数据范围 {{ dateRangeText }}
        </el-tag>
      </template>
      <!-- 默认只显示最近 2 期：这页的日常用法就是「今天 vs 上一批」，
           11 期铺满屏反而要往下找。全部历史收在这个按钮后面。 -->
      <el-button
        v-if="hasMore"
        class="no-export"
        plain
        size="small"
        @click="expanded = !expanded"
      >
        {{ expanded ? '只看最近 2 期' : `展开全部（共 ${trend.length} 期）` }}
      </el-button>
      <el-button
        class="no-export"
        type="primary"
        plain
        size="small"
        :loading="exporting"
        :disabled="loading || !displayRows.length"
        @click="exportImage"
      >
        导出图片
      </el-button>
    </PageHeader>

    <!-- 口径说明：原来一路加成一整段（10-13 使用者「删掉重复的没有用的」），现在压成 3 行 -->
    <div class="note">
      <b>统计口径</b>：余额两列取 <b>1个月以上</b>（不含「当月」—— 当月档月内只涨不跌，会盖住趋势），环比同口径。<br />
      <b>当日回款</b> / <b>当日已开票</b> 是推算值：源表是「还没回款 / 还没开票」的快照，单子结清后即消失，
      这两个数 = <b>相邻两批</b>「整笔消失 + 金额变小」的单据金额，用<b>全量口径</b>（含当月，与左边「1个月以上」不能直接加减）。<br />
      基准 = 上一个可用批次（周末 / 假期会断档）；<b>「当日」指该行自己那天</b>，见每格下面的「较 MM-DD」——隔 N 天时这格就是 N 天合计。
      <template v-if="trend.length < 2">
        目前只有 {{ trend.length }} 个快照日期，再多跑几批才看得出变化。
      </template>
      <template v-else-if="!expanded && hasMore">
        当前只显示最近 2 期，点右上角「展开全部」看完整历史。
      </template>
    </div>

    <el-table
      :data="displayRows"
      border
      style="width: 100%"
      :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
    >
      <el-table-column prop="snapshotDate" label="日期" width="160" align="center">
        <template #default="{ row }">
          <div :title="dateTitle(row)">
            <div class="date-main">{{ row.snapshotDate }}</div>
            <div class="date-sub">{{ prevText(row) }}</div>
          </div>
        </template>
      </el-table-column>

      <!-- 两条业务线的三列结构完全一样，用 v-for 展开。
           手写两遍的话，以后改一条线必定漏掉另一条 -->
      <template v-for="line in LINES" :key="line.key">
        <el-table-column :label="line.totalLabel" min-width="180" align="right">
          <template #default="{ row }">
            <span v-if="!row[line.key]" class="muted">—</span>
            <!-- 2026-10-13 起余额列取「1个月以上」（不含当月）—— 当月档月内只涨不跌，会盖住真实趋势 -->
            <span v-else class="amount">{{ fmt(row[line.key].over1m) }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="line.flowLabel" min-width="170" align="right">
          <template #default="{ row }">
            <span v-if="!row[line.key] || row[line.key].flow === null" class="muted">—</span>
            <span v-else>
              <span class="flow" :title="flowTitle(row, line.key)">{{ fmt(row[line.key].flow) }}</span>
              <!--
                基准日期写在**格子里**而不是表头：每一行的基准都不同
                （10-13 对 10-12、10-12 对 10-10），表头放不下。
                「日期」列虽然也标了，但它在屏幕最左边，离这一列太远，读数时对不上。
              -->
              <br />
              <!-- 只取 MM-DD，与左边「日期」列的「较 10-12（隔 1 天）」保持同一格式 -->
              <small class="date-sub">较 {{ row[line.key].prevSnapshotDate.slice(5) }}</small>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="当日环比" width="155" align="center">
          <template #default="{ row }">
            <span v-if="!row[line.key] || row[line.key].delta === null" class="muted">—</span>
            <!-- 持平走中性灰：显示「▲ 0.00 (+0.00%)」既没信息量，红色还容易被读成「涨了」 -->
            <span v-else-if="isFlat(row[line.key].delta)" class="muted">持平</span>
            <span v-else :class="row[line.key].delta > 0 ? 'up' : 'down'">
              {{ row[line.key].delta > 0 ? '▲' : '▼' }} {{ fmt(Math.abs(row[line.key].delta)) }}
              <br />
              <small v-if="row[line.key].deltaPct !== null">
                ({{ row[line.key].deltaPct > 0 ? '+' : '' }}{{ row[line.key].deltaPct.toFixed(2) }}%)
              </small>
            </span>
          </template>
        </el-table-column>
      </template>
    </el-table>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { toPng } from 'html-to-image'
import { storeToRefs } from 'pinia'
import { useBizStore } from '@/stores/biz'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import { getTrend } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import { captureWithFullWidth } from '@/utils/exportSize'

const biz = useBizStore()
const { current } = storeToRefs(biz)

const loading = ref(false)
const trend = ref([])
const exporting = ref(false)
const exportEl = ref(null)

// 默认只铺最近 2 期：这页的日常用法是「本批 vs 上一批」，
// 11 期全铺满屏反而要往下找。全部历史收在「展开全部」按钮后面。
const DEFAULT_ROWS = 2
const expanded = ref(false)
const displayRows = computed(() =>
  expanded.value ? trend.value : trend.value.slice(0, DEFAULT_ROWS)
)
const hasMore = computed(() => trend.value.length > DEFAULT_ROWS)

// 「数据范围」标签用**全量**范围（说明这份数据覆盖到哪），与表格里显示几行无关；
// 导出文件名则用**当前显示**的范围，免得图里只有 2 期、文件名却写着 20 天
const dateRangeText = computed(() => {
  const dates = trend.value.map((r) => r.snapshotDate).filter(Boolean)
  if (!dates.length) return ''
  const sorted = [...new Set(dates)].sort()
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return first === last ? first : `${first} ~ ${last}`
})

const shownRangeText = computed(() => {
  const dates = displayRows.value.map((r) => r.snapshotDate).filter(Boolean)
  if (!dates.length) return ''
  const sorted = [...new Set(dates)].sort()
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return first === last ? first : `${first}~${last}`
})

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function formatTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ------------------------------------------------------------
// 两条业务线：结构与列宽完全一致，只有标题不同。
// 用 v-for 展开，改一条线不会漏掉另一条。
// key 必须与后端返回的 bizType 一致。
// ------------------------------------------------------------
const LINES = [
  { key: 'billed_unpaid', totalLabel: '未回款 1个月以上（元）', flowLabel: '当日回款' },
  { key: 'shipped_uninvoiced', totalLabel: '未开票 1个月以上（元）', flowLabel: '当日已开票' },
]

/** 金额为 0 的环比走中性灰，不显示「▲ 0.00 (+0.00%)」这种没信息量的读数 */
function isFlat(d) {
  return Math.abs(Number(d) || 0) < 0.005
}

/** 与上一批相差几天。必须显示出来，否则「较 10-08」会被读成「昨天」 */
function dayGap(cur, prev) {
  if (!cur || !prev) return null
  const n = Math.round(
    (new Date(`${cur}T00:00:00`) - new Date(`${prev}T00:00:00`)) / 86400000
  )
  return Number.isFinite(n) ? n : null
}

/** 日期列的副标题：对比基准是哪个批次、隔了几天 */
function prevText(row) {
  const p =
    row.billed_unpaid?.prevSnapshotDate || row.shipped_uninvoiced?.prevSnapshotDate || null
  if (!p) return '最早一批，无对比'
  const g = dayGap(row.snapshotDate, p)
  return g === null ? `较 ${p.slice(5)}` : `较 ${p.slice(5)}（隔 ${g} 天）`
}

/** 日期列的悬停说明：源文件与导入时间从「列」挪到 tooltip，省地方又不丢线索 */
function dateTitle(row) {
  const L = row.billed_unpaid || row.shipped_uninvoiced
  if (!L) return ''
  return `源文件 ${L.sourceFile || '—'} ｜ 导入于 ${formatTime(L.importedAt)}`
}

/** 回款 / 已开票 是推算值，悬停给出算式依据，免得被当成源表字段 */
function flowTitle(row, key) {
  const L = row[key]
  if (!L || L.flow === null) return ''
  // delta 现在按「1个月以上」算，所以上一批的 1个月以上 = 本批 1个月以上 − delta
  const prevOver1m = (L.over1m ?? 0) - L.delta
  return (
    `本批 ${row.snapshotDate}「1个月以上」余额 ${fmt(L.over1m)}；` +
    `上一批 ${L.prevSnapshotDate}「1个月以上」余额 ${fmt(prevOver1m)}；` +
    `推算流量（全量口径）= 消失的单 + 金额变小的部分 = ${fmt(L.flow)}`
  )
}

/**
 * 兜底看门狗：请求万一卡住，绝不能让整页被「加载中」遮罩永久盖住。
 *
 * 为什么需要：遮罩会**吃掉所有点击** —— 一旦 loading 因为任何原因没被复位，
 * 页面就变成「点什么都没反应」，而且看不出原因（2026-10-10 使用者就撞上过）。
 * 遮罩自己撤掉之后，至少能看见是空表、能继续操作。
 */
let watchdog = null
const WATCHDOG_MS = 20000

async function loadData(silent) {
  if (!silent) {
    loading.value = true
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      loading.value = false
    }, WATCHDOG_MS)
  }
  try {
    // 环比、回款、已开票全部由后端算好（需要逐单对比相邻两批，前端拿不到那些行）
    const data = await getTrend() // 不传 bizType，看全部
    trend.value = Array.isArray(data) ? data : []
  } catch (err) {
    console.error('[Trend] 加载失败:', err)
  } finally {
    if (!silent) {
      loading.value = false
      clearTimeout(watchdog)
    }
  }
}

onBeforeUnmount(() => clearTimeout(watchdog))

watch(current, () => {
  // 趋势页展示全部类型，切业务类型无需重载
})

/**
 * 导出趋势表为 PNG。
 * 与「数据总览」「客户平台看板」保持同一套写法：过滤 .no-export，
 * 否则上报图片里会拍进「导出图片」这个按钮本身。
 */
async function exportImage() {
  if (!exportEl.value || exporting.value) return
  exporting.value = true
  try {
    const dataUrl = await captureWithFullWidth(
      exportEl.value,
      toPng,
      {
        backgroundColor: '#ffffff',
        filter: (node) =>
          !(node instanceof Element && node.classList && node.classList.contains('no-export')),
      },
      { minWidth: 1200, minHeight: 800 }
    )
    if (!dataUrl) throw new Error('导出失败')
    const a = document.createElement('a')
    const today = new Date().toISOString().slice(0, 10)
    // 导出的就是眼前这张表（WYSIWYG）：收着就导 2 期，展开后导全部
    a.download = `趋势_${shownRangeText.value || today}.png`
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

/* 口径说明：常驻，不做成可关闭的 alert —— 这段话解释了「回款 / 已开票」为什么不是源表字段 */
.note {
  margin-bottom: 16px;
  padding: 10px 12px;
  background: #f4f4f5;
  border-left: 3px solid #909399;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.7;
  color: #606266;
}
.note b { color: #303133; }

.amount { font-weight: 600; color: #303133; }
/* 回款 / 已开票 是「流量」，用青绿区分于余额的深色；
   刻意不用红绿 —— 那两色在这页是环比涨跌的语义，混用会被误读 */
.flow { font-weight: 600; color: #0f6e56; }
.date-main { font-weight: 500; }
/* 副行小字：日期列的「较 MM-DD（隔 N 天）」和回款/已开票列的「较 MM-DD」共用，保证两处长得一样 */
.date-sub { font-size: 11px; color: #909399; margin-top: 2px; }
.up { color: #f56c6c; font-weight: 600; }
.down { color: #67c23a; font-weight: 600; }
.muted { color: #c0c4cc; }
small { font-size: 11px; }

/* 移动端：表格本来就横向滚动，这里只收一下容器内边距 */
@media (max-width: 768px) {
  .container { padding: 10px; }
  .note { font-size: 12px; }
}
</style>
