<template>
  <div class="login-wrap">
    <!-- 左：品牌区（窄屏自动隐藏） -->
    <aside class="brand-panel" aria-hidden="true">
      <canvas ref="bgCanvas" class="brand-canvas"></canvas>
      <span class="orb orb-a"></span>
      <span class="orb orb-b"></span>
      <div class="brand-inner">
        <div class="brand-mark">云</div>
        <h1 class="brand-name">云端看板</h1>
        <p class="brand-tag">应收 / 开票 / 回款 · 一屏看清</p>
        <ul class="brand-points">
          <li><i></i>每日未回款 / 未开票汇总</li>
          <li><i></i>业务员 × 账龄段矩阵</li>
          <li><i></i>客户平台未回款对账</li>
          <li><i></i>单号 / 客户全历史追溯</li>
        </ul>
        <div class="brand-foot">内部系统 · 数据仅供内部使用</div>
      </div>
    </aside>

    <!-- 右：表单区 -->
    <main class="form-panel">
    <div class="login-card">
      <div class="brand-mobile">
        <div class="brand-mark">云</div>
        <div class="brand-name">云端看板</div>
        <div class="brand-tag">应收 / 开票 / 回款</div>
      </div>

      <div class="form-head">
        <h2 class="form-title">登录</h2>
        <p class="form-sub">请使用内部账号登录</p>
      </div>

      <el-alert
        v-if="switching"
        type="info"
        :closable="false"
        show-icon
        class="switch-tip"
      >
        已退出当前账号，请用另一个账号登录
      </el-alert>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        @submit.prevent="onSubmit"
      >
        <el-form-item label="用户名" prop="username">
          <el-input
            ref="userRef"
            v-model="form.username"
            placeholder="请输入用户名"
            size="large"
            autocomplete="username"
            :prefix-icon="User"
          />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            size="large"
            show-password
            autocomplete="current-password"
            :prefix-icon="Lock"
            @keyup.enter="onSubmit"
          />
        </el-form-item>

        <el-form-item v-if="captcha.enabled" label="验证码" prop="captcha">
          <div class="captcha-row">
            <el-input
              v-model="form.captcha"
              placeholder="请输入计算结果"
              size="large"
              maxlength="4"
              autocomplete="off"
              @keyup.enter="onSubmit"
            />
            <button type="button" class="captcha-q" title="点一下换一题" @click="reloadCaptcha">
              {{ captcha.question }}
            </button>
          </div>
        </el-form-item>

        <div class="row-between">
          <el-checkbox v-model="form.remember" size="default">记住我</el-checkbox>
          <span class="remember-hint">保持登录 {{ REMEMBER_DAYS }} 天</span>
        </div>

        <el-alert
          v-if="lockedUntil > 0"
          type="error"
          :closable="false"
          show-icon
          class="lock-tip"
        >
          尝试次数过多，登录已暂时锁定，请约 {{ lockedUntil }} 分钟后再试。
        </el-alert>

        <el-button
          type="primary"
          size="large"
          class="submit"
          :loading="loading"
          @click="onSubmit"
        >
          {{ loading ? '登录中…' : '登 录' }}
        </el-button>
      </el-form>

      <p class="tip">
        本系统仅供内部使用，登录信息在 <code>.env</code> 中配置。
      </p>
    </div>
    </main>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import { login, getMe, setAuthToken, clearAuthToken, getCaptcha } from '@/api'
import { saveAccount } from '@/composables/savedAccounts'

const router = useRouter()
const route = useRoute()

const formRef = ref(null)
const userRef = ref(null)
const loading = ref(false)
// 被限流时剩余的锁定分钟数；0 表示未被锁定
const lockedUntil = ref(0)

// 登录验证码：题面由服务端出，答案不下发。
// 本机回环按配置可能返回 enabled:false（验证脚本免打扰）⇒ 此时不显示这一项。
const captcha = reactive({ enabled: false, token: '', question: '' })

async function reloadCaptcha() {
  try {
    const c = await getCaptcha()
    captcha.enabled = !!c?.enabled
    captcha.token = c?.token || ''
    captcha.question = c?.question || ''
  } catch {
    captcha.enabled = false
    captcha.token = ''
    captcha.question = ''
  }
}

onMounted(() => reloadCaptcha())

// 顶栏「切换账号」跳过来时带 ?switch=1：预填上一个用户名、光标落在密码框
const switching = route.query.switch === '1'
const LAST_USER_KEY = 'cloud-dashboard:last-user'

function readLastUser() {
  try {
    return localStorage.getItem(LAST_USER_KEY) || ''
  } catch {
    return ''
  }
}

function saveLastUser(name) {
  try {
    localStorage.setItem(LAST_USER_KEY, name || '')
  } catch {
    /* 隐私模式忽略 */
  }
}

// 记住登录状态：开启时写入 localStorage，否则只在本次会话内有效
const REMEMBER_KEY = 'cloud-dashboard:remember'
const REMEMBER_DAYS = 7

const savedRemember = (() => {
  try {
    return localStorage.getItem(REMEMBER_KEY) === '1'
  } catch {
    return false
  }
})()

const form = reactive({ username: switching ? readLastUser() : '', password: '', remember: savedRemember, captcha: '' })

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

// ------------------------------------------------------------
// 左侧品牌区的「流星」背景（2026-10-19：使用者「改成流星的感觉」）
//   几颗流星拖着渐隐的尾巴从右上划向左下，背后撒一层很淡、缓慢明灭的星点。
//   纯装饰：aria-hidden、尊重 prefers-reduced-motion、切后台停帧、尺寸为 0 时不画。
// ------------------------------------------------------------
const bgCanvas = ref(null)
let pRaf = 0
let pStop = null

const METEOR_MAX = 5 // 同屏最多几颗流星
const METEOR_TRAIL = [70, 160] // 尾巴长度范围（px）
const METEOR_SPEED = [2.2, 4.4] // 每帧位移（px）
const STAR_COUNT = 26 // 背景星点数

const rnd = (a, b) => a + Math.random() * (b - a)

function startParticles() {
  const cv = bgCanvas.value
  if (!cv) return
  const ctx = cv.getContext('2d')
  if (!ctx) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  let w = 0
  let h = 0
  const meteors = []
  let stars = []

  /** 造一颗流星：从右上方进入、往左下方划（18~40 度） */
  function makeMeteor(initial) {
    const ang = (18 + Math.random() * 22) * (Math.PI / 180)
    const sp = rnd(METEOR_SPEED[0], METEOR_SPEED[1])
    return {
      // 初始的随机铺在画面里；后续的从右上方「画外」飞入
      x: initial ? rnd(0, w * 1.15) : w + rnd(20, w * 0.4),
      y: initial ? rnd(0, h) : -rnd(10, h * 0.35),
      vx: -Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      len: rnd(METEOR_TRAIL[0], METEOR_TRAIL[1]),
      alpha: rnd(0.5, 0.9),
      r: rnd(1.1, 1.9),
      wait: initial ? Math.floor(rnd(0, 90)) : Math.floor(rnd(35, 190)),
    }
  }

  function resize() {
    const rect = cv.getBoundingClientRect()
    w = rect.width
    h = rect.height
    cv.width = Math.max(1, Math.round(w * dpr))
    cv.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!w || !h) {
      meteors.length = 0
      stars = []
      return
    }

    stars = Array.from({ length: STAR_COUNT }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: rnd(0.5, 1.3),
      tw: rnd(0.4, 1.4), // 闪烁频率
      ph: rnd(0, Math.PI * 2),
    }))

    meteors.length = 0
    for (let i = 0; i < METEOR_MAX; i++) meteors.push(makeMeteor(true))
  }

  function draw(now) {
    // 品牌区在窄屏是 display:none ⇒ 尺寸 0，别空转画布
    if (!w || !h) {
      pRaf = requestAnimationFrame(draw)
      return
    }
    const t = (now || 0) / 1000
    ctx.clearRect(0, 0, w, h)

    // 1) 背景星点：很淡，缓慢明灭
    for (const s of stars) {
      const a = 0.1 + 0.28 * (0.5 + 0.5 * Math.sin(t * s.tw + s.ph))
      ctx.fillStyle = `rgba(205, 228, 255, ${a.toFixed(3)})`
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
      ctx.fill()
    }

    // 2) 流星：头亮、尾巴渐隐
    for (const m of meteors) {
      if (m.wait > 0) {
        m.wait--
        continue
      }
      m.x += m.vx
      m.y += m.vy

      const sp = Math.hypot(m.vx, m.vy) || 1
      const tx = m.x - (m.vx / sp) * m.len
      const ty = m.y - (m.vy / sp) * m.len

      const g = ctx.createLinearGradient(m.x, m.y, tx, ty)
      g.addColorStop(0, `rgba(226, 242, 255, ${m.alpha.toFixed(3)})`)
      g.addColorStop(0.35, `rgba(150, 205, 255, ${(m.alpha * 0.42).toFixed(3)})`)
      g.addColorStop(1, 'rgba(150, 205, 255, 0)')

      ctx.strokeStyle = g
      ctx.lineWidth = m.r
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(m.x, m.y)
      ctx.lineTo(tx, ty)
      ctx.stroke()

      // 头部小光点
      ctx.fillStyle = `rgba(240, 250, 255, ${m.alpha.toFixed(3)})`
      ctx.beginPath()
      ctx.arc(m.x, m.y, m.r * 1.05, 0, Math.PI * 2)
      ctx.fill()

      // 划出画面 ⇒ 回收，隔一会儿再从右上重来
      if (m.x < -m.len * 1.2 || m.y > h + m.len * 1.2) {
        Object.assign(m, makeMeteor(false))
      }
    }

    pRaf = requestAnimationFrame(draw)
  }

  resize()
  pRaf = requestAnimationFrame(draw)

  const ro = new ResizeObserver(() => resize())
  ro.observe(cv)

  function onVis() {
    if (document.hidden) {
      cancelAnimationFrame(pRaf)
      pRaf = 0
    } else if (!pRaf) {
      pRaf = requestAnimationFrame(draw)
    }
  }
  document.addEventListener('visibilitychange', onVis)

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cancelAnimationFrame(pRaf)
    pRaf = 0
  }

  pStop = () => {
    ro.disconnect()
    document.removeEventListener('visibilitychange', onVis)
  }
}

onMounted(() => startParticles())
onBeforeUnmount(() => {
  if (pRaf) cancelAnimationFrame(pRaf)
  if (pStop) pStop()
})

onMounted(async () => {
  // 已登录则直接进入目标页，无需重复登录
  try {
    const me = await getMe()
    if (me.loggedIn) {
      router.replace(route.query.redirect || '/')
      return
    }
  } catch {
    /* 未登录，留在本页 */
  }
  // 切换账号过来：用户名已预填并**全选**、光标落在用户名框 ——
  // 直接敲就是换人（覆盖掉预填的），不敲就 Tab 到密码给同一个人重登，两种都顺手
  if (switching) {
    nextTick(() => {
      userRef.value?.focus()
      userRef.value?.select()
    })
  }
})

async function onSubmit() {
  if (loading.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }

  if (captcha.enabled && !String(form.captcha || '').trim()) {
    ElMessage.warning('请输入验证码')
    return
  }

  loading.value = true
  // 每次尝试都重新以服务端返回为准（服务端才是限流的唯一权威）
  lockedUntil.value = 0
  try {
    // 记住登录状态的偏好存下来，下次打开登录页自动勾选
    try {
      localStorage.setItem(REMEMBER_KEY, form.remember ? '1' : '0')
    } catch {
      /* 隐私模式忽略 */
    }

    const r = await login(form.username, form.password, form.remember, captcha.enabled ? { token: captcha.token, answer: form.captcha } : null)
    if (!r.token) {
      // 后端未启用登录保护
      clearAuthToken()
      router.replace(route.query.redirect || '/')
      return
    }
    setAuthToken(r.token)
    // 记下这次用的用户名，下次「切换账号」时预填
    saveLastUser(form.username.trim())
    // 并存一份令牌到「本机账号」列表，供顶栏一键切换（只存令牌，不存密码）
    saveAccount({ username: r.username || form.username.trim(), role: r.role, token: r.token })
    ElMessage.success(
      form.remember ? `登录成功，${REMEMBER_DAYS} 天内免登录` : '登录成功'
    )
    // 成员账号直接进「我的业绩」，管理员进首页
    const role = r.role || ''
    const target = role === 'member' ? '/my-performance' : (route.query.redirect || '/')
    router.replace(target)
  } catch (err) {
    const data = err?.response?.data
    const status = err?.response?.status

    // 验证码不对 / 过期：换一题让用户重填
    if (data?.code === 'CAPTCHA_INVALID') {
      ElMessage.error(data?.error || '验证码不对，请重新输入')
      form.captcha = ''
      reloadCaptcha()
      return
    }

    // 被限流：明确告知还要等多久
    if (status === 429 || data?.code === 'TOO_MANY_ATTEMPTS') {
      const mins = Math.max(1, Math.ceil((data?.retryAfterSec || 0) / 60))
      lockedUntil.value = mins
      ElMessage.error(data?.error || `尝试次数过多，请 ${mins} 分钟后再试`)
      return
    }

    // 密码错：提示还剩几次机会，快用完时标红
    if (status === 401) {
      const left = data?.remaining
      if (typeof left === 'number' && left > 0 && left <= 2) {
        ElMessage.error(`用户名或密码不正确，还可以尝试 ${left} 次`)
      } else {
        ElMessage.error('用户名或密码不正确')
      }
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  background: #fff;
}

/* ---------- 左侧品牌区 ---------- */
.brand-panel {
  position: relative;
  flex: 0 0 46%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 56px 48px;
  background: linear-gradient(150deg, #1d2b3a 0%, #2c3e50 48%, #3d566e 100%);
  color: #fff;
}
.brand-inner { position: relative; z-index: 2; width: 100%; max-width: 360px; }

.brand-mark {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  font-weight: 700;
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.22);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
  margin-bottom: 22px;
}
.brand-name { font-size: 30px; font-weight: 700; letter-spacing: 6px; margin: 0 0 10px; color: #fff; }
.brand-tag { font-size: 14px; letter-spacing: 1px; color: rgba(255, 255, 255, 0.68); margin: 0 0 34px; }

.brand-points { list-style: none; margin: 0; padding: 0; }
.brand-points li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13.5px;
  color: rgba(255, 255, 255, 0.8);
  padding: 7px 0;
}
.brand-points li i {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: #7fb3d5;
  transform: rotate(45deg);
  box-shadow: 0 0 8px rgba(127, 179, 213, 0.8);
  flex: 0 0 auto;
}

.brand-foot {
  margin-top: 40px;
  font-size: 12px;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.38);
}

/* 流星画布：铺满品牌区，压在柔光之上、文字之下 */
.brand-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  pointer-events: none;
}

/* 纯 CSS 装饰：两团柔光 + 缓慢漂移（不引任何依赖） */
.orb { position: absolute; z-index: 0; border-radius: 50%; filter: blur(60px); pointer-events: none; }
.orb-a {
  width: 360px; height: 360px; right: -110px; top: -90px;
  background: radial-gradient(circle, rgba(93, 173, 226, 0.55), transparent 70%);
  animation: floatA 14s ease-in-out infinite;
}
.orb-b {
  width: 300px; height: 300px; left: -80px; bottom: -90px;
  background: radial-gradient(circle, rgba(38, 198, 218, 0.35), transparent 70%);
  animation: floatB 18s ease-in-out infinite;
}
@keyframes floatA {
  0%, 100% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(-18px, 22px, 0); }
}
@keyframes floatB {
  0%, 100% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(16px, -18px, 0); }
}

/* ---------- 右侧表单区 ---------- */
.form-panel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  background: #fff;
}
.login-card { width: 100%; max-width: 380px; }

.form-head { margin-bottom: 22px; }
.form-title { font-size: 24px; font-weight: 700; color: #2c3e50; margin: 0 0 6px; letter-spacing: 1px; }
.form-sub { font-size: 13px; color: #909399; margin: 0; }

/* 窄屏时才出现的品牌头 */
.brand-mobile { display: none; text-align: center; margin-bottom: 24px; }
.brand-mobile .brand-mark {
  width: 54px; height: 54px; font-size: 26px;
  margin: 0 auto 12px;
  background: #2c3e50; border: none; color: #fff;
}
.brand-mobile .brand-name { font-size: 20px; letter-spacing: 3px; color: #2c3e50; margin: 0 0 4px; }
.brand-mobile .brand-tag { font-size: 12px; color: #909399; margin: 0; }

.submit { width: 100%; margin-top: 4px; letter-spacing: 4px; }

/* 验证码：左边输入、右边题面（点一下换一题） */
.captcha-row { display: flex; gap: 10px; width: 100%; }
.captcha-row .el-input { flex: 1; }
.captcha-q {
  flex: 0 0 auto;
  min-width: 116px;
  height: 40px;
  padding: 0 14px;
  border: 1px dashed #c0c4cc;
  border-radius: 8px;
  background: #f7f9fb;
  color: #2c3e50;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 1px;
  cursor: pointer;
  user-select: none;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  transition: border-color 0.15s, background 0.15s;
}
.captcha-q:hover { border-color: #7fb3d5; background: #eef4f9; }

.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -6px 0 18px;
}

.remember-hint { font-size: 12px; color: #c0c4cc; }

.lock-tip { margin-bottom: 14px; }
.lock-tip :deep(.el-alert__content) { font-size: 12px; line-height: 1.6; }

/* 从顶栏「切换账号」过来时的提示 */
.switch-tip { margin-bottom: 18px; }
.switch-tip :deep(.el-alert__content) { font-size: 13px; line-height: 1.6; }

:deep(.el-checkbox__label) { font-size: 13px; }

.tip {
  color: #c0c4cc;
  font-size: 12px;
  text-align: center;
  margin: 22px 0 0;
  line-height: 1.6;
}
.tip code { background: #f5f7fa; padding: 1px 5px; border-radius: 3px; color: #909399; }

:deep(.el-form-item__label) { font-weight: 500; }

/* ---------- 窄屏：收起品牌区，表单变成白卡居中 ---------- */
@media (max-width: 900px) {
  .login-wrap { background: linear-gradient(150deg, #1d2b3a 0%, #2c3e50 48%, #3d566e 100%); }
  .brand-panel { display: none; }
  .form-panel { background: transparent; }
  .login-card {
    background: #fff;
    border-radius: 14px;
    padding: 34px 26px 26px;
    box-shadow: 0 16px 50px rgba(0, 0, 0, 0.28);
  }
  .brand-mobile { display: block; }
  .form-head { text-align: center; }
}

/* 尊重系统「减少动态效果」设置 */
@media (prefers-reduced-motion: reduce) {
  .orb-a, .orb-b { animation: none; }
}
</style>
