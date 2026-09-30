<template>
  <!--
    首页 = 交付型门户（2026-09-28 重做）
    改造前这里只有 4 张金额卡 + 「数据源明细」表，与「总系统」(/system-hub) 完全重复，
    所以先清空成只留标题。随后使用者提出三件事，本次一并落地：
      1. 有交付感的快捷入口 —— 左侧 6 个入口卡（真的能点、真的跳转，关键入口标「推荐」）
      2. 粒子效果           —— 顶部 hero 区 Canvas 手写粒子星座网（不引第三方库）
      3. 平台介绍内容       —— 三条业务线 / 取数流程 / 使用说明

    注意：粒子动画必须挂在 .no-export 之外 —— 首页本身没有「导出看板图片」按钮，
    但用户可能从 /home 导出整页，样式上仍保持不含 .no-export 依赖，避免误伤。
  -->
  <div class="container">
    <!-- ---------------- Hero：标题 + 粒子 ---------------- -->
    <section class="hero">
      <canvas ref="cvRef" class="hero-canvas" aria-hidden="true"></canvas>
      <div class="hero-inner">
        <h1 class="hero-title">回款/开票管理系统</h1>
        <p class="hero-sub">
          已开票未回款 · 已发货未开票 · 客户平台未回款，三条业务线统一看板
        </p>
        <!--
          hero 上的三个数字（2026-09-28 修正）：
          原先 stat1/stat2 是写死的占位文案（"3 条 / 2 个"），其中「2 个在查明细」纯属编造，
          与库里实际数据对不上，会误导人 —— 使用者明确「首页就是导航门面，数据一律去
          /home 和 /system-hub 看」，所以这里只保留唯一一个能真实拿到、且不会说谎的数字：
          最新数据快照日期（取 /api/biz-types 里所有业务线的 snapshotDate 最大值）。
          拿不到数据时整块隐藏，宁可不显示也不显示假的。
        -->
        <div v-if="snapshotDate" class="hero-stats">
          <div class="stat">
            <div class="stat-num">{{ shownDate }}</div>
            <div class="stat-lbl">最新数据快照</div>
          </div>
          <span class="stat-div"></span>
          <div class="stat">
            <div class="stat-num">{{ shownTypes }}</div>
            <div class="stat-lbl">业务线已入库</div>
          </div>
        </div>
        <div class="hero-actions">
          <el-button type="primary" size="large" class="cta" @click="go('/home')">
            <el-icon><DataAnalysis /></el-icon> 进入数据概览
          </el-button>
          <el-button size="large" class="cta ghost" @click="go('/detail')">
            <el-icon><Document /></el-icon> 查询明细
          </el-button>
        </div>
      </div>
    </section>

    <!-- ---------------- 主体：快捷入口 + 平台介绍 ---------------- -->
    <div class="body-grid">
      <!-- 左：快捷入口 -->
      <section class="panel entries-panel no-export">
        <div class="panel-head">
          <h2 class="panel-title">快捷入口</h2>
          <span class="panel-hint">按常用程度排序，点卡片直接进入</span>
        </div>
        <div class="entries">
          <button
            v-for="(e, i) in entries"
            :key="e.path"
            class="entry"
            :class="{ primary: e.primary }"
            :style="{ animationDelay: `${i * 60}ms` }"
            type="button"
            @click="go(e.path)"
          >
            <span class="entry-icon" :style="{ background: e.color }">
              <el-icon><component :is="e.icon" /></el-icon>
            </span>
            <span class="entry-main">
              <span class="entry-name">
                {{ e.name }}
                <el-tag v-if="e.primary" size="small" type="warning" effect="dark" class="entry-badge">
                  推荐
                </el-tag>
              </span>
              <span class="entry-desc">{{ e.desc }}</span>
            </span>
            <el-icon class="entry-arrow"><ArrowRight /></el-icon>
          </button>
        </div>
      </section>

      <!-- 右：平台介绍 -->
      <section class="panel intro-panel">
        <div class="panel-head">
          <h2 class="panel-title">平台简介</h2>
          <span class="panel-hint">这个系统解决什么问题</span>
        </div>

        <p class="intro-lead">
          把散落在金山文档多维表格里的应收数据，自动汇总成可筛选、可导出、可发领导的看板，
          替代原先「每次手动跑脚本 + 微信发表格」的取数方式。
        </p>

        <!-- 三条业务线 -->
        <div class="lines">
          <div v-for="l in bizLines" :key="l.name" class="line">
            <span class="line-dot" :style="{ background: l.color }"></span>
            <div class="line-body">
              <div class="line-name">{{ l.name }}<span class="line-tag">{{ l.tag }}</span></div>
              <div class="line-desc">{{ l.desc }}</div>
            </div>
          </div>
        </div>

        <!-- 取数流程 -->
        <div class="flow-block">
          <div class="block-title">数据怎么来的</div>
          <ol class="flow">
            <li v-for="(f, i) in flow" :key="f">
              <span class="flow-idx">{{ i + 1 }}</span>
              <span>{{ f }}</span>
            </li>
          </ol>
        </div>

        <!-- 使用说明 -->
        <div class="tips-block">
          <div class="block-title">使用说明</div>
          <ul class="tips">
            <li v-for="t in tips" :key="t">
              <el-icon class="tip-icon"><InfoFilled /></el-icon>
              <span v-html="t"></span>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowRight, DataAnalysis, Document, Grid, InfoFilled, Money,
  TrendCharts, User,
} from '@element-plus/icons-vue'
import { getBizTypes } from '@/api'
import { useAuth } from '@/composables/useAuth'

const router = useRouter()
const { role } = useAuth()
const isAdmin = computed(() => role.value === 'admin')

function go(path) {
  router.push(path)
}

// ------------------------------------------------------------
// 快捷入口
// ------------------------------------------------------------
// 顺序 = 使用频率。管理员比成员多一条「系统管理」。
const entries = computed(() => {
  const list = [
    {
      name: '数据概览', path: '/home', icon: DataAnalysis, primary: true,
      color: 'linear-gradient(135deg,#409eff,#2c6fd1)',
      desc: '业务员 × 账龄段矩阵，一屏看清谁欠得多、欠多久',
    },
    {
      name: '明细查询', path: '/detail', icon: Document, primary: true,
      color: 'linear-gradient(135deg,#36cfc9,#13a8a8)',
      desc: '按业务员 / 客户 / 账龄筛选，可改备注、可导出 Excel',
    },
    {
      name: '客户平台未回款', path: '/customer-platform-unpaid', icon: Money,
      color: 'linear-gradient(135deg,#ffa940,#fa8c16)',
      desc: '客户在各平台的未回款金额，按客户 + 平台两级汇总',
    },
    {
      name: '每日趋势', path: '/trend', icon: TrendCharts,
      color: 'linear-gradient(135deg,#9254de,#722ed1)',
      desc: '金额随时间怎么变，判断催收有没有效果',
    },
    {
      name: '我的业绩', path: '/my-performance', icon: User,
      color: 'linear-gradient(135deg,#73d13d,#389e0d)',
      desc: '只看自己名下的回款/开票情况，不含他人数据',
    },
    {
      name: '系统总览', path: '/system-hub', icon: Grid,
      color: 'linear-gradient(135deg,#8c8c8c,#595959)',
      desc: '全部子项目的入口与整体数据概况',
    },
  ]
  if (isAdmin.value) {
    list.push({
      name: '系统管理', path: '/system', icon: Grid,
      color: 'linear-gradient(135deg,#597ef7,#2f54eb)',
      desc: '手动同步最新数据、查看同步记录与数据源状态（仅管理员）',
    })
  }
  return list
})

// ------------------------------------------------------------
// 平台介绍：三条业务线
// ------------------------------------------------------------
const bizLines = [
  {
    name: '已开票未回款',
    tag: '未回款',
    color: '#f5222d',
    desc: '已经开出发票、客户还没打款的金额。含挂账客户、业务员、城市、账龄分档，是催收的主要依据。',
  },
  {
    name: '已发货未开票',
    tag: '未开票',
    color: '#fa8c16',
    desc: '货已发出、发票还没开的金额。用来盯开票进度，避免长期挂着不确认收入。',
  },
  {
    name: '客户平台未回款',
    tag: '平台',
    color: '#1890ff',
    desc: '客户在电商/商超等平台上产生的未回款金额，按「客户 + 平台」两级拆分统计。',
  },
]

// ------------------------------------------------------------
// 平台介绍：取数流程
// ------------------------------------------------------------
const flow = [
  '取数脚本从「金山文档多维表格」抓取三张源表（未回款 / 未开票 / 客户平台），落到本地导出目录',
  '后端解析 Excel 并写入 PostgreSQL（同类型同日覆盖，不会重复累加）',
  '每张数据都带一个「快照日期」，页面上看到的数字就是那一天的切片',
  '在「系统管理 → 立即同步」手动触发一次同步，几秒后页面刷新即可看到最新数据',
]

// ------------------------------------------------------------
// 平台介绍：使用说明
// ------------------------------------------------------------
// 注意：这里用 v-html，内容是写死的常量（不含用户输入），不存在注入风险。
const tips = [
  '顶部<b>业务类型</b>切换决定「数据概览 / 明细查询 / 每日趋势」三页看的是哪条业务线',
  '金额一律<b>右对齐 + 千分位 + 2 位小数</b>；账龄列颜色固定 <b>红→橙→黄→蓝→绿（老→新）</b>',
  '管理员与成员权限不同：<b>成员不能同步数据、进不了系统管理</b>，但可正常查数、改备注、导 Excel',
  '「数据概览」右上角<b>导出看板图片</b>可直接生成整页 PNG，发给领导用',
]

// ------------------------------------------------------------
// Hero 上的数字：只显示真实数据，拿不到就整块不显示
// ------------------------------------------------------------
// 为什么只留这两个：
//   使用者 2026-09-28 明确「首页就是导航门面，数据一律去 /home 和 /system-hub 看」，
//   所以首页不承担数据展示职责。但原来那两个写死的「3 条 / 2 个」是假的（尤其
//   「2 个在查明细」纯属编造），宁可少显示也不能显示错的 —— 索性只留能从接口
//   真实拿到、且不会随数据推进而说错的两个。
const snapshotDate = ref('')   // 全库最新快照日期，如 09-24
const onlineTypes = ref('')    // 已有数据的业务线条数，如 2 条

// ------------------------------------------------------------
// 数字滚动动画（2026-09-30 新增）
// ------------------------------------------------------------
// 数据到达后各播一次：
//   - 「业务线已入库」从 0 数到 N（如 0→3 条）
//   - 「最新数据快照」按位滚动：每位数字从 0 滚到目标值，从左到右错开（如 09-30）
// 用户开了「减少动态效果」则直接显示最终值，不播动画。
const shownDate = ref('')    // 滚动中的快照日期（播完 = snapshotDate）
const shownTypes = ref('')   // 滚动中的业务线数（播完 = onlineTypes）
let countRaf = 0

function easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t) }
const prefersReduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function runStatAnimations() {
  if (prefersReduce()) {
    shownDate.value = snapshotDate.value
    shownTypes.value = onlineTypes.value
    return
  }

  // 整数 0 → N：如「3 条」
  const target = parseInt(onlineTypes.value, 10) || 0
  const t0 = performance.now()
  const dur = 900
  const tickTypes = (now) => {
    const p = Math.min(1, (now - t0) / dur)
    shownTypes.value = `${Math.round(easeOutExpo(p) * target)} 条`
    if (p < 1) countRaf = requestAnimationFrame(tickTypes)
  }
  countRaf = requestAnimationFrame(tickTypes)

  // 日期按位滚动：数字位从 0 滚到目标，非数字位（-）直接显示
  const chars = snapshotDate.value.split('')
  const isDigit = (c) => /[0-9]/.test(c)
  const stagger = 90       // 每位错开 90ms，形成从左到右的滚动感
  const dur2 = 750
  const t1 = performance.now()
  const tickDate = (now) => {
    const elapsed = now - t1
    let out = ''
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      if (!isDigit(c)) { out += c; continue }
      const d = Number(c)
      const p = Math.min(1, Math.max(0, (elapsed - i * stagger) / dur2))
      out += Math.round(easeOutExpo(p) * d)
    }
    shownDate.value = out
    if (elapsed < dur2 + stagger * chars.length) {
      countRaf = requestAnimationFrame(tickDate)
    } else {
      shownDate.value = snapshotDate.value  // 收尾对齐，防浮点偏差
    }
  }
  countRaf = requestAnimationFrame(tickDate)
}

onMounted(async () => {
  try {
    const rows = await getBizTypes()
    if (!Array.isArray(rows) || !rows.length) return
    // 已入库业务线条数：直接数接口返回的条目（库里没数据的业务线不在里面）
    onlineTypes.value = `${rows.length} 条`
    // 最新快照：取所有业务线 snapshotDate 的最大值。
    // 用 MM-DD 而不是完整年，是因为 hero 位置窄，且看板都是当年数据。
    const dates = rows.map((r) => r.snapshotDate).filter(Boolean).sort()
    if (dates.length) snapshotDate.value = dates[dates.length - 1].slice(5)
    runStatAnimations()
  } catch {
    /* 拿不到就不显示这块（v-if 挡住）；首页不该因为一个统计接口挂掉 */
  }
})

// ------------------------------------------------------------
// 粒子效果：手写 Canvas（项目不引第三方粒子库）
// ------------------------------------------------------------
// 做法：hero 区内撒 N 个点，点的速度很慢；两点距离小于阈值时连一条半透明线。
// 这就是常见的「星座网」效果，约 60 行代码，比引 300KB 的库划算。
const cvRef = ref(null)
let raf = 0
let stopFn = null

const PARTICLE_COUNT = 46      // 点数：再多在 1080p 下会显得糊
const LINK_DIST = 132          // 连线阈值（CSS 像素，已按 dpr 缩放）
const SPEED = 0.22             // 每帧位移上限，越小越"稳"，符合看板气质

function startParticles() {
  const cv = cvRef.value
  if (!cv) return
  const ctx = cv.getContext('2d')
  if (!ctx) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  let w = 0
  let h = 0
  let pts = []

  function resize() {
    const rect = cv.getBoundingClientRect()
    w = rect.width
    h = rect.height
    cv.width = Math.max(1, Math.round(w * dpr))
    cv.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // 点数量随面积走，避免大屏太稀、手机太挤
    const n = Math.max(16, Math.min(PARTICLE_COUNT, Math.round((w * h) / 14000)))
    pts = Array.from({ length: n }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * SPEED,
      vy: (Math.random() - 0.5) * SPEED,
      r: Math.random() * 1.4 + 0.8,
    }))
  }

  function draw() {
    ctx.clearRect(0, 0, w, h)

    // 先连线（让点压在线上，层次更清楚）
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x
        const dy = pts[i].y - pts[j].y
        const d2 = dx * dx + dy * dy
        if (d2 > LINK_DIST * LINK_DIST) continue
        const alpha = (1 - Math.sqrt(d2) / LINK_DIST) * 0.34
        ctx.strokeStyle = `rgba(150, 205, 255, ${alpha.toFixed(3)})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(pts[i].x, pts[i].y)
        ctx.lineTo(pts[j].x, pts[j].y)
        ctx.stroke()
      }
    }

    for (const p of pts) {
      p.x += p.vx
      p.y += p.vy
      // 撞边反弹
      if (p.x < 0 || p.x > w) p.vx *= -1
      if (p.y < 0 || p.y > h) p.vy *= -1
      p.x = Math.max(0, Math.min(w, p.x))
      p.y = Math.max(0, Math.min(h, p.y))

      ctx.fillStyle = 'rgba(190, 225, 255, 0.85)'
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }

    raf = requestAnimationFrame(draw)
  }

  resize()
  draw()

  // 尺寸变了要重建点位，否则会留一堆点挤在旧坐标系里
  const ro = new ResizeObserver(() => resize())
  ro.observe(cv)

  // 标签页切到后台时停帧，别白烧 CPU
  function onVis() {
    if (document.hidden) {
      cancelAnimationFrame(raf)
      raf = 0
    } else if (!raf) {
      raf = requestAnimationFrame(draw)
    }
  }
  document.addEventListener('visibilitychange', onVis)

  // 尊重「减少动态效果」偏好
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (mq.matches) {
    cancelAnimationFrame(raf)
    raf = 0
    ctx.clearRect(0, 0, w, h)
  }

  stopFn = () => {
    ro.disconnect()
    document.removeEventListener('visibilitychange', onVis)
  }
}

onMounted(() => {
  startParticles()
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  if (countRaf) cancelAnimationFrame(countRaf)
  if (stopFn) stopFn()
})
</script>

<style scoped>
.container { padding: 20px; }

/* ---------------- Hero ---------------- */
.hero {
  position: relative;
  overflow: hidden;
  border-radius: 12px;
  /* 深蓝渐变底：粒子是浅色，靠这个底色才有"星空"感 */
  background: linear-gradient(135deg, #16283f 0%, #1f3c5c 45%, #2c5f8a 100%);
  color: #fff;
  padding: 40px 36px 34px;
}
.hero-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}
.hero-inner { position: relative; z-index: 1; max-width: 760px; }
.hero-title {
  margin: 0 0 10px;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.hero-sub {
  margin: 0 0 22px;
  color: #cfe0f2;
  font-size: 15px;
  line-height: 1.6;
}

/* Hero 里的三个小数字 */
.hero-stats {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 24px;
}
.stat-num { font-size: 20px; font-weight: 600; color: #fff; line-height: 1.2; font-variant-numeric: tabular-nums; }
.stat-lbl { font-size: 12px; color: #9db8d4; margin-top: 2px; }
.stat-div { width: 1px; height: 26px; background: rgba(255, 255, 255, 0.18); }

.hero-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.cta { font-weight: 500; }
/* 次要按钮在深底上要显式给样式，否则默认白底会和 hero 打架 */
.cta.ghost {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.4);
  color: #fff;
}
.cta.ghost:hover {
  background: rgba(255, 255, 255, 0.2);
  border-color: #fff;
  color: #fff;
}

/* ---------------- 主体两栏 ---------------- */
.body-grid {
  display: grid;
  grid-template-columns: minmax(0, 460px) minmax(0, 1fr);
  gap: 16px;
  margin-top: 16px;
  align-items: start;
}
@media (max-width: 1100px) {
  .body-grid { grid-template-columns: 1fr; }
}
.panel {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.panel-title { margin: 0; font-size: 17px; font-weight: 600; color: #303133; }
.panel-hint { font-size: 12px; color: #a8abb2; }

/* ---------------- 快捷入口卡 ---------------- */
.entries { display: flex; flex-direction: column; gap: 10px; }
.entry {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 13px 14px;
  border: 1px solid #eaecef;
  border-radius: 9px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  /* 入场动画：淡入 + 上浮，逐个错开（animationDelay 在模板里给） */
  animation: entry-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}
.entry:hover {
  transform: translateY(-2px);
  border-color: #c6d4e8;
  box-shadow: 0 6px 16px rgba(31, 60, 92, 0.12);
}
.entry:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
.entry.primary { border-color: #d9e6f7; background: #fafcff; }

.entry-icon {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 19px;
}
.entry-main { flex: 1 1 auto; min-width: 0; }
.entry-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}
.entry-badge { transform: scale(0.86); transform-origin: left center; }
.entry-desc {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}
.entry-arrow {
  flex: 0 0 auto;
  color: #c0c4cc;
  font-size: 15px;
  transition: transform 0.16s ease, color 0.16s ease;
}
.entry:hover .entry-arrow { color: #409eff; transform: translateX(3px); }

@keyframes entry-in {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ---------------- 平台介绍 ---------------- */
.intro-lead {
  margin: 0 0 16px;
  font-size: 13.5px;
  line-height: 1.75;
  color: #5a6270;
  background: #f7f9fc;
  border-left: 3px solid #409eff;
  border-radius: 0 6px 6px 0;
  padding: 11px 14px;
}
.block-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin: 0 0 10px;
  padding-left: 9px;
  border-left: 3px solid #dcdfe6;
}

.lines { display: flex; flex-direction: column; gap: 12px; margin-bottom: 18px; }
.line { display: flex; gap: 10px; }
.line-dot {
  flex: 0 0 auto;
  width: 8px; height: 8px;
  border-radius: 50%;
  margin-top: 6px;
}
.line-name {
  font-size: 13.5px;
  font-weight: 600;
  color: #303133;
  display: flex;
  align-items: center;
  gap: 8px;
}
.line-tag {
  font-size: 11px;
  font-weight: 400;
  color: #7a8290;
  background: #f0f2f5;
  border-radius: 3px;
  padding: 1px 6px;
}
.line-desc { font-size: 12.5px; color: #8b93a1; line-height: 1.65; margin-top: 3px; }

.flow-block { margin-bottom: 18px; }
.flow { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
.flow li {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
  color: #6b7280;
  line-height: 1.6;
}
.flow-idx {
  flex: 0 0 auto;
  width: 18px; height: 18px;
  border-radius: 50%;
  background: #eef4fd;
  color: #409eff;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}

.tips { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
.tips li {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
  color: #6b7280;
  line-height: 1.65;
}
.tip-icon { flex: 0 0 auto; color: #409eff; font-size: 13px; margin-top: 3px; }
.tips b { color: #303133; font-weight: 600; }

/* ---------------- 移动端 ---------------- */
@media (max-width: 768px) {
  .container { padding: 10px; }
  .hero { padding: 24px 18px 22px; border-radius: 10px; }
  .hero-title { font-size: 21px; }
  .hero-sub { font-size: 13px; margin-bottom: 18px; }
  .hero-stats { gap: 14px; margin-bottom: 18px; }
  .stat-num { font-size: 17px; }
  .stat-lbl { font-size: 11px; }
  .hero-actions { gap: 10px; }
  .hero-actions .cta {
    flex: 1 1 auto;
    min-width: 0;
    padding-left: 10px;
    padding-right: 10px;
  }
  .body-grid { gap: 10px; margin-top: 10px; }
  .panel { padding: 14px 14px 16px; }
  .panel-head { flex-direction: column; gap: 2px; margin-bottom: 12px; }
  .entry { padding: 11px 12px; gap: 11px; }
  .entry-icon { width: 34px; height: 34px; font-size: 17px; }
  .entry-name { font-size: 14px; }
}

/* 用户系统里开了「减少动态效果」就不要再做入场动画 */
@media (prefers-reduced-motion: reduce) {
  .entry { animation: none; }
  .entry:hover { transform: none; }
}
</style>
