<template>
  <!--
    页面头部统一骨架。
    为什么要抽：改造前 9 个页面各写一份 .page-header，字号在 22px / 24px 之间漂移、
    有些页标题用 <h1 class="main-title"> 有些用 <h2 class="page-title">、
    日期标签有的用 el-tag 有的用裸 span.sub、右侧操作区有的有有的没有。
    统一到这一个组件后，「标题 / 数据日期 / 右侧操作」的位置在每一页都一样。

    用法：
      <PageHeader title="明细查询">
        <template #meta><el-tag type="info" effect="plain">{{ date }}</el-tag></template>
        <el-button>导出</el-button>
      </PageHeader>

    - title  必填，页面标题
    - sub    可选，标题下方的一行说明（与 meta 二选一或共存）
    - meta   插槽，放数据日期标签等「关于这份数据」的信息，嵌在标题行内
    - 默认插槽  放右侧操作（导出按钮等），不给就不渲染右侧容器
  -->
  <div class="page-header">
    <div class="ph-main">
      <h1 class="main-title">
        {{ title }}
        <slot name="meta" />
        <!--
          数据新鲜度：组件自己拉，调用方零改动。
          为什么放在这：各页已显示「数据日期」，但那是**快照的业务日期**，
          不等于「多久没同步了」。开了定时同步之后，万一定时任务挂了
          （凭证过期 / 网络不通），只有这里能第一时间发现。
          拿不到就整块不渲染 —— 不写死、不猜、不显示 0 分钟。
        -->
        <span v-if="freshness" class="freshness" :class="{ stale: freshness.stale, running: freshness.running }">
          <span class="dot" />{{ freshness.text }}
        </span>
      </h1>
      <p v-if="sub" class="page-sub">{{ sub }}</p>
    </div>
    <div v-if="$slots.default" class="header-right">
      <slot />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { getFreshness } from '@/api'

defineProps({
  title: { type: String, required: true },
  sub: { type: String, default: '' },
})

// 超过这个时长没成功同步，就标成「陈旧」
const STALE_MS = 24 * 60 * 60 * 1000
// 1 分钟刷新一次提示（同步本身是小时级，够用且极轻）
// 2026-10-10：60s → 5min。公网每趟都要绕欧洲节点（约 0.5~1.1s），
// 页面开着就每分钟白跑一趟，纯浪费带宽。新鲜度按「分钟」展示，5 分钟粒度够用。
const TICK_MS = 5 * 60 * 1000

const freshness = ref(null)
let timer = null

/** 把毫秒差转成「刚刚 / X 分钟前 / X 小时前 / X 天前」 */
function humanize(ms) {
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return `${Math.floor(hr / 24)} 天前`
}

function render(state) {
  if (!state) {
    freshness.value = null
    return
  }
  if (state.running) {
    freshness.value = { text: '正在同步…', stale: false, running: true }
    return
  }
  if (!state.lastSyncAt) {
    freshness.value = null // 从未同步过：不显示，避免误导
    return
  }
  const t = new Date(state.lastSyncAt).getTime()
  if (Number.isNaN(t)) {
    freshness.value = null
    return
  }
  const age = Date.now() - t
  const failed = state.ok === false
  freshness.value = {
    text: failed ? `同步失败 · ${humanize(age)}` : `同步于 ${humanize(age)}`,
    stale: failed || age > STALE_MS,
    running: false,
  }
}

async function load() {
  try {
    render(await getFreshness())
  } catch {
    freshness.value = null // 拿不到就不显示，绝不编造
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, TICK_MS)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
/* 统一的口径（改造前各页在 22/24px、16/18/20/24px 之间漂移）：
   标题 24px、与下方内容间距 16px、右侧操作区 flex 居中 */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
  margin-bottom: 16px;
}
.ph-main { min-width: 0; }
.main-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #303133;
}
.page-sub {
  margin: 4px 0 0;
  font-size: 14px;
  color: #909399;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

/* meta 插槽里通常放 el-tag，给它一点左边距让它跟着标题走 */
.main-title :deep(.el-tag) {
  margin-left: 12px;
  vertical-align: middle;
  font-weight: 400;
}

/* 数据新鲜度：刻意比日期标签更淡 —— 它要能被看到，但不该抢主信息的注意力 */
.freshness {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 12px;
  font-size: 12px;
  font-weight: 400;
  color: #909399;
  vertical-align: middle;
  white-space: nowrap;
}
.freshness .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #67c23a;
  flex-shrink: 0;
}
/* 陈旧（超 24h 或上次失败）：转橙色，绿点变橙点 */
.freshness.stale {
  color: #e6a23c;
}
.freshness.stale .dot {
  background: #e6a23c;
}
/* 正在同步：绿点做轻微呼吸，表示后台在动 */
.freshness.running {
  color: #409eff;
}
.freshness.running .dot {
  background: #409eff;
  animation: ph-breathe 1.4s ease-in-out infinite;
}
@keyframes ph-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
@media (prefers-reduced-motion: reduce) {
  .freshness.running .dot { animation: none; }
}

/* 移动端：标题缩到 18px，右侧操作换行到下面一行右对齐 */
@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    margin-bottom: 12px;
  }
  .main-title { font-size: 18px; }
  .page-sub { font-size: 12px; }
  .header-right {
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }
  .main-title :deep(.el-tag) { margin-left: 8px; }
  /* 移动端把新鲜度提示换到标题下方一行，避免把标题挤断 */
  .freshness {
    display: flex;
    margin: 4px 0 0;
    font-size: 11px;
  }
}
</style>
