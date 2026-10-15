<template>
  <!--
    客户平台未回款金额看板 —— 2026-09-28 按使用者给的对标报表重做版式。

    版式（三张卡片纵向排列，与参考图一致）：
      ① 顶部深色标题条：<日期> 客户未回款平台金额合计（xx万）
                       第二行：较上期 ↓ xx万 (xx%) | 上期 xx万
      ② 账龄分布   账龄段 / 金额(元) / 订单数   —— 有「合计」行
      ③ 按业务员   业务员 / 金额(元) / 订单数   —— 有「合计」行
      ④ 按下单平台 平台   / 金额(元) / 订单数   —— 有「合计」行

    ⚠ 金额口径 2026-09-28 改为 sales_amount（销售金额），
      不再用 sales_amount_total（销售金额合计 = 导单销售金额，大 3 倍）。
      详见 server/routes/receivable.js 里 CPU_AMOUNT_COL 的注释。

    原来那套「4 张统计卡 + 按平台构成进度条 + 客户×平台宽表 + 筛选下拉」已被这个
    版式取代 —— 对标报表是发给领导的一页纸，不要筛选器，只要结论。
  -->
  <div class="container" v-loading="loading" ref="exportEl">
    <PageHeader title="客户平台未回款金额看板">
      <template #meta>
        <el-tag v-if="summary.snapshotDate" class="snapshot-tag" type="info" effect="plain">
          数据日期 {{ summary.snapshotDate }}（每周四更新）
        </el-tag>
      </template>
      <el-button
        class="no-export"
        type="primary"
        plain
        size="small"
        :loading="exporting"
        :disabled="loading"
        @click="exportImage"
      >
        导出看板图片
      </el-button>
    </PageHeader>

    <!-- ============ ① 顶部标题条 ============ -->
    <div class="banner">
      <div class="banner-title">
        {{ dateLabel }} 客户未回款平台金额合计（{{ wan(summary.total) }}万）
      </div>
      <div v-if="summary.prevTotal !== null" class="banner-sub">
        较 {{ prevDateLabel }}
        <span :class="deltaClass">{{ deltaArrow }} {{ wan(Math.abs(summary.deltaAmount || 0)) }}万（{{ pctText }}）</span>
        <span class="banner-sep">|</span>
        上期 {{ wan(summary.prevTotal) }}万
      </div>
    </div>

    <!-- ============ ② 账龄分布 ============ -->
    <section v-if="aging.length" class="panel">
      <div class="panel-head">账龄分布</div>
      <table class="grid">
        <colgroup>
          <col class="col-name" /><col class="col-amount" /><col class="col-count" />
        </colgroup>
        <thead>
          <tr>
            <th class="ta-left">账龄段</th>
            <th class="ta-right">金额(元)</th>
            <th class="ta-right">订单数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in aging" :key="r.segment" :class="{ 'row-warn': r.segment === '3个月以上' }">
            <td class="ta-left">{{ r.segment }}</td>
            <td class="ta-right amount">{{ fmt(r.total) }}</td>
            <td class="ta-right">{{ r.orderCount }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td class="ta-left">合计</td>
            <td class="ta-right amount">{{ fmt(agingTotal) }}</td>
            <td class="ta-right">{{ agingCount }}</td>
          </tr>
        </tfoot>
      </table>
    </section>

    <!-- ============ ③ 按业务员 ============ -->
    <section v-if="bySalesperson.length" class="panel">
      <div class="panel-head">按业务员</div>
      <table class="grid">
        <colgroup>
          <col class="col-name" /><col class="col-amount" /><col class="col-count" />
        </colgroup>
        <thead>
          <tr>
            <th class="ta-left">业务员</th>
            <th class="ta-right">金额(元)</th>
            <th class="ta-right">订单数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in bySalesperson" :key="r.salesperson">
            <td class="ta-left">{{ r.salesperson }}</td>
            <td class="ta-right amount">{{ fmt(r.total) }}</td>
            <td class="ta-right">{{ r.orderCount }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td class="ta-left">合计</td>
            <td class="ta-right amount">{{ fmt(spTotal) }}</td>
            <td class="ta-right">{{ spCount }}</td>
          </tr>
        </tfoot>
      </table>
    </section>

    <!-- ============ ④ 按下单平台 ============ -->
    <section v-if="byPlatform.length" class="panel">
      <div class="panel-head">按下单平台</div>
      <table class="grid">
        <colgroup>
          <col class="col-name" /><col class="col-amount" /><col class="col-count" />
        </colgroup>
        <thead>
          <tr>
            <th class="ta-left">平台</th>
            <th class="ta-right">金额(元)</th>
            <th class="ta-right">订单数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in byPlatform" :key="r.platform">
            <td class="ta-left">{{ r.platform }}</td>
            <td class="ta-right amount">{{ fmt(r.total) }}</td>
            <td class="ta-right">{{ r.orderCount }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td class="ta-left">合计</td>
            <td class="ta-right amount">{{ fmt(platTotal) }}</td>
            <td class="ta-right">{{ platCount }}</td>
          </tr>
        </tfoot>
      </table>
    </section>

    <el-empty v-if="!loading && !aging.length && !bySalesperson.length" description="暂无数据" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { toPng } from 'html-to-image'
import { captureWithFullWidth } from '@/utils/exportSize'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import PageHeader from '@/components/PageHeader.vue'
import {
  getCustomerPlatformSummary,
  getCustomerPlatformAging,
  getCustomerPlatformBySalesperson,
  getCustomerPlatformByPlatform,
} from '@/api'

const loading = ref(false)
const exporting = ref(false)
const exportEl = ref(null)

const summary = ref({
  total: 0,
  prevTotal: null,
  snapshotDate: null,
  prevSnapshotDate: null,
  deltaAmount: null,
  deltaPct: null,
})
const aging = ref([])
const bySalesperson = ref([])
const byPlatform = ref([])

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** 金额转「万」，保留 2 位 —— 参考图头部就是这个口径 */
function wan(v) {
  return (Number(v || 0) / 10000).toFixed(2)
}

/** 「9月24日」这种月日标签（参考图头部用的格式） */
function mdLabel(iso) {
  if (!iso) return ''
  const [, m, d] = iso.split('-')
  return `${Number(m)}月${Number(d)}日`
}

const dateLabel = computed(() => mdLabel(summary.value.snapshotDate))
const prevDateLabel = computed(() => mdLabel(summary.value.prevSnapshotDate))

/** 涨跌箭头：金额减少用绿（好），增加用红（坏）—— 与看板整体「红涨绿跌」相反，
 *  因为这是「未回款额」，降下来才是好事。这里只做图标方向，颜色交给 CSS 的 up/down 类。 */
const deltaArrow = computed(() => ((summary.value.deltaAmount ?? 0) <= 0 ? '↓' : '↑'))
const deltaClass = computed(() => ((summary.value.deltaAmount ?? 0) <= 0 ? 'down' : 'up'))
const pctText = computed(() => {
  const p = summary.value.deltaPct
  if (p === null || p === undefined) return ''
  // 后端给的是带正负号的百分比；参考图展示成「26.9%」，方向由箭头表达
  return `${Math.abs(p).toFixed(1)}%`
})

const agingTotal = computed(() => aging.value.reduce((s, r) => s + Number(r.total || 0), 0))
const agingCount = computed(() => aging.value.reduce((s, r) => s + Number(r.orderCount || 0), 0))
const spTotal = computed(() => bySalesperson.value.reduce((s, r) => s + Number(r.total || 0), 0))
const spCount = computed(() => bySalesperson.value.reduce((s, r) => s + Number(r.orderCount || 0), 0))
const platTotal = computed(() => byPlatform.value.reduce((s, r) => s + Number(r.total || 0), 0))
const platCount = computed(() => byPlatform.value.reduce((s, r) => s + Number(r.orderCount || 0), 0))

async function loadData(silent) {
  if (!silent) loading.value = true
  try {
    const [s, ag, sp, pl] = await Promise.all([
      getCustomerPlatformSummary(),
      getCustomerPlatformAging(),
      getCustomerPlatformBySalesperson(),
      getCustomerPlatformByPlatform(),
    ])
    summary.value = { ...summary.value, ...s }
    aging.value = ag.segments || []
    bySalesperson.value = sp.rows || []
    byPlatform.value = pl.rows || []
  } catch (err) {
    console.error('[CustomerPlatformUnpaid] 加载失败:', err)
  } finally {
    if (!silent) loading.value = false
  }
}

onMounted(loadData)
useAutoRefresh(loadData)

// ------------------------------------------------------------
// 导出看板图片：整页渲染成 PNG（这是发给领导的交付物）
// ------------------------------------------------------------
async function exportImage() {
  if (!exportEl.value) return
  exporting.value = true
  try {
    // 导出：先把元素临时撑宽到内容真正需要的宽度再截（见 utils/exportSize.js）。
    // 本页是固定 760px 版式，所以不给 1200 下限，否则右边会多出一大条空白。
    const dataUrl = await captureWithFullWidth(
      exportEl.value,
      toPng,
      {
        backgroundColor: '#eef2f7',
        cacheBust: true,
        // 排除「导出看板图片」按钮本身
        filter: (node) =>
          !(node instanceof Element && node.classList && node.classList.contains('no-export')),
      },
      { minWidth: 0, minHeight: 0 }
    )
    const name = `客户平台未回款_${summary.value.snapshotDate || new Date().toISOString().slice(0, 10)}.png`
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    console.error('[导出看板图片] 失败:', err)
    ElMessage.error('导出图片失败，请重试')
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped>
/* 参考图的底是浅灰蓝，卡片之间靠色差分开 */
.container {
  padding: 20px;
  background: #eef2f7;
  border-radius: 8px;
  /* 三张表按参考图是一列窄栏居中，不是撑满整屏 —— 撑满会让数字离标签太远 */
  max-width: 760px;
}

/* ---------------- ① 顶部标题条 ---------------- */
.banner {
  background: #2c3e50;
  color: #fff;
  border-radius: 10px;
  padding: 16px 20px;
  text-align: center;
  margin-bottom: 14px;
}
.banner-title { font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
.banner-sub { margin-top: 6px; font-size: 13px; color: #b8c7d6; }
.banner-sep { margin: 0 8px; color: #6b8299; }
/* 未回款额下降是好事 → 绿；上升是坏事 → 红。
   注意这与看板整体的「红涨绿跌」取值方向相反，因为这里量的是「欠款」。 */
.banner-sub .down { color: #4ade80; }
.banner-sub .up { color: #ff8a80; }

/* ---------------- 通用：表格卡片 ---------------- */
.panel {
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 14px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.panel-head {
  background: #2c3e50;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  padding: 10px 16px;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  /* 固定布局 + colgroup 定宽，保证三张表的「金额/订单数」两列严格对齐 —— 
     参考图里三张表右边缘是完全齐的 */
  table-layout: fixed;
}
.col-name { width: auto; }
.col-amount { width: 210px; }
.col-count { width: 110px; }

.grid th,
.grid td {
  padding: 11px 16px;
  font-size: 14px;
  border-bottom: 1px solid #edf0f3;
  color: #303133;
}
.grid thead th {
  color: #909399;
  font-weight: 400;
  font-size: 13px;
  background: #fff;
}
.grid tbody tr:last-child td { border-bottom: none; }
.grid tfoot td {
  font-weight: 700;
  color: #303133;
  background: #fafbfc;
  border-top: 1px solid #e4e7ed;
}

/* 金额：右对齐 + 等宽数字 + 千分位（参考图里金额是加粗的） */
.amount {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.grid tbody .amount { color: #303133; }
/* 「3个月以上」是风险最高的一档，参考图用红色 + 左侧红条 + 淡红底强调 */
.row-warn td {
  background: #fef0f0;
  color: #f56c6c;
  font-weight: 600;
}
.row-warn td:first-child {
  box-shadow: inset 3px 0 0 #f56c6c;
}
.row-warn .amount { color: #f56c6c; }

.ta-left { text-align: left; }
.ta-right { text-align: right; }

/* ---------------- 移动端 ---------------- */
@media (max-width: 768px) {
  .container { padding: 10px; }
  .banner { padding: 13px 12px; border-radius: 8px; }
  .banner-title { font-size: 15px; }
  .banner-sub { font-size: 11px; }
  .panel-head { font-size: 13px; padding: 9px 12px; }
  .grid th,
  .grid td { padding: 9px 10px; font-size: 12px; }
  .grid thead th { font-size: 11px; }
  .col-amount { width: 118px; }
  .col-count { width: 62px; }
}
</style>
