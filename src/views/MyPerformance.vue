<template>
  <div class="container" ref="pageRef" v-loading="loading">
    <PageHeader ref="headerRef" title="我的业绩" sub="选择你的业务员姓名，自动过滤所有数据">
      <!-- 导出区域：这一页是业务员拿去汇报用的，图片直接发出去、Excel 留着自己再算。
           没有数据时按钮置灰（导出一张空表没有意义）。 -->
      <el-tooltip :disabled="canExport" content="当前账号没有导出权限，请联系管理员" placement="top">
        <span class="no-export" style="display: inline-flex; gap: 8px">
          <el-button
            type="primary"
            plain
            :loading="exportingImg"
            :disabled="!selectedSalesperson || !hasAnyData || !canExport"
            @click="onExportImage"
          >
            <el-icon v-if="!exportingImg" style="margin-right: 4px"><Picture /></el-icon>
            {{ exportingImg ? '生成中…' : '导出图片' }}
          </el-button>
          <el-button
            type="primary"
            :loading="exportingXlsx"
            :disabled="!selectedSalesperson || !hasAnyData || !canExport"
            @click="onExportExcel"
          >
            <el-icon v-if="!exportingXlsx" style="margin-right: 4px"><Download /></el-icon>
            {{ exportingXlsx ? '导出中…' : '导出 Excel' }}
          </el-button>
        </span>
      </el-tooltip>
    </PageHeader>

    <!-- ====== 业务员选择 ====== -->
    <el-card shadow="never" class="select-card">
      <div class="select-row">
        <span class="label">当前查看：</span>
        <el-select
          v-model="selectedSalesperson"
          placeholder="选择业务员"
          size="large"
          filterable
          clearable
          style="width: 240px"
          @change="onSalespersonChange"
        >
          <el-option
            v-for="sp in salespersonList"
            :key="sp.name"
            :label="sp.name"
            :value="sp.name"
          />
        </el-select>
        <el-tag v-if="selectedSalesperson" type="success" size="large" class="current-tag">
          {{ selectedSalesperson }}
        </el-tag>
        <el-tag v-else type="info" size="large">全部业务员</el-tag>
        <span class="muted" style="margin-left: 8px;">共 {{ salespersonList.length }} 人</span>
      </div>
    </el-card>

    <!-- ====== 业务类型切换 ====== -->
    <el-radio-group v-model="currentBiz" class="biz-switch" size="default" @change="onBizChange">
      <el-radio-button value="billed_unpaid">已开票未回款</el-radio-button>
      <el-radio-button value="shipped_uninvoiced">已发货未开票</el-radio-button>
      <el-radio-button value="customer_platform">客户平台未回款</el-radio-button>
    </el-radio-group>

    <!-- ====== 空状态 ====== -->
    <el-empty v-if="!loading && !selectedSalesperson" description="请先选择业务员">
      <div class="empty-tip">
        <p>选择后，上方卡片、账龄分布与明细都会自动按这个人过滤。</p>
        <p class="muted">下拉框支持输入姓名搜索。共 {{ salespersonList.length }} 位业务员可选。</p>
      </div>
    </el-empty>

    <el-empty v-else-if="!loading && !hasAnyData" :description="`${selectedSalesperson} 在当前类型下没有未回款记录`">
      <div class="empty-tip">
        <p>可能的原因：这位业务员不负责「{{ bizLabel }}」这条业务线，或数据尚未同步。</p>
        <p class="muted">试试切换到其他业务类型；如果是同一个人，一般都能在客户平台未回款里查到。</p>
      </div>
    </el-empty>

    <!-- ====== 已开票 / 已发货 的 4 张指标卡 ======
         只在非客户平台标签下出现。这三个业务类型的口径完全不同（来源表都不是同一张），
         以前无论切到哪个标签都显示这一排「已开票」数字，会让人以为客户平台也这么大金额。 -->
    <el-row :gutter="16" class="cards" v-if="currentBiz !== 'customer_platform' && mySummary.hasData">
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">未回款总额（元）</div>
          <div class="card-value amount">{{ fmt(mySummary.total) }}</div>
          <div class="card-sub">{{ mySummary.snapshotDate || '暂无数据' }}</div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">3个月以上（元）</div>
          <div class="card-value amount warning">{{ fmt(mySummary.over3m) }}</div>
          <div class="card-sub">占比 {{ (mySummary.over3mRatio * 100).toFixed(1) }}%</div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">单据数</div>
          <div class="card-value">{{ mySummary.invoiceCount }}</div>
          <div class="card-sub">{{ mySummary.customerCount }} 个客户</div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">单均金额（元）</div>
          <div class="card-value amount">{{ fmt(avgBilledAmount) }}</div>
          <div class="card-sub">总额 ÷ {{ mySummary.invoiceCount }} 张单据</div>
        </div>
      </el-col>
    </el-row>

    <!-- ====== 客户平台的 4 张指标卡 ====== -->
    <el-row :gutter="16" class="cards" v-if="currentBiz === 'customer_platform' && cpSummary.total > 0">
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">客户平台未回款（元）</div>
          <div class="card-value amount">{{ fmt(cpSummary.total) }}</div>
          <div class="card-sub">{{ cpSummary.snapshotDate || '暂无数据' }}</div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">较上期（元）</div>
          <div class="card-value" :class="cpDeltaClass">{{ cpDeltaText }}</div>
          <div class="card-sub">
            <template v-if="cpSummary.prevTotal != null">
              上期 {{ cpSummary.prevSnapshotDate }} · {{ fmtWan(cpSummary.prevTotal) }}万
            </template>
            <template v-else>暂无上期可比数据</template>
          </div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <!-- 后端字段是 orderCount（订单行数），原先写 invoiceCount 取不到值，
               卡片恒显示 0，看起来像「没有单」 -->
          <div class="card-label">订单数</div>
          <div class="card-value">{{ cpSummary.orderCount ?? 0 }}</div>
          <div class="card-sub">{{ cpSummary.platformCount || 0 }} 个平台</div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">客户数</div>
          <div class="card-value">{{ cpSummary.customerCount || 0 }}</div>
          <div class="card-sub">涉及客户</div>
        </div>
      </el-col>
    </el-row>

    <!-- ====== 账龄分布：老 → 新，与看板口径一致 ====== -->
    <el-card class="block aging-block" shadow="never" v-if="currentBiz === 'customer_platform' && cpSummary.total > 0">
      <template #header>
        <div class="card-head">
          <b>我的账龄分布</b>
          <span class="head-sub">{{ cpSummary.snapshotDate }}</span>
        </div>
      </template>
      <div class="aging-list">
        <div v-for="seg in cpAgingRows" :key="seg.name" class="aging-item" :class="{ 'is-warn': seg.warn }">
          <span class="aging-name">{{ seg.name }}</span>
          <span class="aging-bar"><i :style="{ width: seg.pct + '%', background: seg.color }"></i></span>
          <span class="aging-amount amount" :class="{ warning: seg.warn }">{{ fmt(seg.total) }}</span>
          <span class="aging-sub">{{ seg.pct.toFixed(1) }}% · {{ seg.count }} 单</span>
        </div>
      </div>
    </el-card>

    <!-- ====== 明细表格 ====== -->
    <el-card class="block" shadow="never" v-if="detailRows.length > 0 && currentBiz !== 'customer_platform'">
      <template #header>
        <div class="card-head">
          <b>我的明细</b>
          <span class="head-sub">共 {{ detailTotal }} 条</span>
        </div>
      </template>
      <el-table :data="detailRows" border size="small" :header-cell-style="{ background: '#2c3e50', color: '#fff' }">
        <el-table-column prop="docDate" label="日期" width="110" align="center" />
        <el-table-column prop="docNo" label="单据编号" min-width="150" show-overflow-tooltip />
        <el-table-column prop="customer" label="客户名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="agingCategory" label="账龄" width="160" align="center">
          <template #default="{ row }">
            <el-tag :type="agingTagType(row.agingCategory)" effect="plain" size="small">{{ row.agingCategory || '未分类' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="amountTotal" label="金额(元)" min-width="130" align="right">
          <template #default="{ row }"><span class="amount">{{ fmt(row.amountTotal) }}</span></template>
        </el-table-column>
        <el-table-column prop="over3m" label="3月以上" min-width="120" align="right">
          <template #default="{ row }"><span class="amount warning" v-if="row.over3m">{{ fmt(row.over3m) }}</span><span v-else>—</span></template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="150" show-overflow-tooltip />
      </el-table>
    </el-card>

    <!-- ====== 客户平台订单明细 ====== -->
    <el-card class="block" shadow="never" v-if="currentBiz === 'customer_platform' && cpDetailRows.length > 0">
      <template #header>
        <div class="card-head">
          <b>客户平台订单明细</b>
          <span class="head-sub">共 {{ cpDetailRows.length }} 条</span>
        </div>
      </template>
      <el-table :data="cpDetailRows" border size="small" :header-cell-style="{ background: '#2c3e50', color: '#fff' }">
        <el-table-column prop="orderDate" label="下单日期" width="110" align="center" />
        <el-table-column prop="orderNo" label="订单编号" min-width="150" show-overflow-tooltip />
        <el-table-column prop="platform" label="平台" width="100" align="center" />
        <el-table-column prop="customer" label="客户" min-width="150" show-overflow-tooltip />
        <el-table-column prop="amountTotal" label="金额(元)" min-width="130" align="right">
          <template #default="{ row }"><span class="amount">{{ fmt(row.amountTotal) }}</span></template>
        </el-table-column>
        <el-table-column prop="qty" label="数量" width="90" align="right" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { Picture, Download } from '@element-plus/icons-vue'
import { toPng } from 'html-to-image'
import request from '@/api/request'
import { exportDetail, exportCustomerPlatformDetail } from '@/api'
import { loadAuth, useAuth } from '@/composables/useAuth'
import PageHeader from '@/components/PageHeader.vue'

// 导出权限：与「明细查询」页用同一套判断（管理员与成员都能导，
// 将来若要收紧，改 useAuth 里的 CAN_EXPORT 即可，这里不用动）
const { canExport } = useAuth()

const pageRef = ref(null)
const exportingImg = ref(false)
const exportingXlsx = ref(false)

const loading = ref(true)
const currentBiz = ref('billed_unpaid')
const selectedSalesperson = ref('')
const salespersonList = ref([])

// ========== 数据 ==========
const mySummary = ref({ hasData: false })
const cpSummary = ref({ total: 0, snapshotDate: '' })
const cpAging = ref([])
const detailRows = ref([])
const detailTotal = ref(0)
const cpDetailRows = ref([])

// ========== 工具函数 ==========
function fmt(val) {
  if (val == null) return '—'
  return Number(val).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 元 → 万元（保留 2 位），用于较上期这类对比读数 */
function fmtWan(val) {
  return (Number(val || 0) / 10000).toFixed(2)
}

/** 单均金额：总额 ÷ 单据数。以前这里放的是「占全公司」，
 *  但只选了 1 个业务员时「自己 ÷ 自己」恒等于 100%，没有任何信息量。 */
const avgBilledAmount = computed(() => {
  const total = Number(mySummary.value.total) || 0
  const n = Number(mySummary.value.invoiceCount) || 0
  return n > 0 ? total / n : 0
})

/** 当前业务类型 + 选中的人，到底有没有数据（决定显示卡片还是空状态） */
const hasAnyData = computed(() =>
  currentBiz.value === 'customer_platform'
    ? Number(cpSummary.value.total) > 0
    : !!mySummary.value.hasData
)

const BIZ_LABELS = {
  billed_unpaid: '已开票未回款',
  shipped_uninvoiced: '已发货未开票',
  customer_platform: '客户平台未回款',
}
const bizLabel = computed(() => BIZ_LABELS[currentBiz.value] || '')

/** 较上期：涨了用红（与全站金额语义色一致），跌了用绿 */
const cpDeltaAmount = computed(() => Number(cpSummary.value.deltaAmount ?? 0))
const cpDeltaClass = computed(() => (cpDeltaAmount.value > 0 ? 'amount' : cpDeltaAmount.value < 0 ? 'amount is-down' : 'is-flat'))
const cpDeltaText = computed(() => {
  if (cpSummary.value.prevTotal == null) return '—'
  if (cpDeltaAmount.value === 0) return '持平'
  const arrow = cpDeltaAmount.value > 0 ? '↑' : '↓'
  return `${arrow} ${fmtWan(Math.abs(cpDeltaAmount.value))}万`
})
/** 较上期的百分比读数，放在副标题那一行更省地方 */
const cpDeltaPctText = computed(() => {
  const pct = cpSummary.value.deltaPct
  if (pct == null) return ''
  const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : ''
  return `${arrow} ${Math.abs(pct).toFixed(1)}%`
})

// 账龄固定「老 → 新」，颜色 红→橙→黄→蓝→绿；接口返回顺序不稳定，必须自己排。
// 这是「我的业绩」页最有用的信息：钱压了多久，比总额更能说明问题。
const AGING_ORDER = [
  { name: '3个月以上', color: '#f56c6c' },
  { name: '2个月', color: '#e6a23c' },
  { name: '1个月', color: '#f4d03f' },
  { name: '当月', color: '#409eff' },
]
const cpAgingRows = computed(() => {
  const total = Number(cpSummary.value.total) || 0
  const map = new Map((cpAging.value || []).map((s) => [s.segment, s]))
  const segs = AGING_ORDER.map((o) => {
    const hit = map.get(o.name)
    const amt = Number(hit?.total || 0)
    return {
      name: o.name,
      color: o.color,
      total: amt,
      count: Number(hit?.orderCount || 0),
      pct: total > 0 ? (amt / total) * 100 : 0,
      warn: o.name === '3个月以上',
    }
  })
  // 兜底：接口万一给出没在上面的档位，也不要悄悄丢掉
  for (const [name, v] of map) {
    if (!AGING_ORDER.some((o) => o.name === name)) {
      const amt = Number(v.total || 0)
      segs.push({
        name, color: '#909399', total: amt, count: Number(v.orderCount || 0),
        pct: total > 0 ? (amt / total) * 100 : 0, warn: false,
      })
    }
  }
  return segs.filter((s) => s.total > 0)
})

// 账龄标签配色：接口返回的是「三个月以上未回款 / 一个月未回款 / 当月未回款」这类全名，
// 不能按「3个月以上」这种简写做映射（原来的键一个都对不上，标签全掉成灰色）。
// 判定逻辑与「明细查询」页保持一致。
function agingTagType(category) {
  const c = String(category || '')
  if (c.includes('三个月以上')) return 'danger'
  if (c.includes('三个月')) return 'warning'
  if (c.includes('两个月')) return 'warning'
  if (c.includes('一个月')) return 'primary'
  if (c === '未分类') return 'info'
  return 'success'
}

// ========== 加载数据 ==========
// 账号口令可能短、可能含空格，统一 trim 后再比；同时容错「没填口令但账号存在」的情况
function normAccounts(list) {
  return (list || []).map(r => ({ name: r.name })).filter(r => r.name)
}

/** 业务员候选名单：已开票 ∪ 已发货 ∪ 客户平台，三张源表的业务员不一样，
 *  只取前两个会漏掉「只在客户平台有单」的人（那样选不到他，页面看起来像没数据）。 */
async function loadSalespersonList() {
  const [billed, shipped, cp] = await Promise.all([
    request.get('/filters', { params: { bizType: 'billed_unpaid' } }).catch(() => ({})),
    request.get('/filters', { params: { bizType: 'shipped_uninvoiced' } }).catch(() => ({})),
    request.get('/customer-platform-unpaid/salespersons').catch(() => ({})),
  ])
  const names = [
    ...normAccounts(billed.salespeople).map(r => r.name),
    ...normAccounts(shipped.salespeople).map(r => r.name),
    ...((cp.salespersons || cp.records || []).map(r => (typeof r === 'string' ? r : r.salesperson || r.name))),
  ].filter(Boolean)
  salespersonList.value = [...new Set(names)].sort().map(name => ({ name, department: '' }))
}

async function loadSummary() {
  const sp = selectedSalesperson.value || ''
  try {
    mySummary.value = await request.get('/summary', {
      params: { bizType: currentBiz.value, salesperson: sp },
    })
  } catch {
    mySummary.value = { hasData: false }
  }
}

async function loadDetail() {
  const sp = selectedSalesperson.value || ''
  if (!sp) {
    detailRows.value = []
    detailTotal.value = 0
    return
  }
  try {
    const res = await request.get('/detail', { params: { bizType: currentBiz.value, salesperson: sp, page: 1, pageSize: 50 } })
    detailRows.value = res.records || []
    detailTotal.value = res.total || detailRows.value.length
  } catch {
    detailRows.value = []
    detailTotal.value = 0
  }
}

async function loadCpSummary() {
  const sp = selectedSalesperson.value || ''
  try {
    // 必须带上 salesperson：这是「我的业绩」页，卡片要跟选中的业务员走。
    // 不带的话会拿到全公司数字，却顶着「客户平台未回款」的标签，误导使用者。
    const res = await request.get('/customer-platform-unpaid/summary', { params: { salesperson: sp } })
    cpSummary.value = res || { total: 0, snapshotDate: '' }
  } catch {
    cpSummary.value = { total: 0 }
  }
}

async function loadCpAging() {
  const sp = selectedSalesperson.value || ''
  if (!sp) {
    cpAging.value = []
    return
  }
  try {
    const res = await request.get('/customer-platform-unpaid/aging', { params: { salesperson: sp } })
    cpAging.value = res.segments || []
  } catch {
    cpAging.value = []
  }
}

async function loadCpDetail() {
  const sp = selectedSalesperson.value || ''
  if (!sp) {
    cpDetailRows.value = []
    return
  }
  try {
    const res = await request.get('/customer-platform-unpaid/detail', { params: { salesperson: sp, page: 1, pageSize: 50 } })
    cpDetailRows.value = res.records || []
  } catch {
    cpDetailRows.value = []
  }
}

async function loadData() {
  // 没选人就不用请求任何业务数据；直接放行，让空状态露出来。
  // （以前 loading 会一直挂着，遮罩盖住整页，空状态根本看不到）
  if (!selectedSalesperson.value) {
    mySummary.value = { hasData: false }
    cpSummary.value = { total: 0, snapshotDate: '' }
    cpAging.value = []
    detailRows.value = []
    cpDetailRows.value = []
    loading.value = false
    return
  }
  loading.value = true
  try {
    await Promise.all([loadSummary(), loadCpSummary(), loadCpAging()])
    if (currentBiz.value === 'customer_platform') {
      await loadCpDetail()
    } else {
      await loadDetail()
    }
  } finally {
    // 用 finally：任何一个请求抛错都不能把遮罩永久留在页面上
    loading.value = false
  }
}

function onSalespersonChange() {
  loadData()
}

function onBizChange() {
  loadData()
}

// ========== 导出 ==========
/** 文件名里带上人、业务类型、快照日期，发出去别人一眼知道是谁的、什么时候的 */
function buildNameParts() {
  const sp = selectedSalesperson.value || '全部业务员'
  const label = bizLabel.value || '业绩'
  const date = currentBiz.value === 'customer_platform'
    ? (cpSummary.value.snapshotDate || '')
    : (mySummary.value.snapshotDate || '')
  return { sp, label, date }
}

/** 导出整页图片：发给领导/客户，跟「数据概览」的导出看板图片是一个用法 */
async function onExportImage() {
  if (exportingImg.value) return
  if (!canExport.value) {
    ElMessage.warning('当前账号没有导出权限，请联系管理员')
    return
  }
  if (!pageRef.value) return
  exportingImg.value = true
  try {
    // 等一下渲染：禁用态与 loading 文案刚变更，立刻截会截到旧的按钮文字
    await nextTick()
    const { sp, label, date } = buildNameParts()
    const dataUrl = await toPng(pageRef.value, {
      backgroundColor: '#f5f7fa',
      pixelRatio: 2,
      cacheBust: true,
      // 导出前把滚动位置复位，避免截到半截表格
      width: pageRef.value.scrollWidth,
      height: pageRef.value.scrollHeight,
      // 导出时排除按钮外壳本身：上报图片里不该出现按钮
      // （沿用「数据概览」页 exportImage 的 no-export 约定，别另发明一套）
      filter: (node) =>
        !(node instanceof Element && node.classList && node.classList.contains('no-export')),
    })
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `我的业绩_${sp}_${label}_${date || '无日期'}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    ElMessage.success('图片已导出')
  } catch (err) {
    console.error('[我的业绩] 导出图片失败:', err)
    ElMessage.error('导出图片失败，请重试')
  } finally {
    exportingImg.value = false
  }
}

/** 导出明细 Excel：走与「明细查询」相同的后端接口，条件 = 当前页筛选（业务员 + 业务类型） */
async function onExportExcel() {
  if (exportingXlsx.value) return
  if (!canExport.value) {
    ElMessage.warning('当前账号没有导出权限，请联系管理员')
    return
  }
  const sp = selectedSalesperson.value
  if (!sp) return
  exportingXlsx.value = true
  try {
    const { label, date } = buildNameParts()
    if (currentBiz.value === 'customer_platform') {
      await exportCustomerPlatformDetail(
        { salesperson: sp },
        `我的业绩_${sp}_${label}_${date || '无日期'}_${cpDetailRows.value.length}行.xlsx`
      )
      ElMessage.success(`已导出 ${cpDetailRows.value.length} 行`)
    } else {
      await exportDetail(
        currentBiz.value,
        { salesperson: sp },
        `我的业绩_${sp}_${label}_${date || '无日期'}_${detailTotal.value}行.xlsx`
      )
      ElMessage.success(`已导出 ${detailTotal.value} 行`)
    }
  } catch (err) {
    // 错误提示已由拦截器统一给出（含 blob 错误体解析）
    console.error('[我的业绩] 导出失败:', err)
  } finally {
    exportingXlsx.value = false
  }
}

onMounted(async () => {
  // 先把 loading 放开：进入页面时还没选业务员，不该显示全屏遮罩。
  // 名单加载失败也不影响页面可用性（下拉框为空，但提示文案能给出来）。
  loading.value = false
  await loadAuth()
  await loadSalespersonList()
})
</script>

<style scoped>
.container { padding: 0; }
/* 头部已交给 PageHeader 组件统一；容器不带内边距是这一页原有的版式，保留 */

.select-card { margin-bottom: 16px; }
.select-row { display: flex; align-items: center; gap: 12px; }
.label { font-weight: 500; color: #606266; }
.current-tag { margin-left: 8px; }

.cards { margin: 16px 0; }
/* ====== 核心指标卡片（圆角与灰阶对齐「数据概览」）====== */
.card {
  background: white;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 20px;
  text-align: center;
}
.card-label { font-size: 14px; color: #909399; margin-bottom: 12px; }
.card-value { font-size: 26px; font-weight: 700; color: #303133; line-height: 1.2; }
/* 金额用全站统一的语义色（与数据概览/明细一致） */
.card-value.amount { color: #f56c6c; }
.card-value.amount.warning { color: #e6a23c; }
.card-sub { font-size: 12px; color: #c0c4cc; margin-top: 6px; }
/* 较上期：涨红跌绿（全站金额语义色），持平走中性灰 */
.card-value.is-down { color: #67c23a; }
.card-value.is-flat { color: #909399; }

/* ====== 账龄分布（老 → 新）====== */
.aging-block { margin-top: 16px; }
.aging-list { display: flex; flex-direction: column; gap: 12px; }
.aging-item {
  display: grid;
  grid-template-columns: 88px 1fr 140px 120px;
  align-items: center;
  gap: 12px;
}
.aging-item.is-warn .aging-name { color: #f56c6c; font-weight: 600; }
.aging-name { font-size: 14px; color: #606266; white-space: nowrap; }
.aging-bar {
  height: 10px;
  border-radius: 5px;
  background: #f0f2f5;
  overflow: hidden;
}
.aging-bar > i {
  display: block;
  height: 100%;
  border-radius: 5px;
  transition: width 0.4s ease;
}
.aging-amount { text-align: right; font-size: 15px; font-weight: 600; }
.aging-sub { font-size: 12px; color: #909399; text-align: right; white-space: nowrap; }

.block { margin-top: 16px; }
.card-head { display: flex; justify-content: space-between; align-items: center; }
.head-sub { font-size: 13px; color: #909399; }

.amount { color: #f56c6c; font-weight: 600; }
.amount.warning { color: #e6a23c; }

/* 业务类型切换与表格的收尾规范 */
.biz-switch { margin: 16px 0; }
/* 等宽数字：日期 / 编号 / 金额竖着能对齐，便于扫读比大小 */
:deep(.el-table td .cell) {
  font-variant-numeric: tabular-nums;
}

.empty-tip { text-align: left; font-size: 14px; color: #6b7280; margin-top: 12px; }
.muted { color: #909399; font-size: 13px; }

/* 移动端适配 */
@media (max-width: 768px) {
  /* 头部字号/间距由 PageHeader 组件自己处理 */

  .select-card { margin-bottom: 12px; }
  .select-row { flex-wrap: wrap; gap: 8px; }
  .label { font-size: 13px; white-space: nowrap; }
  .current-tag { margin-left: 0; flex-shrink: 0; }

  .cards { margin: 12px 0; }
  /* 移动端改为 2 列布局，避免卡片挤在一起 */
  :deep(.el-col) { margin-bottom: 8px; }
  .card {
    padding: 14px 10px;
    border-radius: 6px;
  }
  .card-label { font-size: 12px; margin-bottom: 6px; }
  /* 金额字体缩小，避免移动端溢出 */
  .card-value { font-size: 20px; line-height: 1.2; }
  .card-sub { font-size: 11px; margin-top: 4px; word-break: break-all; }

  .block { margin-top: 12px; }
  .card-head { flex-direction: column; align-items: flex-start; gap: 4px; }
  .head-sub { font-size: 12px; }

  .biz-switch { margin: 12px 0; }

  /* 账龄条移动端改为两行：名称+金额 一行，进度条+占比 一行，
     否则 4 列网格在窄屏会把金额挤成竖排 */
  .aging-item {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      'name amount'
      'bar  sub';
    gap: 6px 10px;
  }
  .aging-name { grid-area: name; font-size: 13px; }
  .aging-amount { grid-area: amount; font-size: 14px; }
  .aging-bar { grid-area: bar; }
  .aging-sub { grid-area: sub; font-size: 11px; }

  /* 移动端表格横向滚动 */
  :deep(.el-table) {
    font-size: 11px;
    min-width: 500px;
  }
  :deep(.el-table th),
  :deep(.el-table td) {
    padding: 6px 4px !important;
  }
}
</style>
