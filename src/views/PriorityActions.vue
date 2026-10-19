<template>
  <div class="container" v-loading="loading">
    <PageHeader title="待处理优先级清单" sub="按「金额 × 账龄」排出的催收顺序 —— 先打哪个电话">
      <template #meta>
        <el-tag v-if="snapshotDate" type="info" effect="plain">数据日期 {{ snapshotDate }}</el-tag>
      </template>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </PageHeader>

    <!-- ====== 业务线切换（与后端 PRIORITY_BIZ 白名单一致） ====== -->
    <el-radio-group v-model="bizType" class="biz-switch" @change="load">
      <el-radio-button value="billed_unpaid">已开票未回款</el-radio-button>
      <el-radio-button value="shipped_uninvoiced">已发货未开票</el-radio-button>
    </el-radio-group>

    <el-empty v-if="!loading && !rows.length" description="当前业务线下没有数据" />

    <template v-else-if="!loading">
      <!-- ====== ① 一句话结论 ====== -->
      <el-card shadow="never" class="verdict-card">
        <div class="verdict">
          <span class="verdict-label">结论</span>
          <p v-html="verdictHtml" />
        </div>
      </el-card>

      <!-- ====== ② 顶部四个数 ====== -->
      <el-row :gutter="16" class="stat-row">
        <el-col :xs="12" :sm="6">
          <div class="stat-card">
            <div class="stat-label">未处理总额</div>
            <div class="stat-value">{{ wan(summary.totalAmount) }}</div>
            <div class="stat-sub">万 · {{ summary.totalCount }} 条单据</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="6">
          <div class="stat-card">
            <div class="stat-label">TOP 10 集中度</div>
            <div class="stat-value" :class="summary.top10Ratio >= 50 ? 'is-warn' : ''">{{ summary.top10Ratio }}%</div>
            <div class="stat-sub">前 10 笔占总额 {{ wan(summary.top10Amount) }} 万</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="6">
          <div class="stat-card">
            <div class="stat-label">最大单笔</div>
            <div class="stat-value">{{ wan(rows[0]?.amount) }}</div>
            <div class="stat-sub">万 · {{ rows[0]?.customer || '—' }}</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="6">
          <div class="stat-card">
            <div class="stat-label">小额长尾</div>
            <div class="stat-value">{{ summary.smallOldCount }}</div>
            <div class="stat-sub">条合计仅 {{ wan(summary.smallOldAmount) }} 万（≥2个月且 &lt;1万）</div>
          </div>
        </el-col>
      </el-row>

      <!-- ====== ③ 催收顺序表 ====== -->
      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <b>催收顺序（账龄优先）</b>
            <span class="toolbar-desc">按账龄排序：3个月以上 → 当月；同账龄内金额大优先</span>
            <div class="head-right">
              <span class="muted">显示前</span>
              <el-select v-model="limit" size="small" style="width: 88px" @change="load">
                <el-option :value="10" label="10 条" />
                <el-option :value="20" label="20 条" />
                <el-option :value="50" label="50 条" />
                <el-option :value="100" label="100 条" />
              </el-select>
            </div>
          </div>
        </template>

        <!-- ====== 筛选栏 ====== -->
        <div class="filter-bar">
          <el-select v-model="filterAging" placeholder="全部账龄" clearable size="small" style="width: 140px" @change="load">
            <el-option label="3个月以上" value="3个月以上" />
            <el-option label="3个月" value="3个月" />
            <el-option label="2个月" value="2个月" />
            <el-option label="1个月" value="1个月" />
            <el-option label="当月" value="当月" />
          </el-select>
          <el-select v-model="filterSalesperson" placeholder="全部业务员" clearable filterable size="small" style="width: 160px" @change="load">
            <el-option v-for="sp in salespersonOptions" :key="sp" :label="sp" :value="sp" />
          </el-select>
          <el-input v-model="filterKeyword" placeholder="搜客户 / 单据号" clearable size="small" style="width: 200px" @clear="load" @keyup.enter="load" />
          <el-button size="small" @click="resetFilter">重置</el-button>
        </div>

        <el-table
          :data="rows"
          border
          stripe
          :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
          style="width: 100%"
          :row-class-name="rowClass"
        >
          <el-table-column label="优先" width="60" align="center">
            <template #default="{ $index }">
              <span class="rank" :class="{ 'rank-top': $index < 3 }">{{ $index + 1 }}</span>
            </template>
          </el-table-column>
          <el-table-column label="客户" prop="customer" min-width="180" show-overflow-tooltip />
          <el-table-column label="业务员" prop="salesperson" width="110" />
          <el-table-column label="单据号" prop="docNo" width="150" show-overflow-tooltip />
          <el-table-column label="单据日期" prop="docDate" width="110" align="center" />
          <el-table-column label="账龄" width="110" align="center">
            <template #default="{ row }">
              <el-tag :type="agingTagType(row.aging)" size="small" effect="dark">{{ row.aging }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="金额(元)" width="140" align="right">
            <template #default="{ row }">{{ money(row.amount) }}</template>
          </el-table-column>
          <el-table-column label="风险分" width="90" align="right">
            <template #default="{ row }">
              <span class="score">{{ row.agingWeight.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="城市" prop="city" width="100" align="center">
            <template #default="{ row }">{{ row.city || '—' }}</template>
          </el-table-column>
          <el-table-column label="进度反馈" prop="note" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ row.note || '—' }}</template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- ====== ④ 高风险集中在谁身上 ====== -->
      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <b>高风险集中在谁身上</b>
            <span class="head-sub">按「3 个月以上」金额倒序 —— 找对人比找对单更省事</span>
          </div>
        </template>
        <el-table
          :data="salespersons"
          border
          :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
          style="width: 100%"
          :row-class-name="spRowClass"
        >
          <el-table-column label="业务员" prop="salesperson" width="140" />
          <el-table-column label="3个月以上(元)" width="160" align="right">
            <template #default="{ row }">{{ money(row.over3m) }}</template>
          </el-table-column>
          <el-table-column label="占比" width="200">
            <template #default="{ row }">
              <div class="ratio-cell">
                <div class="ratio-bar">
                  <div class="ratio-fill" :style="{ width: barWidth(row.over3m) }" />
                </div>
                <span class="ratio-text">{{ pct(row.over3m, totalOver3m) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="合计(元)" width="150" align="right">
            <template #default="{ row }">{{ money(row.amount) }}</template>
          </el-table-column>
          <el-table-column label="单据数" prop="count" width="90" align="right" />
          <el-table-column label="风险分" width="100" align="right">
            <template #default="{ row }"><b class="score">{{ row.score.toFixed(2) }}</b></template>
          </el-table-column>
        </el-table>
        <div class="foot-note">
          合计「3 个月以上」{{ money(totalOver3m) }} 元（{{ wan(totalOver3m) }} 万），此处只列有老账的业务员。
        </div>
      </el-card>

      <!-- ====== ⑤ 口径说明（写给看的人，不是写给开发者） ====== -->
      <el-card shadow="never" class="block">
        <template #header><b>这张清单怎么来的</b></template>
        <div class="plan-text">
          <ul>
            <li><b>账龄系数</b>：3个月以上 1.0 / 3个月 0.75 / 2个月 0.55 / 1个月 0.35 / 当月 0.15。用于显示优先级权重。</li>
            <li>金额取本业务线的<b>「销售金额合计」口径</b>，与「数据总览」页一致，不含客户平台线（口径不同，不混算）。</li>
            <li><b>账龄</b>按快照当月月末为基准反推：≥90 天 = 3个月以上，≥60 = 2个月，≥30 = 1个月，其余为当月。</li>
            <li><b>小额长尾</b>指账龄 ≥2 个月且金额 &lt; 1 万元的单据 —— 催收成本可能高于欠款本身，建议单独批量处理。</li>
            <li>本页为<b>只读清单</b>，不写回任何表；数据随同步更新。</li>
          </ul>
        </div>
      </el-card>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import request from '@/api/request'
import PageHeader from '@/components/PageHeader.vue'

const loading = ref(true)
const bizType = ref('billed_unpaid')
const limit = ref(20)
const filterAging = ref('')
const filterSalesperson = ref('')
const filterKeyword = ref('')

const snapshotDate = ref('')
const rows = ref([])
const salespersons = ref([])
const summary = ref({
  totalAmount: 0,
  totalCount: 0,
  top10Amount: 0,
  top10Ratio: 0,
  smallThreshold: 10000,
  smallOldCount: 0,
  smallOldAmount: 0,
})

const totalOver3m = computed(() => salespersons.value.reduce((s, p) => s + (p.over3m || 0), 0))
const maxOver3m = computed(() => Math.max(1, ...salespersons.value.map((p) => p.over3m || 0)))

/** 业务员筛选选项：从数据中自动提取去重列表 */
const salespersonOptions = computed(() =>
  [...new Set(rows.value.map((r) => r.salesperson).filter(Boolean))].sort()
)

/** 一句话结论：把三个数拼成老板能直接读的句子 */
const verdictHtml = computed(() => {
  const s = summary.value
  if (!rows.value.length) return ''
  const top = rows.value[0]
  const parts = [
    `当前「${bizLabel.value}」共 <b>${s.totalCount}</b> 条、合计 <b>${wan(s.totalAmount)} 万</b>。`,
    `最大一笔是 <b>${top.customer}</b>（${top.salesperson}）的 <b>${wan(top.amount)} 万</b>，账龄 ${top.aging}。`,
    `前 10 笔占了总额的 <b>${s.top10Ratio}%</b>，${s.top10Ratio >= 50 ? '—— 管住这几笔就管住了大半，建议先从这里下手。' : '分布相对分散，需要按业务员分工推进。'}`,
    s.smallOldCount > 0
      ? `另有 <b>${s.smallOldCount}</b> 笔小额老账，合计仅 ${wan(s.smallOldAmount)} 万，建议打包处理、不必单独立项。`
      : '',
  ]
  return parts.filter(Boolean).join(' ')
})

const bizLabel = computed(() =>
  bizType.value === 'shipped_uninvoiced' ? '已发货未开票' : '已开票未回款'
)

function money(n) {
  return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function wan(n) {
  return (Number(n || 0) / 10000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function pct(part, all) {
  if (!all) return '0.0%'
  return ((part / all) * 100).toFixed(1) + '%'
}
function barWidth(v) {
  return Math.max(2, ((v || 0) / maxOver3m.value) * 100) + '%'
}
function agingTagType(aging) {
  if (aging === '3个月以上') return 'danger'
  if (aging === '3个月') return 'warning'
  if (aging === '2个月') return 'warning'
  if (aging === '1个月') return 'primary'
  return 'info'
}
// 老账高亮：3个月以上整行淡红
function rowClass({ row }) {
  return row.aging === '3个月以上' ? 'row-warn' : ''
}
function spRowClass({ row, rowIndex }) {
  return rowIndex < 3 ? 'row-em' : ''
}

async function load() {
  loading.value = true
  try {
    const params = { bizType: bizType.value, limit: limit.value }
    if (filterAging.value) params.filterAging = filterAging.value
    if (filterSalesperson.value) params.filterSalesperson = filterSalesperson.value
    if (filterKeyword.value) params.filterKeyword = filterKeyword.value
    const res = await request.get('/priority/actions', { params })
    snapshotDate.value = res.snapshotDate || ''
    rows.value = res.rows || []
    salespersons.value = res.salespersons || []
    if (res.summary) summary.value = res.summary
  } catch (e) {
    rows.value = []
    salespersons.value = []
  } finally {
    loading.value = false
  }
}

function resetFilter() {
  filterAging.value = ''
  filterSalesperson.value = ''
  filterKeyword.value = ''
  load()
}

onMounted(load)
</script>

<style scoped>
.biz-switch {
  margin-bottom: 16px;
}

/* 结论条：整页最重要的一句话，给它深色底 */
.verdict-card {
  border-radius: 12px;
  margin-bottom: 16px;
  border-left: 4px solid #2563eb;
}
.verdict {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.verdict-label {
  flex-shrink: 0;
  background: #2563eb;
  color: #fff;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 10px;
  margin-top: 3px;
}
.verdict p {
  margin: 0;
  font-size: 15px;
  line-height: 1.8;
  color: #303133;
}

.stat-row {
  margin-bottom: 16px;
}
.stat-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  padding: 16px;
  text-align: center;
  height: 100%;
}
.stat-label {
  font-size: 13px;
  color: #6b7280;
  margin-bottom: 8px;
}
.stat-value {
  font-size: 26px;
  font-weight: 700;
  color: #1f2937;
  line-height: 1.2;
}
.stat-value.is-warn {
  color: #f56c6c;
}
.stat-sub {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 6px;
}

.block {
  margin-bottom: 16px;
  border-radius: 12px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.head-sub {
  font-size: 12px;
  color: #909399;
}
.head-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.rank {
  display: inline-block;
  width: 22px;
  height: 22px;
  line-height: 22px;
  border-radius: 50%;
  background: #f0f2f5;
  color: #606266;
  font-size: 12px;
}
.rank-top {
  background: #f56c6c;
  color: #fff;
  font-weight: 700;
}
.score {
  color: #d4380d;
}

/* 占比条：左条右数，与客户平台看板同款 */
.ratio-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ratio-bar {
  flex: 1;
  height: 10px;
  background: #f0f2f5;
  border-radius: 5px;
  overflow: hidden;
}
.ratio-fill {
  height: 100%;
  background: linear-gradient(90deg, #f56c6c, #ff9c6e);
  border-radius: 5px;
  transition: width 0.3s;
}
.ratio-text {
  flex-shrink: 0;
  width: 52px;
  text-align: right;
  font-size: 13px;
  color: #606266;
}

.foot-note {
  margin-top: 12px;
  font-size: 13px;
  color: #909399;
}

.plan-text {
  font-size: 14px;
  line-height: 1.9;
  color: #374151;
}
.plan-text ul {
  margin: 0 0 0 20px;
}
.plan-text li {
  margin: 6px 0;
}

:deep(.row-warn) {
  --el-table-tr-bg-color: #fef0f0;
}
:deep(.row-em td) {
  font-weight: 600;
}

/* 移动端 */
@media (max-width: 768px) {
  .container { padding: 10px; }
  .stat-value { font-size: 20px; }
  .verdict p { font-size: 13px; }
  .verdict { flex-direction: column; gap: 6px; }
  .head-right { margin-left: 0; }
}
</style>
