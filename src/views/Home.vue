<template>
  <div class="home" v-loading="loading" ref="homeEl">
    <PageHeader :title="`${summary.bizLabel || biz.label} 概览`">
      <template #meta>
        <!-- 数据日期放在标题旁边并做成标签：原来在最右边是一行 13px 浅灰小字，很容易看漏 -->
        <el-tag v-if="summary.snapshotDate" class="snapshot-tag" type="info" effect="plain">
          数据日期 {{ summary.snapshotDate }}
        </el-tag>
      </template>
      <!-- 导出看板图片：整页 PNG，是发给领导的交付物 -->
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
            <div class="stat-value danger">{{ num(summary.total) }}</div>
            <div class="stat-unit">元</div>
            <!-- 较上期：拿不到上期就整块不渲染（不显示 0.0%，那会被读成「没变化」） -->
            <div v-if="deltas.total" class="stat-delta" :class="deltas.total.cls">
              {{ deltas.total.text }}
              <span v-if="deltas.total.pct" class="delta-pct">({{ deltas.total.pct }})</span>
              <span class="delta-base">{{ prevLabel }}</span>
            </div>
          </el-card>
        </el-col>

        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="hover" class="stat-card">
            <div class="stat-label">3个月以上</div>
            <div class="stat-value warning">{{ num(summary.over3m) }}</div>
            <div class="stat-unit">占比 {{ (summary.over3mRatio * 100).toFixed(1) }}%</div>
            <div v-if="deltas.over3m" class="stat-delta" :class="deltas.over3m.cls">
              {{ deltas.over3m.text }}
              <span v-if="deltas.over3m.pct" class="delta-pct">({{ deltas.over3m.pct }})</span>
              <span class="delta-base">{{ prevLabel }}</span>
            </div>
          </el-card>
        </el-col>

        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="hover" class="stat-card">
            <div class="stat-label">单据数</div>
            <div class="stat-value primary">{{ summary.invoiceCount }}</div>
            <div class="stat-unit">{{ summary.customerCount }} 个客户</div>
            <!-- 单据数用中性色：单数变多不等于坏事 -->
            <div v-if="deltas.invoiceCount" class="stat-delta is-neutral">
              {{ deltas.invoiceCount.text }}
              <span class="delta-base">{{ prevLabel }}</span>
            </div>
          </el-card>
        </el-col>

        <el-col :xs="24" :sm="12" :lg="6">
          <el-card shadow="hover" class="stat-card">
            <div class="stat-label">涉及业务员</div>
            <div class="stat-value">{{ summary.salespersonCount }}</div>
            <div class="stat-unit">人</div>
            <div v-if="deltas.salespersonCount" class="stat-delta is-neutral">
              {{ deltas.salespersonCount.text }}
              <span class="delta-base">{{ prevLabel }}</span>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <!--
        对比基准说明条。
        为什么要写这一行：同步不是每天都跑（实测 09-24 之后直接跳到 09-28），
        所以「上期」有时是昨天、有时是四五天前。不写明天数，看的人会默认以为是「昨天」，
        从而误判涨跌金额的严重程度 —— 「一天涨 7.5 万」和「五天涨 7.5 万」完全是两回事。
      -->
      <!-- no-export（2026-10-14 使用者「注释也不要了」）：这段对比基准说明只在屏幕上看，
           导出的图里不要 —— 领导看的图不该带这些过程性注释。 -->
      <div v-if="summary.prev" class="delta-note no-export">
        <span class="delta-note-icon">↕</span>
        <span>对比基准 <b>{{ summary.prev.snapshotDate }}</b></span>
        <span v-if="prevGapDays !== null" class="delta-note-gap">
          距本批 {{ prevGapDays }} 天
        </span>
        <!-- 四项全持平 → 基本可以确定本批与上批是同一份数据 -->
        <span v-if="prevIdentical" class="delta-note-same">
          本批与上批四个指标完全相同，源表可能尚未更新
        </span>
        <span v-else class="delta-note-muted">
          {{ prevGapDays === 1 ? '即上一批数据' : '期间没有同步记录，涨跌为此期间的累计变化' }}
        </span>
      </div>

      <!--
        账龄结构卡已删除（2026-10-13 使用者：「这个账龄结构可以删掉了」「作用不大」）。
        删掉的理由：5 档金额 = 下面「业务员 × 账龄段」矩阵的合计行 = 顶部「总额」卡片拆分，
        静态数字重复三遍；10-12 加过「较上期」想救一下，但源表没更新时 5 档全是「持平」，仍无信息量。
        配套删掉的还有：agingList / agingPrev / agingRows / agingDeltas / agingPrevDate、
        agingPercent / agingOrder / agingColor、loadAll 里的 getAgingSummary 请求、以及 .aging-* 样式。
        ⚠️ 后端 `/api/aging-summary` 保留（别的页面/脚本可能在用，删了怕连累）。
      -->

      <!-- 业务员 × 账龄段：一张矩阵表，跟发领导的 Excel 汇总同构 -->
      <el-card shadow="never" class="block-card">
        <template #header>
          <span class="card-title">业务员 × 账龄段</span>
          <span class="card-hint">按合计倒序 · 同一行看一个人的全部账龄</span>
        </template>
        <el-table
          :data="matrixRows"
          border
          class="matrix"
          :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
          :cell-style="{ padding: '8px 0' }"
          show-summary
          :summary-method="matrixSummary"
        >
          <el-table-column prop="name" label="业务员" min-width="190">
            <template #default="{ row }">
              <span class="mx-name">{{ row.name }}</span>
              <el-tag v-if="row.dept" size="small" type="info" class="mx-dept">{{ row.dept }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-for="col in AGING_COLUMNS"
            :key="col.field"
            :prop="col.field"
            :label="col.label"
            min-width="128"
            align="right"
          >
            <template #default="{ row }">
              <span class="mx-amt" :class="{ 'is-zero': !row[col.field] }">{{ num(row[col.field]) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="total" label="合计" min-width="150" align="right">
            <template #default="{ row }">
              <span class="mx-total">{{ num(row.total) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="docCount" label="单数" width="82" align="right">
            <template #default="{ row }">
              <span class="mx-doc">{{ row.docCount }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <!--
        当日明细（2026-10-14）：先加「当日回款明细」，随后使用者「新增的也加上」⇒ 两张同款表，新增在上、回款在下
        （与「本期变动」块的分组顺序一致）。

        🔴 **只未回款线**：未开票线对应「当日已开票 / 当日新增的已发货未开票」，使用者明确「开票的先不要」⇒ 切过去两张都不渲染
           （由 `detailGroups` computed 返回空数组实现，不用在这里写 v-if）。
        🔴 **要进导出图**（10-14 晚使用者「导出的图片怎么没有回款的」）—— 所以**不能挂 `no-export`**，
           导出前也不再把它们移除。代价：图会随明细行数变高。
        🔴 表尾合计用 `detailSummary`：**el-table 自带求和出的是裸数字**（45052.81），全站金额要千分位 + 2 位小数。
      -->
      <el-card v-for="g in detailGroups" :key="g.key" shadow="never" class="block-card">
        <template #header><span class="card-title">{{ g.title }}</span></template>
        <el-table
          :data="g.rows"
          border
          class="pay-detail"
          :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
          :cell-style="{ padding: '8px 0' }"
          show-summary
          :summary-method="detailSummary"
        >
          <el-table-column prop="doc_no" label="单据编号" min-width="130" show-overflow-tooltip />
          <el-table-column prop="customer_name" label="客户名称" min-width="260" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="110" />
          <el-table-column prop="aging_category" label="账龄" width="160" show-overflow-tooltip />
          <el-table-column prop="amt" label="金额（元）" min-width="140" align="right">
            <template #default="{ row }"><span class="mx-amt">{{ num(row.amt) }}</span></template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <!-- 2026-10-14：「本期变动」整块移到「每日发货·回款」独立页，概览页不再放（导出图因此变横版）。
         那块是同一个组件、明细最长得 115 行，摆在概览页只会把导出的图拉成竖条。 -->
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { toPng } from 'html-to-image'
import { captureWithFullWidth } from '@/utils/exportSize'
import { storeToRefs } from 'pinia'
import { useBizStore } from '@/stores/biz'
import { useAutoRefresh } from '@/composables/useAutoRefresh'
import { getSummary, getAgingBySalesperson, getLineDelta } from '@/api'
import PageHeader from '@/components/PageHeader.vue'

const biz = useBizStore()
const { current } = storeToRefs(biz)

const loading = ref(false)
const exporting = ref(false)
const homeEl = ref(null)
const salespersonList = ref([])

/**
 * `/home` 底部两张明细表的数据（2026-10-14：先加「当日回款明细」，随后使用者「新增的也加上」）。
 *
 * 🔴 **只做未回款线**（已开票未回款 tab）—— 未开票线对应的是「当日已开票 / 当日新增的已发货未开票」，
 *    使用者明确说「开票的先不要」，所以未开票页签下两张表都不渲染（`v-if="deltaDetail"`）。
 * 🔴 数据都是**推算值**：源表是「还没回款」的快照，单子结清后会消失；
 *    `removed` = 上一批有、这一批没有的单（+ 金额变小的部分）；`added` = 上一批没有的新单。
 *    两者都是**全量口径（含当月）**，与 /trend 的「当日回款 / 当日新增」同源同口径。
 * 🔴 `added` 只取**真新增**（账龄「当月」档）；补录（老单补登记）不混进来 ——
 *    使用者 10-14 明确「不要上一次表里面摸鱼出现的就爆出来」（后端已拆成 `backfilled`）。
 * 一次请求就能拿到两组，别拉两次。
 */
const deltaDetail = ref(null)

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
  avgAmount: null,
  // 上期对比：后端给的「上一个可用批次」（不是严格的「昨天」——
  // 同步不是每天都跑，按昨天找会大面积取不到）。取不到就是 null，整块不渲染。
  prev: null,
})

/**
 * 算一个指标的环比。
 * 返回 { text, cls, title }，或者 null（没有可比数据时）。
 *
 * 三条设计决定：
 *  1) **拿不到上期就返回 null**，不写死 0、不显示「0.0%」——
 *     0.0% 会让人读成「和上次一模一样」，而真相是「没有可比数据」。
 *  2) **涨跌颜色按全站金额语义**：涨红 / 跌绿（应收款减少是好事，用绿）。
 *  3) **单据数/业务员数这类"个数"不套金额配色**（见 neutral 参数）——
 *     单数变多不代表坏事，套红绿会误导。
 *
 * @param cur    本期值
 * @param prev   上期值
 * @param opts   { money: 是否金额（决定是否显示百分比）, neutral: 是否中性色 }
 */
function delta(cur, prev, opts = {}) {
  const { money = false, neutral = false } = opts
  if (prev === null || prev === undefined || summary.prev === null) return null
  const c = Number(cur) || 0
  const p = Number(prev) || 0
  // 就地舍到分，不引用文件后面定义的 round2（const 箭头函数没有提升，
  // 虽然渲染时才调用不会真报错，但不该埋这个依赖顺序的坑）
  const diff = Math.round((c - p) * 100) / 100

  // 个数类（单据数/业务员数）一律中性灰：涨多涨少都不直接代表好坏，
  // 套「涨红跌绿」会让人以为单数变多是坏事。
  let cls
  if (neutral) {
    cls = diff === 0 ? 'is-flat' : 'is-neutral'
  } else if (diff > 0) {
    cls = 'is-up'      // 应收款增加 → 红（与全站金额语义一致）
  } else if (diff < 0) {
    cls = 'is-down'    // 应收款减少 → 绿（好事）
  } else {
    cls = 'is-flat'
  }

  let text
  if (diff === 0) {
    text = '持平'
  } else {
    // 主看差值绝对值；百分比另起一段显示。用 U+2212 数学负号（−）与数字等宽更好看
    text = `${diff > 0 ? '+' : '−'}${money ? num(Math.abs(diff)) : Math.abs(diff)}`
  }

  // 百分比：上期为 0 时无意义；已经「持平」时也不显示 ——
  // 「持平 (<0.1%)」读起来自相矛盾。
  // 另外绝对值小于 0.05% 会被 toFixed(1) 显示成 "-0.0%" / "0.0%"，
  // 那是坏读数（看着像没变化但实际有变化，还带负号），统一降级成「<0.1%」。
  let pct = null
  if (diff !== 0 && p !== 0) {
    const raw = (diff / Math.abs(p)) * 100
    pct = Math.abs(raw) < 0.05
      ? '<0.1%'
      : `${raw > 0 ? '+' : '−'}${Math.abs(raw).toFixed(1)}%`
  }
  return { text, cls, pct, diff, prevDate: summary.prev?.snapshotDate || '' }
}

// 金额格式（千分位 + 2 位小数）
function num(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// ------------------------------------------------------------
// 业务员 × 账龄段 矩阵表
// 行 = 业务员（按合计倒序），列 = 5 个账龄段 + 合计 + 单数
// ------------------------------------------------------------
const AGING_COLUMNS = [
  { label: '3个月以上', field: 'over3m' },
  { label: '3个月', field: 'm3' },
  { label: '2个月', field: 'm2' },
  { label: '1个月', field: 'm1' },
  { label: '当月', field: 'currentMonth' },
]

const matrixRows = computed(() =>
  salespersonList.value
    .map((r) => ({
      name: r.salesperson,
      dept: r.department,
      docCount: Number(r.docCount || 0),
      over3m: Number(r.over3m || 0),
      m3: Number(r.m3 || 0),
      m2: Number(r.m2 || 0),
      m1: Number(r.m1 || 0),
      currentMonth: Number(r.currentMonth || 0),
      total: Number(r.total || 0),
    }))
    .sort((a, b) => b.total - a.total)
)

// 合计行：逐列求和。先逐格相加再统一舍到 2 位，避免浮点噪声累积出 1 分钱
const round2 = (v) => Math.round(v * 100) / 100

function matrixSummary({ columns }) {
  return columns.map((col, i) => {
    if (i === 0) return '合计'
    const p = col.property
    const sum = matrixRows.value.reduce((a, r) => a + Number(r[p] || 0), 0)
    return p === 'docCount' ? String(sum) : num(round2(sum))
  })
}

/**
 * 「当日回款明细」的表尾合计——只说一句「合计多少钱」。
 * 2026-10-14：原来这些信息（张数 / 合计 / 基准日期 / 口径）全堆在标题右侧，使用者圈掉说「这里的注释就不要了」，
 * 于是合计挪到表尾（与上面矩阵表同一个做法），其余交给页头的「对比基准」那条和表格本身的行数。
 * ⚠️ 用它而不是 el-table 自带的求和：金额列要**千分位 + 2 位小数**（跟全站一致），自带的会出裸数字。
 */
/**
 * 底部当日明细的分组：新增在上、回款在下（与「本期变动」块的分组顺序一致）。
 *
 * 模板里只写一个 `v-for`，分组的有无全在这里决定：
 *  · 切到未开票线 ⇒ `deltaDetail` 为 null ⇒ 返回空数组（两张都不渲染）
 *  · 某组 0 张 ⇒ 过滤掉，不留一张空表
 *
 * ⚠️ 2026-10-14 晚：**这两张表现在要进导出图**（使用者「导出的图片怎么没有回款的」——
 *    早上他选的是「不进导出图」，后来发现图上少了回款明细，改回来了）。
 *    所以这里**没有** `exporting` 那道过滤，卡片上也没挂 `no-export`。
 *    代价：导出图会随明细行数变高（当天 2 张表约 +400px 逻辑高度）。
 */
const detailGroups = computed(() => {
  const d = deltaDetail.value
  if (!d) return []
  return [
    { key: 'added', title: '当日新增明细', rows: d.added },
    { key: 'removed', title: '当日回款明细', rows: d.removed },
  ].filter((g) => g.rows.length)
})

/**
 * 当日明细的表尾合计 —— 直接按**表里的行**求和（不是取接口字段）。
 * 2026-10-14：原来「张数 / 合计 / 基准日期 / 口径」全堆在标题右侧，使用者圈掉说「这里的注释就不要了」，
 * 于是合计挪到表尾（与上面矩阵表同一做法）。标题旁不再挂任何说明。
 * ⚠️ 不能用 el-table 自带的求和：它出的是**裸数字**（45052.81），全站金额一律千分位 + 2 位小数。
 */
function detailSummary({ columns, data }) {
  const total = (data || []).reduce((a, r) => a + Number(r.amt || 0), 0)
  return columns.map((col, i) => (i === 0 ? '合计' : i === columns.length - 1 ? num(round2(total)) : ''))
}

// ------------------------------------------------------------
// 账龄分档：固定顺序（3个月以上 → 当月）
// 接口返回顺序不保证稳定，两个业务类型下会不一样，看着不整齐；这里统一按账龄从老到新排
// ------------------------------------------------------------
/** 单均金额 = 总额 ÷ 单据数。后端也返回 avgAmount，这里保持一致算法 */
const avgAmount = computed(() => {
  const n = Number(summary.invoiceCount) || 0
  return n > 0 ? Number(summary.total || 0) / n : null
})

/**
 * 4 张指标卡的环比。全部走同一个 delta()，保证口径一致。
 * 金额类（总额 / 3个月以上 / 单均）与个数类（单据数 / 业务员）分开配色。
 */
const deltas = computed(() => {
  const p = summary.prev
  if (!p) {
    return { total: null, over3m: null, invoiceCount: null, salespersonCount: null, avgAmount: null }
  }
  return {
    total: delta(summary.total, p.total, { money: true }),
    over3m: delta(summary.over3m, p.over3m, { money: true }),
    invoiceCount: delta(summary.invoiceCount, p.invoiceCount, { neutral: true }),
    salespersonCount: delta(summary.salespersonCount, p.salespersonCount, { neutral: true }),
    avgAmount: delta(avgAmount.value, p.avgAmount, { money: true }),
  }
})

/** 对比说明文案：「较 2026-09-28（1 天前）」 */
const prevLabel = computed(() => {
  const p = summary.prev
  if (!p) return ''
  return `较 ${p.snapshotDate}`
})

/** 距上期多少天，用于提示「这个对比跨了几天」 */
const prevGapDays = computed(() => {
  const p = summary.prev
  if (!p || !summary.snapshotDate) return null
  const a = new Date(p.snapshotDate + 'T00:00:00')
  const b = new Date(summary.snapshotDate + 'T00:00:00')
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null
  return Math.round((b - a) / 86400000)
})

/**
 * 四个指标全部持平 → 几乎可以断定本批与上批是同一份数据（源表还没更新）。
 *
 * 为什么值得单独提示：早上同步时源表常常还没出当天数据，这时看板 4 张卡全是「持平」，
 * 看的人第一反应是「系统是不是坏了 / 同步是不是没跑」。
 * 直接说明「源表尚未更新」能省掉一轮排查。
 * （判定用四项全等，而不是只看总额 —— 单看一个指标可能恰好抵消。）
 */
const prevIdentical = computed(() => {
  const p = summary.prev
  if (!p) return false
  return (
    Number(summary.total) === Number(p.total) &&
    Number(summary.over3m) === Number(p.over3m) &&
    Number(summary.invoiceCount) === Number(p.invoiceCount) &&
    Number(summary.salespersonCount) === Number(p.salespersonCount)
  )
})

async function loadAll(silent) {
  if (!silent) loading.value = true
  try {
    const [s, bysp] = await Promise.all([
      getSummary(current.value),
      getAgingBySalesperson(current.value),
    ])
    // 先清 prev 再合并：切业务类型时若新数据没有 prev（该线只有一个批次），
    // Object.assign 不会删掉旧键，卡片上会残留**上一条业务线**的对比数字。
    // 这类「看起来正常但其实串味」的假数据最难发现，所以显式清掉。
    summary.prev = null
    Object.assign(summary, s)
    // 后端可能返回 prev: undefined（老版本接口），统一归一成 null
    if (!summary.prev) summary.prev = null
    salespersonList.value = bysp.records || []

    // 「当日新增 / 回款明细」：只未回款线拉一次（复用 line-delta，不是新增后端负担）。
    // 切到未开票线时显式置 null ⇒ 两张表都不渲染（使用者 10-14：「开票的先不要」）。
    // 单独 try：这块挂了不该把上面四张卡一起拖黑。
    deltaDetail.value = null
    if (current.value === 'billed_unpaid') {
      try {
        const d = await getLineDelta('billed_unpaid')
        deltaDetail.value = {
          added: d?.added || [],       // 真新增（账龄「当月」档），补录不含
          removed: d?.removed || [],   // 回款
          prevDate: d?.prevDate || '',
        }
      } catch (e) {
        console.error('[Home] 当日明细加载失败:', e)
      }
    }
  } catch (err) {
    console.error('[Home] 加载失败:', err)
  } finally {
    if (!silent) loading.value = false
  }
}

watch(current, () => {
  // 🔴 切业务类型**立刻**清掉两张当日明细表，不能等 loadAll 里那串请求回来才清 ——
  //    否则切到未开票线之后有几秒钟还挂着**上一条线**的单（串味）。
  //    与卡片上 `summary.prev = null` 是同一个道理：看着正常、其实是别的线的数据，最难发现。
  deltaDetail.value = null
  loadAll()
})
onMounted(loadAll)
useAutoRefresh(loadAll)

// ------------------------------------------------------------
// 导出看板图片：把 Home 根节点渲染成 PNG 下载
// ------------------------------------------------------------
async function exportImage() {
  if (!homeEl.value) return
  exporting.value = true
  try {
    const el = homeEl.value
    // 导出：captureWithFullWidth 会先把元素临时撑到「根+全部后代」所需的最大宽度再截，
    // 保证表格不横向滚动、右边不会被裁（笔记本上「合计」列曾只剩半截）。详见 utils/exportSize.js
    const dataUrl = await captureWithFullWidth(
      el,
      toPng,
      {
        backgroundColor: '#ffffff',
        cacheBust: true,
        // 导出时排除「导出看板图片」按钮本身：上报图片里不该出现这个按钮
        filter: (node) =>
          !(node instanceof Element && node.classList && node.classList.contains('no-export')),
      },
      { minWidth: 1200, minHeight: 800 }
    )
    const name = `看板_${summary.bizLabel || biz.label}_${summary.snapshotDate || new Date().toISOString().slice(0, 10)}.png`
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
.home { padding: 4px; }
/* 头部已交给 PageHeader 组件统一（标题字号、日期标签、右侧导出按钮位置） */
.warn-alert { margin-bottom: 18px; }
.warn-body { font-size: 13px; line-height: 1.9; }
.stat-row { row-gap: 20px; }
.stat-card {
  border-radius: 8px;
  transition: all 0.3s ease;
}
.stat-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}
.stat-label { font-size: 14px; color: #909399; margin-bottom: 12px; }
.stat-value {
  font-size: 26px;
  font-weight: 700;
  color: #303133;
  line-height: 1.2;
  transition: color 0.3s ease;
}
.stat-value.primary { color: #409eff; }
.stat-value.warning { color: #e6a23c; }
.stat-value.danger  { color: #f56c6c; }
.stat-unit { font-size: 12px; color: #c0c4cc; margin-top: 6px; }

/* ====== 较上期涨跌 ======
   金额语义色沿用全站约定：涨红 / 跌绿（应收款减少是好事）。
   单据数与业务员数用中性灰 —— 单数变多不代表坏事，套红绿会误导。 */
.stat-delta {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  animation: fadeIn 0.5s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-5px); }
  to { opacity: 1; transform: translateY(0); }
}
.stat-delta.is-up   { color: #f56c6c; }
.stat-delta.is-down { color: #67c23a; }
.stat-delta.is-flat { color: #909399; }
.stat-delta.is-neutral { color: #909399; }
.delta-pct { font-size: 12px; font-weight: 500; opacity: 0.85; }
/* 「较 2026-09-28」与前面的数字拉开距离，否则会挤成「(+1.5%)较 2026-09-28」 */
.delta-base { font-size: 12px; font-weight: 400; color: #c0c4cc; margin-left: 8px; }

/* 对比基准说明条 */
.delta-note {
  margin-top: 12px;
  padding: 8px 12px;
  background: #f4f6f9;
  border-radius: 6px;
  font-size: 12px;
  color: #606266;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  animation: slideIn 0.4s ease-out;
}
@keyframes slideIn {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}
.delta-note-icon { color: #909399; font-weight: 700; }
.delta-note-gap { color: #909399; }
.delta-note-muted { color: #c0c4cc; margin-left: 6px; }
/* 四项全持平时的提示：用橙色，比灰字更醒目 —— 这条是「为什么没变化」的答案 */
.delta-note-same { color: #e6a23c; margin-left: 6px; }
.block-card {
  margin-top: 20px;
  border-radius: 8px;
  transition: all 0.3s ease;
}
.block-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.card-title { font-weight: 600; color: #303133; }
/* .aging-* 样式随「账龄结构」卡一起删除（2026-10-13）—— 保留 @keyframes fadeRow 会被清理器报未使用，故一并删 */
.strong { font-weight: 600; color: #f56c6c; }
.card-hint { margin-left: 10px; font-size: 12px; color: #909399; }
/* 明细表尾合计：加粗 + 深色，跟矩阵表的表尾一致（表尾是「数据」不是「注释」，所以不删） */
.pay-detail :deep(.el-table__footer .cell) { font-weight: 700; color: #303133; }
/* ---------- 业务员 × 账龄段 矩阵表 ---------- */
/* 等宽数字，保证各行金额小数点对齐，扫一眼就能比大小 */
.matrix :deep(.el-table__footer .cell) { font-weight: 700; color: #303133; }
.mx-name { font-weight: 600; color: #303133; }
.mx-dept { margin-left: 6px; }
.mx-amt {
  font-variant-numeric: tabular-nums;
  color: #606266;
  transition: color 0.2s ease;
}
.mx-amt:hover { color: #409eff; }
.mx-amt.is-zero { color: #c0c4cc; }
.mx-total {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: #f56c6c;
}
.mx-doc { font-variant-numeric: tabular-nums; color: #909399; }
.empty-tip { margin-top: 12px; font-size: 13px; color: #909399; line-height: 2; }
.empty-tip code { background: #f5f7fa; padding: 2px 8px; border-radius: 4px; font-family: Consolas, Monaco, monospace; }

/* 数据日期标签脉冲效果 */
.snapshot-tag {
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

/* 移动端适配 */
@media (max-width: 768px) {
  .home { padding: 10px; }
  /* 头部字号/间距/按钮换行由 PageHeader 组件自己处理 */

  .stat-row { row-gap: 12px; }
  .stat-card { padding: 14px 12px; }
  .stat-label { font-size: 12px; }
  /* 金额字号随屏宽自适应（16~22px），极端窄屏也完整显示不截断；
     overflow-wrap 兜底，防止任何情况下数字被卡片裁掉 */
  .stat-value { font-size: clamp(16px, 6.5vw, 22px); overflow-wrap: anywhere; }
  .stat-unit { font-size: 11px; }
  .stat-delta { font-size: 12px; }
  .delta-base { display: none; }   /* 窄屏放不下，基准日期已在下方说明条里 */
  .delta-note { font-size: 11px; }
  .delta-note-muted { display: none; }

  .block-card { margin-top: 12px; }
  .card-title { font-size: 14px; }
  .card-hint { display: none; }

  :deep(.el-table) { font-size: 11px; min-width: 500px; }
  :deep(.el-table th),
  :deep(.el-table td) { padding: 6px 4px !important; }
}
</style>
