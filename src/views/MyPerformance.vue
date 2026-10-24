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
      <el-radio-button value="customer_platform">客户未回款到平台</el-radio-button>
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
        <p class="muted">试试切换到其他业务类型；如果是同一个人，一般都能在客户未回款到平台里查到。</p>
      </div>
    </el-empty>

    <!-- ====== 已开票 / 已发货 的 4 张指标卡 ======
         只在非客户平台标签下出现。这三个业务类型的口径完全不同（来源表都不是同一张），
         以前无论切到哪个标签都显示这一排「已开票」数字，会让人以为客户平台也这么大金额。 -->
    <el-row :gutter="16" class="cards" v-if="currentBiz !== 'customer_platform' && mySummary.hasData">
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">{{ bizLabel }}总额（元）</div>
          <div class="card-value amount">{{ fmt(mySummary.total) }}</div>
          <div class="card-sub">{{ mySummary.snapshotDate || '暂无数据' }}</div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">3个月以上{{ agingVerb }}（元）</div>
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
      <!-- 第 4 张卡：排名 + 较上一期（2026-10-10 使用者定，替换原「单均金额」）
           上行名次、下行对比。对比基准是「上一个可用批次」而不是「昨天」——
           同步不是每天都有（国庆断档、客户平台周更），写死「昨日」会得出假 0。 -->
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">排名</div>
          <div class="card-value" v-if="myRank">第 {{ myRank.position }} / {{ myRank.of }} 名</div>
          <div class="card-value is-flat" v-else>—</div>
          <div class="card-sub">
            <span v-if="myDeltaText" :class="myDeltaClass">
              较 {{ myPrevDateShort }}<template v-if="myDeltaDays !== null">（{{ myDeltaDays }}天前）</template> {{ myDeltaText }}
            </span>
            <span v-if="myDeltaText && myRank"> · </span>
            <span v-if="myRank">占 {{ (myRank.share * 100).toFixed(1) }}%</span>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- ====== 客户平台的 4 张指标卡 ====== -->
    <el-row :gutter="16" class="cards" v-if="currentBiz === 'customer_platform' && cpSummary.total > 0">
      <el-col :xs="12" :sm="12" :md="6">
        <div class="card">
          <div class="card-label">客户未回款到平台（元）</div>
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

    <!-- ====== 账龄分布 ======
         2026-10-19 按使用者要求去掉这张独立的账龄分布卡：
         「这个可以不用单独，把账龄放到下面的明细里」——
         业务员看的是「哪一单拖了多久」，汇总成 4 条横条反而不如明细里一行一行的账龄标签直接。
         账龄改为客户平台订单明细里的「账龄」列（后端 /customer-platform-unpaid/detail 现算）。 -->

    <!-- ====== 明细表格 ====== -->
    <el-card class="block" shadow="never" v-if="detailRows.length > 0 && currentBiz !== 'customer_platform'">
      <template #header>
        <div class="card-head">
          <b>我的明细</b>
          <div class="head-right">
            <el-select
              v-model="selectedCustomer"
              class="cust-filter"
              placeholder="按客户筛选"
              size="default"
              filterable
              clearable
              @change="onCustomerChange"
            >
              <template #prefix>
                <el-icon><Filter /></el-icon>
              </template>
              <el-option v-for="c in customerList" :key="c" :label="c" :value="c" />
            </el-select>
            <span class="head-sub">
              共 {{ detailTotal }} 条 · 合计 <b class="amount">{{ fmt(detailSum) }}</b> 元<template
                v-if="detailOver3m"
              >（其中 3个月以上 <b class="amount warning">{{ fmt(detailOver3m) }}</b>）</template>
            </span>
          </div>
        </div>
      </template>
      <el-table :data="detailRows" border size="small" :header-cell-style="{ background: '#2c3e50', color: '#fff' }">
        <!-- 列宽按内容实测值重排（2026-10-10）：
             原来「单据编号」富余 44px、「备注」富余一大截，而「客户名称」只有 180px、
             实际最长要 239px（如「招行宁波分行-信用卡部周黎俊」）⇒ 客户名被截断。
             把富余的宽度让给客户名称，让它能完整显示。
             2026-10-19：列名改为按业务线显示「合同执行编号 / 报账方案编号」，6 个字，宽度 125 → 135。 -->
        <el-table-column prop="docDate" :label="dateLabel" width="114" align="center" />
        <el-table-column prop="docNo" :label="docNoLabel" min-width="135" show-overflow-tooltip />
        <el-table-column prop="customer" label="客户名称" min-width="240" show-overflow-tooltip />
        <!-- 地区/行系：两张源表各只有一列有数据（地区=已开票线的「地址」归一化、行系=已发货线独有），
             跟业务线决定显示哪列，否则另一条线上会摆一整列「—」 -->
        <el-table-column v-if="currentBiz !== 'shipped_uninvoiced'" prop="city" label="地区" width="100" align="center">
          <template #default="{ row }"><span :class="{ 'date-missing': !row.city }">{{ row.city || '—' }}</span></template>
        </el-table-column>
        <el-table-column v-if="currentBiz === 'shipped_uninvoiced'" prop="rowSystem" label="行系" width="110" align="center">
          <template #default="{ row }"><span :class="{ 'date-missing': !row.rowSystem }">{{ row.rowSystem || '—' }}</span></template>
        </el-table-column>
        <el-table-column prop="agingCategory" label="账龄" width="154" align="center">
          <template #default="{ row }">
            <el-tag :type="agingTagType(row.agingCategory)" effect="plain" size="small">{{ row.agingCategory || '未分类' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="amountTotal" :label="`${bizLabel}金额（元）`" min-width="150" align="right">
          <template #default="{ row }"><span class="amount">{{ fmt(row.amountTotal) }}</span></template>
        </el-table-column>
        <!-- 「3个月以上」这一列 2026-10-19 按使用者要求去掉：上方第 2 张卡已经给出
             3个月以上的总额和占比，明细里再摆一列就是重复信息，还把进度反馈挤得只剩几个字。 -->
        <!-- 进度反馈（2026-10-19 起改名为「进度反馈」，原「备注」）：与「明细查询」页同一套交互
             —— 点一下即可填写，Enter 保存 / Esc 取消。空着时显示「点击填写」，让人知道这里能写。
             宽度 2026-10-19 从 150 拉到 320：实际内容动辄「客户做了行内方案，在催客户…」，
             150px 只能露三四个字，等于看不见。 -->
        <el-table-column prop="note" label="进度反馈" min-width="320">
          <template #default="{ row }">
            <el-input
              v-if="canEditDetail && editingId === row.id"
              ref="noteInputs"
              v-model="editValue"
              type="textarea"
              :rows="1"
              :autosize="{ minRows: 1, maxRows: 4 }"
              placeholder="填写进度反馈（Enter 保存，Esc 取消）"
              @blur="saveNote(row)"
              @keydown.enter.prevent="saveNote(row)"
              @keydown.esc.stop="cancelNote(row)"
            />
            <span
              v-else
              class="note"
              :class="{ 'note-editable': canEditDetail }"
              :title="canEditDetail ? (row.note || '点击填写进度反馈') : ''"
              @click="startEdit(row)"
            >
              {{ row.note || (canEditDetail ? '点击填写' : '—') }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ====== 客户平台订单明细 ====== -->
    <el-card class="block" shadow="never" v-if="currentBiz === 'customer_platform' && cpDetailRows.length > 0">
      <template #header>
        <div class="card-head">
          <b>客户平台订单明细</b>
          <div class="head-right">
            <el-select
              v-model="selectedCustomer"
              class="cust-filter"
              placeholder="按客户筛选"
              size="default"
              filterable
              clearable
              @change="onCustomerChange"
            >
              <template #prefix>
                <el-icon><Filter /></el-icon>
              </template>
              <el-option v-for="c in customerList" :key="c" :label="c" :value="c" />
            </el-select>
            <span class="head-sub">
              共 {{ cpDetailRows.length }} 条 · 合计 <b class="amount">{{ fmt(cpDetailSum) }}</b> 元
            </span>
          </div>
        </div>
      </template>
      <el-table :data="cpDetailRows" border size="small" :header-cell-style="{ background: '#2c3e50', color: '#fff' }">
        <el-table-column prop="orderDate" label="下单日期" width="110" align="center" />
        <el-table-column prop="orderNo" label="订单编号" min-width="200" show-overflow-tooltip />
        <el-table-column prop="platform" label="平台" width="120" align="center" show-overflow-tooltip />
        <el-table-column prop="customer" label="客户" min-width="200" show-overflow-tooltip />
        <!-- 账龄（2026-10-19 从上方「我的账龄分布」卡搬下来）：口径与 /customer-platform-unpaid/aging
             完全一致 —— 基准=快照当月末，age=基准-下单日期，>=90/>=60/>=30 分三档，其余当月。 -->
        <el-table-column prop="agingCategory" label="账龄" width="130" align="center">
          <template #default="{ row }">
            <el-tag :type="agingTagType(row.agingCategory)" effect="plain" size="small">{{ row.agingCategory || '未分类' }}</el-tag>
          </template>
        </el-table-column>
        <!-- 地区：客户平台源表没有「地址」列，改为从客户名解析（详见 importer.js parsePlatformCustomerCity） -->
        <el-table-column prop="city" label="地区" width="100" align="center">
          <template #default="{ row }"><span :class="{ 'date-missing': !row.city }">{{ row.city || '—' }}</span></template>
        </el-table-column>
        <el-table-column prop="amountTotal" label="金额(元)" min-width="125" align="right">
          <template #default="{ row }"><span class="amount">{{ fmt(row.amountTotal) }}</span></template>
        </el-table-column>
        <el-table-column prop="qty" label="数量" width="80" align="right" />
        <!-- 进度反馈：与上面「我的明细」同一套交互（点一下即可填写，Enter 保存 / Esc 取消）。
             存在 detail_note，键 = ('customer_platform', 订单编号)。 -->
        <el-table-column prop="note" label="进度反馈" min-width="150">
          <template #default="{ row }">
            <el-input
              v-if="canEditDetail && cpEditingNo === row.orderNo"
              ref="cpNoteInputs"
              v-model="cpEditValue"
              type="textarea"
              :rows="1"
              :autosize="{ minRows: 1, maxRows: 4 }"
              placeholder="填写进度反馈（Enter 保存，Esc 取消）"
              @blur="cpSaveNote(row)"
              @keydown.enter.prevent="cpSaveNote(row)"
              @keydown.esc.stop="cpCancelNote(row)"
            />
            <span
              v-else
              class="note"
              :class="{ 'note-editable': canEditDetail }"
              :title="canEditDetail ? (row.note || '点击填写进度反馈') : ''"
              @click="cpStartEdit(row)"
            >
              {{ row.note || (canEditDetail ? '点击填写' : '—') }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { Picture, Download, Filter } from '@element-plus/icons-vue'
import { toPng } from 'html-to-image'
import { captureWithFullWidth } from '@/utils/exportSize'
import request from '@/api/request'
import { exportDetail, exportCustomerPlatformDetail, updateDetailNote } from '@/api'
import { loadAuth, useAuth } from '@/composables/useAuth'
import PageHeader from '@/components/PageHeader.vue'
// 与其它看板页保持一致：30 秒静默刷新（这页以前漏了，只有它不自动更新）
import { useAutoRefresh } from '@/composables/useAutoRefresh'

// 导出权限：与「明细查询」页用同一套判断（管理员与成员都能导，
// 将来若要收紧，改 useAuth 里的 CAN_EXPORT 即可，这里不用动）
// canEditDetail 管「备注能填不能填」—— 与导出刻意分开，将来要「能导不能改」只改 useAuth
const { canExport, canEditDetail } = useAuth()

const pageRef = ref(null)
const exportingImg = ref(false)
const exportingXlsx = ref(false)

const loading = ref(true)
const currentBiz = ref('billed_unpaid')
const selectedSalesperson = ref('')
const salespersonList = ref([])
// 客户筛选：只列「当前业务员 × 当前业务线」名下的客户，见 loadCustomerList
const selectedCustomer = ref('')
const customerList = ref([])

// ========== 数据 ==========
const mySummary = ref({ hasData: false })
const cpSummary = ref({ total: 0, snapshotDate: '' })
const detailRows = ref([])
const detailTotal = ref(0)
const detailSum = ref(0)
const detailOver3m = ref(0)
const cpDetailRows = ref([])
const cpDetailSum = ref(0)

// ========== 工具函数 ==========
function fmt(val) {
  if (val == null) return '—'
  return Number(val).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 元 → 万元（保留 2 位），用于较上期这类对比读数 */
function fmtWan(val) {
  return (Number(val || 0) / 10000).toFixed(2)
}

/** 排名：后端按「未回款总额」倒序算（并列同名次），未选业务员时为 null */
const myRank = computed(() => mySummary.value.rank || null)

/** 上期基准 = **上一个可用批次**，不是「昨天」；取不到就整行不渲染 */
const myPrev = computed(() => mySummary.value.prev || null)
const myPrevDateShort = computed(() => String(myPrev.value?.snapshotDate || '').slice(5))

/** 与上期的间隔天数。必须显示：否则「较 10-09」会被读成「昨天降了」 */
const myDeltaDays = computed(() => {
  const p = myPrev.value
  const cur = mySummary.value.snapshotDate
  if (!p?.snapshotDate || !cur) return null
  const d = Math.round(
    (new Date(`${cur}T00:00:00`) - new Date(`${p.snapshotDate}T00:00:00`)) / 86400000
  )
  return Number.isFinite(d) ? d : null
})

const myDeltaAmount = computed(() => {
  const p = myPrev.value
  if (!p) return null
  return Number(mySummary.value.total || 0) - Number(p.total || 0)
})

/** 涨红跌绿（全站金额语义色）；持平走中性灰 —— 不显示「↑0.00万」这种没信息量的读数 */
const myDeltaClass = computed(() => {
  const d = myDeltaAmount.value
  if (d === null || Math.abs(d) < 0.005) return 'delta-flat'
  return d > 0 ? 'delta-up' : 'delta-down'
})

const myDeltaText = computed(() => {
  const d = myDeltaAmount.value
  if (d === null) return ''
  if (Math.abs(d) < 0.005) return '持平'
  return `${d > 0 ? '↑' : '↓'} ${fmtWan(Math.abs(d))}万`
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
  customer_platform: '客户未回款到平台',
}
const bizLabel = computed(() => BIZ_LABELS[currentBiz.value] || '')

/**
 * 账龄档的结尾用「未回款 / 未开票」—— 跟着当前业务线走。
 *
 * 2026-10-13 使用者要求：这两列（和上面两张卡）原来写死「金额(元)」「3月以上」「未回款总额」，
 * 切到「已发货未开票」时就成了错的标签 —— 明明是未开票线，却写着「未回款」。
 * 所以标签必须跟着业务线变：两条销售线各自的「金额」与「3个月以上」口径都不一样。
 */
const agingVerb = computed(() => (currentBiz.value === 'shipped_uninvoiced' ? '未开票' : '未回款'))

/**
 * 单号列名：按业务线走「利润系统」的叫法（2026-10-19 使用者确认）。
 *   已发货未开票 → 合同执行编号
 *   已开票未回款 → 报账方案编号
 * 客户平台那条线不在这里露面（它表里叫「订单编号」，是另一个字段），
 * 所以这里只判已发货/已开票两种，兜底给「报账方案编号」。
 */
const docNoLabel = computed(() =>
  currentBiz.value === 'shipped_uninvoiced' ? '合同执行编号' : '报账方案编号'
)

/**
 * 明细「日期」列的列名也要跟业务线走（2026-10-19 使用者指定）：
 *   已开票未回款 → 开票日期（源表字段就是「开票日期」）
 *   已发货未开票 → 发货日期
 * 原来统一写「日期」，业务员看不出这日期指哪一天，两条线含义也不一样。
 * 客户平台的订单明细表用的是「下单日期」列，不走这里。
 */
const dateLabel = computed(() => (currentBiz.value === 'shipped_uninvoiced' ? '发货日期' : '开票日期'))

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

// 账龄标签配色：接口返回的是「三个月以上未回款 / 一个月未回款 / 当月未回款」这类全名，
// 不能按「3个月以上」这种简写做映射（原来的键一个都对不上，标签全掉成灰色）。
// 判定逻辑与「明细查询」页保持一致。
// 2026-10-19：客户平台线的账龄是后端现算的，返回「3个月以上 / 2个月 / 1个月 / 当月」（阿拉伯数字），
// 与应收两条线的中文写法不同，所以两种写法都要认，否则客户平台的标签会全掉成绿色。
function agingTagType(category) {
  const c = String(category || '')
  if (c.includes('三个月以上') || c.includes('3个月以上')) return 'danger'
  if (c.includes('三个月') || c.includes('3个月')) return 'warning'
  if (c.includes('两个月') || c.includes('2个月')) return 'warning'
  if (c.includes('一个月') || c.includes('1个月')) return 'primary'
  if (c === '未分类') return 'info'
  return 'success'
}

// ========== 备注（跟进情况）行内编辑 ==========
// 与「明细查询」页完全同一套写法，两页行为保持一致。
// 为什么放在这一页：业务员看自己的单，最需要顺手记一句「客户说下周付」，
// 以前这列只能看不能写，等于没有。
const editingId = ref(null)
const editValue = ref('')
/** 编辑框引用：同一时刻只有一行在编辑，ref 不在 v-for 里 ⇒ 拿到的是组件实例（不是数组） */
const noteInputs = ref([])

function focusEditor(r) {
  const el = Array.isArray(r.value) ? r.value[0] : r.value
  el?.focus?.()
}

/** 退出编辑态但不保存（切换业务员/业务线/客户、Esc 取消时用）
 *  应收明细与客户平台明细是两套独立的编辑态（键不同：一个用 id、一个用订单编号），
 *  但「换人/换线/换客户」这种场景要一起收掉，所以这个函数两套都清。
 *  cpResetNoteEdit 是下面用 function 声明的（会提升），所以这里可以直接调。 */
function resetNoteEdit() {
  editingId.value = null
  editValue.value = ''
  cpResetNoteEdit()
}

function startEdit(row) {
  if (!canEditDetail.value) return
  editingId.value = row.id
  editValue.value = row.note || ''
  nextTick(() => focusEditor(noteInputs))
}

function cancelNote(row) {
  if (editingId.value !== row.id) return
  resetNoteEdit()
}

/** 保存：写库成功才改行上的值；失败回退原值（不留下「看着存了其实没存」的假象） */
async function saveNote(row) {
  if (editingId.value !== row.id) return
  const value = editValue.value.trim()
  const original = row.note || ''
  resetNoteEdit()
  if (value === original) return
  try {
    await updateDetailNote(currentBiz.value, row.docNo, value)
    row.note = value || null
    ElMessage.success('进度反馈已保存')
  } catch (err) {
    row.note = original
    console.error('[我的业绩] 保存备注失败:', err)
  }
}

// ========== 客户平台订单明细的进度反馈 ==========
// 与上面同一套交互，但不能共用 editingId：应收明细的编辑键是 row.id（数字），
// 客户平台这张表根本没返回 id（它按订单编号定位），两套键混用会互相把对方的编辑态顶掉。
// 所以单独一组状态，键 = row.orderNo。
const cpEditingNo = ref(null)
const cpEditValue = ref('')
const cpNoteInputs = ref([])

function cpResetNoteEdit() {
  cpEditingNo.value = null
  cpEditValue.value = ''
}

function cpStartEdit(row) {
  if (!canEditDetail.value) return
  cpEditingNo.value = row.orderNo
  cpEditValue.value = row.note || ''
  nextTick(() => focusEditor(cpNoteInputs))
}

function cpCancelNote(row) {
  if (cpEditingNo.value !== row.orderNo) return
  cpResetNoteEdit()
}

async function cpSaveNote(row) {
  if (cpEditingNo.value !== row.orderNo) return
  const value = cpEditValue.value.trim()
  const original = row.note || ''
  cpResetNoteEdit()
  if (value === original) return
  try {
    await updateDetailNote('customer_platform', row.orderNo, value)
    row.note = value || null
    ElMessage.success('进度反馈已保存')
  } catch (err) {
    row.note = original
    console.error('[我的业绩] 保存客户平台进度反馈失败:', err)
  }
}

// ========== 加载数据 ==========
// 账号口令可能短、可能含空格，统一 trim 后再比；同时容错「没填口令但账号存在」的情况
function normAccounts(list) {
  return (list || []).map(r => ({ name: r.name })).filter(r => r.name)
}

/** 业务员候选名单：**只取当前业务线**（2026-10-24 使用者「这里按照业务员来」）。
 *
 *  原来是三条线的并集，理由是「只取前两个会漏掉只在客户平台有单的人」。
 *  实际用起来下拉里会混进别条线的人（如客户平台的「农立珍」「大客户中心」），
 *  在「已开票未回款」页看着莫名其妙 ⇒ 改成跟当前业务线一致，切 tab 时重新加载。
 */
async function loadSalespersonList() {
  const biz = currentBiz.value
  try {
    let names = []
    if (biz === 'customer_platform') {
      const cp = await request.get('/customer-platform-unpaid/salespersons').catch(() => ({}))
      names = (cp.salespersons || cp.records || [])
        .map((r) => (typeof r === 'string' ? r : r.salesperson || r.name))
    } else {
      const res = await request.get('/filters', { params: { bizType: biz } }).catch(() => ({}))
      names = normAccounts(res.salespeople).map((r) => r.name)
    }
    salespersonList.value = [...new Set(names.filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'))
      .map((name) => ({ name, department: '' }))
  } catch {
    salespersonList.value = []
  }
}

/**
 * 客户候选名单 = **这个业务员在这条业务线上的客户**。
 *
 * 为什么不是全公司的客户：业务员只找自己的客户，下拉里塞几百个别人的名字没法用。
 * 两条线的取数方式不同（客户平台是另一张表、另一套客户字段），所以分两条路走；
 * 客户口径与明细页保持同一套，否则选出来的名字在明细里一行都匹配不到。
 */
async function loadCustomerList() {
  const sp = selectedSalesperson.value || ''
  if (!sp) {
    customerList.value = []
    return
  }
  try {
    if (currentBiz.value === 'customer_platform') {
      const res = await request.get('/customer-platform-unpaid/customers', { params: { salesperson: sp } })
      customerList.value = res.customers || []
    } else {
      const res = await request.get('/filters', { params: { bizType: currentBiz.value, salesperson: sp } })
      customerList.value = (res.customers || []).filter(Boolean)
    }
  } catch {
    customerList.value = []
  }
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
    detailSum.value = 0
    detailOver3m.value = 0
    return
  }
  try {
    const res = await request.get('/detail', {
      params: {
        bizType: currentBiz.value,
        salesperson: sp,
        // 空串后端会当没传处理，不必特意删 key
        customer: selectedCustomer.value || '',
        page: 1,
        pageSize: 50,
      },
    })
    detailRows.value = res.records || []
    detailTotal.value = res.total || detailRows.value.length
    // 合计用后端对「筛选全量」的聚合，不是本页 50 行之和 ——
    // 否则筛到大客户时，翻页会让合计跟着变，看着像数字错了
    detailSum.value = Number(res.sumTotal || 0)
    detailOver3m.value = Number(res.sumColumns?.over3m || 0)
  } catch {
    detailRows.value = []
    detailTotal.value = 0
    detailSum.value = 0
    detailOver3m.value = 0
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

async function loadCpDetail() {
  const sp = selectedSalesperson.value || ''
  if (!sp) {
    cpDetailRows.value = []
    cpDetailSum.value = 0
    return
  }
  try {
    const res = await request.get('/customer-platform-unpaid/detail', {
      params: {
        salesperson: sp,
        customer: selectedCustomer.value || '',
        page: 1,
        pageSize: 50,
      },
    })
    cpDetailRows.value = res.records || []
    cpDetailSum.value = Number(res.sumTotal || 0)
  } catch {
    cpDetailRows.value = []
    cpDetailSum.value = 0
  }
}

async function loadData(silent) {
  // 正在填备注时跳过后台静默刷新：30 秒一到把行整体换掉，输入到一半的内容会凭空消失
  if (silent && (editingId.value !== null || cpEditingNo.value !== null)) return
  // 没选人就不用请求任何业务数据；直接放行，让空状态露出来。
  // （以前 loading 会一直挂着，遮罩盖住整页，空状态根本看不到）
  if (!selectedSalesperson.value) {
    mySummary.value = { hasData: false }
    cpSummary.value = { total: 0, snapshotDate: '' }
    detailRows.value = []
    cpDetailRows.value = []
    customerList.value = []
    loading.value = false
    return
  }
  // 静默刷新（silent=true）不闪遮罩：后台每 30 秒重拉一次，不能每次都盖一层
  if (!silent) loading.value = true
  try {
    // 客户名单跟其它数据一起拉：它决定下拉里能选谁，分开拉会出现「先能选、随后又变空」
    // （2026-10-19：账龄分布卡已取消，不再请求 /customer-platform-unpaid/aging，
    //  账龄改由 /detail 每行直接返回，一次请求就够）
    await Promise.all([loadSummary(), loadCpSummary(), loadCustomerList()])
    if (currentBiz.value === 'customer_platform') {
      await loadCpDetail()
    } else {
      await loadDetail()
    }
  } finally {
    // 用 finally：任何一个请求抛错都不能把遮罩永久留在页面上
    if (!silent) loading.value = false
  }
}

function onSalespersonChange() {
  // 换了人，上一位的客户选择对他没有意义；备注编辑态也要收掉（行都换人了）
  selectedCustomer.value = ''
  resetNoteEdit()
  loadData()
}

async function onBizChange() {
  // 换了业务线，客户名单整套都变了
  selectedCustomer.value = ''
  resetNoteEdit()
  // 业务员候选也按业务线重取（2026-10-24）：下拉只列这条线有的人
  await loadSalespersonList()
  // 当前选中的人如果这条线没有，清掉，避免停在一个查不到数据的名字上
  if (
    selectedSalesperson.value &&
    !salespersonList.value.some((s) => s.name === selectedSalesperson.value)
  ) {
    selectedSalesperson.value = ''
  }
  loadData()
}

/** 客户筛选只影响明细表：上方 4 张卡是「我的」合计，不是某个客户的 */
function onCustomerChange() {
  resetNoteEdit()
  if (currentBiz.value === 'customer_platform') loadCpDetail()
  else loadDetail()
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

/** 导出整页图片：发给领导/客户，跟「数据总览」的导出看板图片是一个用法 */
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
    // 导出：先把元素临时撑宽（明细表横向滚动在内层容器上，光给画布宽度不够，
    // 右边几列会被丢掉）。详见 utils/exportSize.js
    const dataUrl = await captureWithFullWidth(
      pageRef.value,
      toPng,
      {
        backgroundColor: '#f5f7fa',
        cacheBust: true,
        // 导出时排除按钮外壳本身：上报图片里不该出现按钮
        // （沿用「数据总览」页 exportImage 的 no-export 约定，别另发明一套）
        filter: (node) =>
          !(node instanceof Element && node.classList && node.classList.contains('no-export')),
      },
      { minWidth: 1200, minHeight: 800 }
    )
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

// 30 秒静默刷新：数据同步进来后不用手动刷新页面。
// 未选业务员时 loadData 会直接返回，不会白发请求。
useAutoRefresh(loadData)
</script>

<style scoped>
.container { padding: 0; }
/* 头部已交给 PageHeader 组件统一；容器不带内边距是这一页原有的版式，保留 */

.select-card { margin-bottom: 16px; }
.select-row { display: flex; align-items: center; gap: 12px; }
.label { font-weight: 500; color: #606266; }
.current-tag { margin-left: 8px; }

.cards { margin: 16px 0; }
/* ====== 核心指标卡片（圆角与灰阶对齐「数据总览」）====== */
.card {
  background: white;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 20px;
  text-align: center;
}
.card-label { font-size: 14px; color: #909399; margin-bottom: 12px; }
.card-value { font-size: 26px; font-weight: 700; color: #303133; line-height: 1.2; }
/* 金额用全站统一的语义色（与数据总览/明细一致） */
.card-value.amount { color: #f56c6c; }
.card-value.amount.warning { color: #e6a23c; }
.card-sub { font-size: 12px; color: #c0c4cc; margin-top: 6px; }
/* 较上期：涨红跌绿（全站金额语义色），持平走中性灰 */
.card-value.is-down { color: #67c23a; }
.card-value.is-flat { color: #909399; }
/* 第 4 张卡副标题里的涨跌：同一个语义色，但小一档 */
.card-sub .delta-up { color: #f56c6c; font-weight: 600; }
.card-sub .delta-down { color: #67c23a; font-weight: 600; }
.card-sub .delta-flat { color: #909399; font-weight: 600; }

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
.card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
/* 卡片标题右侧：客户筛选 + 条数/合计。单独包一层，免得 space-between 把它们拉到两边 */
.head-right { display: flex; align-items: center; gap: 12px; min-width: 0; }
/* 客户筛选做成「按钮」观感 —— 卡片标题里放个淡输入框太容易被忽略，
   填充底色 + 描边 + 加粗，一眼看出这是个能点的筛选项。空着时显示「按客户筛选」。 */
.cust-filter { width: 230px; flex: 0 0 auto; }
.cust-filter :deep(.el-select__wrapper) {
  background-color: #ecf5ff;
  box-shadow: 0 0 0 1px #a0cfff inset;
  font-weight: 600;
}
.cust-filter :deep(.el-select__wrapper:hover) {
  background-color: #d9ecff;
  box-shadow: 0 0 0 1px #409eff inset;
}
.cust-filter :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px #409eff inset;
}
.cust-filter :deep(.el-select__prefix) { color: #409eff; }
.cust-filter :deep(.el-select__placeholder) { color: #409eff; }
.head-sub { font-size: 13px; color: #909399; }

.amount { color: #f56c6c; font-weight: 600; }
.amount.warning { color: #e6a23c; }

/* 备注（跟进情况）：空着时是可点的浅色提示，填了之后变深；
   悬停加下划线 + 主题蓝，让人一眼看出「这一格能写」——
   与「明细查询」页同一套样式，两页观感一致。 */
.note { color: #909399; font-size: 13px; }
.note-editable { color: #409eff; cursor: pointer; }
.note-editable:hover { text-decoration: underline; }
/* 空值（如地区/行系没数据）灰显「—」，与「明细查询」页一致 */
.date-missing { color: #c0c4cc; }

/* 明细表：单元格一律不换行 —— 宽度不够就让表格横向滚动，而不是折行把行高搞乱 */
:deep(.el-table .cell) { white-space: nowrap; }
/* 但备注编辑框必须能换行：white-space 会继承下来，长句子会被压成一行、autosize 也量不准高度 */
:deep(.el-textarea__inner) { white-space: pre-wrap; }

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
  .head-right { flex-wrap: wrap; gap: 6px; }
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
