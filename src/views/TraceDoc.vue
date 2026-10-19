<template>
  <!--
    「单号追溯」独立页（2026-10-12，使用者要求）

    为什么要有这一页：
      明细页的搜索框只能搜**最新批**（后端 `batch_id = 当前批`），
      而「查一笔账」要查的往往正是**已经从源表消失**的单（结清 / 删单 / 改数 / 挪到另一条线）。
      实测：`2026-550` 已消失 ⇒ 明细页两条线都搜不到（0 条）。

      这一页跨**全部历史批次**查一个单号，把快照按日期连成时间线，
      并直接告诉你「首次出现 / 最后一次出现 / 当前最新批还在不在」。

    ⚠️ 纯只读新页，不改动任何既有页面与口径。
  -->
  <div class="container">
    <PageHeader
      title="单号追溯"
      sub="输入客户名称（或单号）：查该客户名下的单据 / 看某单号从出现到消失的全过程 —— 跨全部历史批次，两条业务线都查"
    />

    <div class="trace-bar">
      <el-input
        v-model="docNo"
        placeholder="输入客户名称或单据编号，如 农行区分行私银部陈诚"
        clearable
        style="max-width: 440px"
        @keyup.enter="run"
        @clear="reset"
      />
      <el-button type="primary" :loading="loading" @click="run">查询</el-button>
      <span class="trace-tip">客户名 / 单号记不全可以只输一部分，会给出候选</span>
    </div>

    <!-- 还没查 -->
    <el-empty v-if="!queried" description="输入客户名称或单据编号后点「查询」" :image-size="80" />

    <!-- 查不到 -->
    <el-empty v-else-if="res.match === 'none'" :image-size="80">
      <template #description>
        <div>没查到「<b>{{ res.query }}</b>」相关的客户或单号</div>
        <div class="trace-sub">可能原因：客户名 / 单号写错了，或这张单在源表里也从来没出现过</div>
      </template>
    </el-empty>

    <!-- 模糊命中：给候选 -->
    <div v-else-if="res.match === 'fuzzy'" class="trace-block">
      <div class="trace-hint">
        没有精确匹配「<b>{{ res.query }}</b>」的单号。下面是<b>单号或挂账客户</b>包含这几个字的候选
        （共 {{ res.candidatesTotal }} 个<template v-if="res.candidatesTruncated">，只显示最近 {{ res.candidates.length }} 个</template>），
        点一行查看该单的时间线：
      </div>
      <el-table
        :data="res.candidates"
        border
        size="small"
        class="trace-cand"
        :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
        @row-click="onPick"
      >
        <el-table-column prop="docNo" label="单据编号" width="150" />
        <el-table-column prop="bizLabel" label="业务线" width="110" />
        <el-table-column prop="customerName" label="挂账客户" min-width="180" show-overflow-tooltip />
        <el-table-column prop="salesperson" label="业务员" width="100" show-overflow-tooltip />
        <el-table-column label="现状" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.inLatest" size="small" type="success" effect="plain">仍在最新批</el-tag>
            <el-tag v-else size="small" type="warning" effect="plain">已消失</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最后出现" width="110" align="center">
          <template #default="{ row }">{{ row.lastDate }}</template>
        </el-table-column>
        <el-table-column label="最后金额" width="140" align="right">
          <template #default="{ row }">{{ fmt(row.lastAmount) }}</template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 精确命中：时间线 -->
    <template v-else>
      <div v-for="s in res.series" :key="s.bizType + '|' + s.docNo" class="trace-block">
        <div class="trace-head">
          <div class="trace-title">
            <span class="trace-doc">{{ s.docNo }}</span>
            <el-tag size="small" effect="plain">{{ s.bizLabel }}</el-tag>
            <el-tag v-if="s.inLatest" size="small" type="success" effect="plain">
              仍在最新批（{{ s.latestBatchDate }}）
            </el-tag>
            <el-tag v-else size="small" type="warning" effect="plain">
              最新批（{{ s.latestBatchDate }}）已无此单
            </el-tag>
          </div>
          <div class="trace-meta">
            挂账客户 <b>{{ s.customerName }}</b> ｜ 业务员 <b>{{ s.salesperson }}</b>
            <template v-if="s.city"> ｜ 城市 <b>{{ s.city }}</b></template>
            <template v-if="s.docDate"> ｜ 下单日期 <b>{{ s.docDate }}</b></template>
          </div>
        </div>

        <div class="trace-sum">
          共在 <b>{{ s.appearedBatches }}</b> 个批次里出现过：首次 <b>{{ s.firstDate }}</b>
          → 最后一次 <b>{{ s.lastDate }}</b>
        </div>

        <el-table
          :data="s.points"
          border
          size="small"
          :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
        >
          <el-table-column label="快照日期" width="120" align="center">
            <template #default="{ row, $index }">
              <span>{{ row.snapshotDate }}</span>
              <el-tag v-if="$index === 0" size="small" type="info" effect="plain" class="trace-mini">首次</el-tag>
              <el-tag
                v-else-if="$index === s.points.length - 1 && !s.inLatest"
                size="small"
                type="warning"
                effect="plain"
                class="trace-mini"
              >最后</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="金额" width="150" align="right">
            <template #default="{ row }">{{ fmt(row.amount) }}</template>
          </el-table-column>
          <el-table-column label="比上次出现" width="150" align="right">
            <template #default="{ row }">
              <span v-if="row.delta === null" class="trace-muted">—（首次）</span>
              <span v-else-if="Math.abs(row.delta) < 0.005" class="trace-muted">持平</span>
              <span v-else :class="cls(row.delta)">{{ fmtSigned(row.delta) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="agingCategory" label="账龄" min-width="170" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="110" show-overflow-tooltip />
          <el-table-column label="城市" width="100" align="center">
            <template #default="{ row }">{{ row.city || '—' }}</template>
          </el-table-column>
        </el-table>
      </div>

      <div class="trace-caveat">
        <b>怎么读这张表</b>：每行是<b>源表当天快照</b>里这一单的样子。金额「比上次出现」是跟
        <b>上一次真正出现过的批次</b>比（同一单不会每批都出现，所以基准不是「上一批」）。<br />
        某批之后<b>不再出现</b>，通常意味着这一单<b>已结清 / 已开票转线 / 被删单</b> ——
        看板只能看到「没了」，<b>分不出具体是哪种</b>，要定论得回源表核对。
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/api/request'
import PageHeader from '@/components/PageHeader.vue'

const docNo = ref('')
const loading = ref(false)
const queried = ref(false)
const res = reactive({ query: '', match: 'none', series: [], candidates: [], candidatesTotal: 0, candidatesTruncated: false })

const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtSigned = (n) => {
  const v = Number(n || 0)
  if (Math.abs(v) < 0.005) return '0.00'
  return (v > 0 ? '+' : '-') + fmt(Math.abs(v))
}
/** 沿用国内口径：增加=红、减少=绿 */
const cls = (n) => (Number(n || 0) > 0 ? 'red' : Number(n || 0) < 0 ? 'green' : 'trace-muted')

async function query(kw) {
  const q = String(kw ?? '').trim()
  if (!q) {
    ElMessage.warning('请先输入客户名称或单据编号')
    return
  }
  loading.value = true
  try {
    const d = await request.get('/trace', { params: { docNo: q } })
    res.query = d.query || q
    res.match = d.match || 'none'
    res.series = d.series || []
    res.candidates = d.candidates || []
    res.candidatesTotal = d.candidatesTotal || 0
    res.candidatesTruncated = !!d.candidatesTruncated
    queried.value = true
  } catch (err) {
    console.error('[单号追溯] 查询失败:', err)
    ElMessage.error('查询失败，请稍后重试')
  } finally {
    loading.value = false
  }
}

function run() {
  query(docNo.value)
}

function onPick(row) {
  docNo.value = row.docNo
  query(row.docNo)
}

function reset() {
  queried.value = false
  res.match = 'none'
  res.series = []
  res.candidates = []
}
</script>

<style scoped>
.container { padding: 20px; background: #fff; border-radius: 8px; }

.trace-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
.trace-tip { font-size: 12px; color: #909399; }
.trace-sub { font-size: 12.5px; color: #909399; margin-top: 4px; }

.trace-block { margin-bottom: 22px; }
.trace-head { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.trace-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.trace-doc { font-size: 17px; font-weight: 600; color: #303133; letter-spacing: 0.3px; }
.trace-meta { font-size: 13px; color: #606266; }
.trace-meta b { color: #303133; font-weight: 600; }
.trace-sum { font-size: 13px; color: #606266; margin-bottom: 8px; }
.trace-sum b { color: #303133; font-weight: 600; }

.trace-hint {
  font-size: 13px; color: #606266; background: #fdf6ec;
  border-left: 3px solid #e6a23c; border-radius: 4px; padding: 8px 12px; margin-bottom: 10px;
}
.trace-hint b { color: #303133; }
.trace-cand :deep(.el-table__row) { cursor: pointer; }

.trace-mini { margin-left: 6px; transform: scale(0.9); }

.trace-caveat {
  font-size: 12px; color: #909399; line-height: 1.7; background: #f5f7fa;
  border-radius: 4px; padding: 10px 12px; margin-top: 4px;
}
.trace-caveat b { color: #606266; font-weight: 600; }

.red { color: #f56c6c; }
.green { color: #67c23a; }
.trace-muted { color: #a8abb2; }

:deep(.el-table .cell) { white-space: nowrap; }
</style>
