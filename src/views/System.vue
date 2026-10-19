<template>
  <div class="container" v-loading="loading">
    <PageHeader title="系统管理" sub="数据同步 · Excel 导入 · 用户管理 · 登录日志 · 系统配置" />

    <!-- ============ 数据同步 ============ -->
    <el-card class="block" shadow="never">
      <template #header>
        <div class="card-head">
          <b>数据同步</b>
          <span class="head-sub">从金山文档抓取最新数据 → 导入数据库 → 看板刷新</span>
        </div>
      </template>

      <div class="sync-bar">
        <el-button
          type="primary"
          size="large"
          :loading="syncing"
          :disabled="syncing"
          @click="onSync"
        >
          {{ syncing ? '正在同步…' : '立即同步' }}
        </el-button>

        <div class="sync-meta">
          <template v-if="syncing">
            <el-tag type="warning" effect="plain">{{ stepText }}</el-tag>
            <span class="muted">已用时 {{ elapsedText }}</span>
          </template>
          <template v-else-if="lastResult">
            <el-tag :type="lastTag.type" effect="plain">{{ lastTag.text }}</el-tag>
            <span class="muted">
              {{ lastResult.message }}
              <template v-if="lastResult.finishedAt">
                （{{ fmtTime(lastResult.finishedAt) }}）
              </template>
            </span>
          </template>
          <template v-else>
            <el-tag type="info" effect="plain">尚未同步</el-tag>
            <span class="muted">点击左侧按钮拉取金山文档最新数据</span>
          </template>
        </div>
      </div>

      <p class="tip">
        同步会重新抓取三张源表（已开票未回款 / 已发货未开票 / 客户平台未回款）并覆盖当日快照，
        完成后各页面数据即为最新，无需重启服务。若云端凭证失效，同步会退化为「用本地已有文件入库」。
        <br />
        同步需登录后才能操作，登录账号在 <code>.env</code> 的 <code>LOGIN_USERS</code>
        （多账号）或 <code>LOGIN_USER</code> / <code>LOGIN_PASSWORD</code>（单账号）中配置。
        <br />
        每次同步都会留下一条记录（含结果与日志），存在数据库里，
        <b>重启后端不会丢</b>；同一时刻只允许一个同步任务，重复点击会提示「已有同步任务正在执行」。
      </p>

      <el-collapse v-model="logOpen" class="log-collapse">
        <el-collapse-item name="log">
          <template #title>
            <span class="log-title">同步日志</span>
            <span class="muted log-count">{{ syncLog.length }} 行</span>
          </template>
          <pre ref="logBox" class="log-box">{{ syncLog.join('\n') || '（暂无日志）' }}</pre>
        </el-collapse-item>

        <el-collapse-item name="runs">
          <template #title>
            <span class="log-title">同步历史</span>
            <span class="muted log-count">最近 {{ runs.length }} 次</span>
          </template>
          <el-table v-loading="runsLoading" :data="runs" size="small" empty-text="暂无同步记录">
            <el-table-column label="#" width="60">
              <template #default="{ row }">#{{ row.id }}</template>
            </el-table-column>
            <el-table-column label="触发" width="110">
              <template #default="{ row }">{{ row.triggerLabel || row.trigger }}</template>
            </el-table-column>
            <el-table-column label="开始时间" width="170">
              <template #default="{ row }">{{ fmtTime(row.startedAt) }}</template>
            </el-table-column>
            <el-table-column label="耗时" width="100">
              <template #default="{ row }">{{ fmtDuration(row.elapsedMs) }}</template>
            </el-table-column>
            <el-table-column label="结果" width="110">
              <template #default="{ row }">
                <el-tag :type="runTag(row).type" effect="plain" size="small">
                  {{ runTag(row).text }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="240" show-overflow-tooltip>
              <template #default="{ row }">{{ row.message || '—' }}</template>
            </el-table-column>
            <el-table-column label="日志" width="80">
              <template #default="{ row }">
                <span class="muted">{{ row.logLines }} 行</span>
              </template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </el-card>

    <!-- ============ 登录记录 ============ -->
    <el-card class="block" shadow="never">
      <template #header>
        <div class="card-head">
          <b>登录记录</b>
          <span class="head-sub">谁在什么时候、从哪个 IP 登录了平台</span>
          <div class="head-right">
            <el-tag type="success" effect="plain">累计成功 {{ logStats.okTotal }}</el-tag>
            <el-tag type="danger" effect="plain">失败尝试 {{ logStats.failTotal }}</el-tag>
            <el-tag type="info" effect="plain">今日成功 {{ logStats.okToday }}</el-tag>
          </div>
        </div>
      </template>

      <div class="filter-bar">
        <el-input
          v-model="logQuery.username"
          placeholder="按账号筛选"
          clearable
          style="width: 170px"
          @keyup.enter="loadLog(1)"
          @clear="loadLog(1)"
        />
        <el-select
          v-model="logQuery.success"
          placeholder="结果"
          clearable
          style="width: 130px"
          @change="loadLog(1)"
        >
          <el-option label="全部结果" value="" />
          <el-option label="仅成功" value="1" />
          <el-option label="仅失败" value="0" />
        </el-select>
        <el-date-picker
          v-model="logQuery.range"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="YYYY-MM-DD"
          style="width: 250px"
          @change="loadLog(1)"
        />
        <el-button type="primary" :loading="logLoading" @click="loadLog(1)">查询</el-button>
        <el-button :disabled="logLoading" @click="resetLog">重置</el-button>
        <span class="muted">已配置账号：{{ accountsText || '（未配置）' }}</span>
      </div>

      <p class="tip">
        账号分两档，在 <code>.env</code> 的 <code>LOGIN_USERS</code> 里以
        <code>用户名=密码:角色</code> 配置（不写
        <code>:角色</code> 即管理员）：
        <b>管理员</b>（<code>admin</code>）能用全部功能；
        <b>成员</b>（<code>member</code>）能看看板、能导出 Excel、能改明细的进度反馈，
        但不能同步、也进不了本页。
        改角色后重启服务立即生效，不必等旧令牌过期。
      </p>

      <el-table
        v-loading="logLoading"
        :data="logRows"
        border
        size="small"
        :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
      >
        <el-table-column prop="createdAt" label="时间" width="170" align="center" />
        <el-table-column prop="username" label="账号" min-width="100" />
        <el-table-column label="角色" width="90" align="center">
          <template #default="{ row }">
            <el-tag
              v-if="roleOf(row.username) !== '—'"
              size="small"
              effect="plain"
              :type="roleOf(row.username) === '管理员' ? 'warning' : 'info'"
            >{{ roleOf(row.username) }}</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.success ? 'success' : 'danger'" effect="plain" size="small">
              {{ row.success ? '登录成功' : '登录失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="备注" width="90" align="center">
          <template #default="{ row }">{{ row.reason || '—' }}</template>
        </el-table-column>
        <el-table-column prop="ip" label="IP" width="130" align="center">
          <template #default="{ row }">
            <span :title="row.ip || ''">{{ fmtIp(row.ip) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="方式" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="loginMode(row.userAgent) === '脚本' ? 'info' : 'success'">
              {{ loginMode(row.userAgent) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="userAgent" label="浏览器 / 设备" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ shortUA(row.userAgent) }}</template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          background
          layout="total, sizes, prev, pager, next, jumper"
          :total="logTotal"
          :current-page="logQuery.page"
          :page-size="logQuery.pageSize"
          :page-sizes="[20, 50, 100]"
          @current-change="onPageChange"
          @size-change="onSizeChange"
        />
      </div>
    </el-card>

    <!-- ============ 文件夹监控 ============ -->
    <el-card class="block" shadow="never">
      <template #header><b>数据导入（文件夹监控）</b></template>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="监控开关">
          <el-tag :type="cfg.watcher.enabled ? 'success' : 'info'">
            {{ cfg.watcher.enabled ? '已启用' : '已停用' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="监控目录">{{ cfg.watcher.folder || '未配置' }}</el-descriptions-item>
        <el-descriptions-item label="轮询间隔">
          {{ (cfg.watcher.intervalMs / 1000) }} 秒
        </el-descriptions-item>
      </el-descriptions>
      <p class="tip">
        <template v-if="cfg.watcher.enabled">
          把最新的 Excel（文件名含「未回款」「未开票」或「客户未回款」）放入监控目录，系统会自动识别并入库，覆盖同日快照。
        </template>
        <template v-else>
          文件夹监控当前<strong>已停用</strong>，数据更新请使用上方「立即同步」按钮；若希望放入文件即自动入库，需在
          <code>.env</code> 中把 <code>IMPORT_WATCH_ENABLED</code> 改为 <code>true</code> 并重启服务。
        </template>
      </p>
    </el-card>

    <!-- ============ 数据源快照 ============ -->
    <el-card class="block" shadow="never">
      <template #header>
        <div class="card-head">
          <b>数据源</b>
          <el-button link type="primary" :disabled="syncing" @click="reload">刷新</el-button>
        </div>
      </template>
      <el-table :data="cfg.sources" border :header-cell-style="{ background: '#2c3e50', color: '#fff' }">
        <el-table-column prop="label" label="数据源" min-width="160" />
        <el-table-column prop="snapshotDate" label="日期" width="130" align="center" />
        <el-table-column prop="importedAt" label="导入时间" min-width="170" align="center">
          <template #default="{ row }">
            {{ row.importedAt ? fmtTime(row.importedAt) : '—' }}
          </template>
        </el-table-column>
        <el-table-column prop="rows" label="条数/订单数" width="120" align="center" />
        <el-table-column prop="customerCount" label="客户数" width="100" align="center" />
        <el-table-column prop="salespersonCount" label="业务员/平台数" width="120" align="center" />
        <el-table-column prop="totalAmount" label="金额(元)" min-width="160" align="right">
          <template #default="{ row }">
            <span class="amount">{{ fmt(row.totalAmount) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.totalAmount" type="success" effect="plain">正常</el-tag>
            <el-tag v-else type="info" effect="plain">无数据</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getSystemConfig,
  getSummary,
  getCustomerPlatformSummary,
  startSync,
  getSyncStatus,
  getSyncRuns,
  getLoginLog,
} from '@/api'
import { ROLE_LABEL } from '@/composables/useAuth'
import PageHeader from '@/components/PageHeader.vue'

const loading = ref(false)
const syncing = ref(false)
const syncLog = ref([])
const lastResult = ref(null)
const logOpen = ref([])
const logBox = ref(null)

const cfg = ref({ watcher: { enabled: true, folder: '', intervalMs: 15000 }, sources: [] })

let timer = null
const startedAt = ref(0)
const nowTick = ref(Date.now())

const STEP_MAP = {
  idle: '待机',
  pull: '① 正在抓取金山文档数据…',
  import: '② 正在导入数据库…',
  done: '同步完成',
  error: '同步出错',
  interrupted: '同步被中断',
}
const stepText = computed(() => STEP_MAP[currentStep.value] || currentStep.value)
const currentStep = ref('pull')
const elapsedText = computed(() => {
  if (!startedAt.value) return '0 秒'
  const sec = Math.max(0, Math.floor((nowTick.value - startedAt.value) / 1000))
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
})

/** 「上次同步」状态标签：被重启打断的情况要单独说清楚 */
const lastTag = computed(() => {
  if (lastResult.value?.interrupted) return { type: 'info', text: '上次同步被中断' }
  return lastResult.value?.ok
    ? { type: 'success', text: '上次同步成功' }
    : { type: 'danger', text: '上次同步未完全成功' }
})

function fmt(v) {
  return Number(v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtTime(v) {
  if (!v) return '—'
  return new Date(v).toLocaleString('zh-CN', { hour12: false })
}

// ------------------------------------------------------------
// 登录记录
// ------------------------------------------------------------
const logLoading = ref(false)
const logRows = ref([])
const logTotal = ref(0)
const logAccounts = ref([])

/**
 * 已配置账号的展示文本：`4111（管理员）、3905（成员）`
 * 接口返回的是 [{ username, role }]，这里只做排版。
 * 角色中文名统一取 ROLE_LABEL，别在这里再写一份映射（否则改名时两边会不一致）
 */
const accountsText = computed(() => {
  const list = logAccounts.value || []
  if (!list.length) return ''
  return list
    .map((a) => (a && typeof a === 'object' ? `${a.username}（${ROLE_LABEL[a.role] || a.role}）` : a))
    .join('、')
})
const logStats = ref({ okTotal: 0, failTotal: 0, okToday: 0 })

const logQuery = ref({
  username: '',
  success: '',
  range: null,
  page: 1,
  pageSize: 20,
})

/** UA 太长，截短展示（完整内容在 title 里） */
function shortUA(ua) {
  if (!ua) return '—'
  const s = String(ua)
  // 提取「浏览器 版本」这类关键片段，取不到就截断
  const m = s.match(/(Edge|Edg|Chrome|Firefox|Safari|MSIE|Trident)[\/ ]?([\d.]+)?/i)
  if (m) {
    const name = /edg/i.test(m[1]) ? 'Edge' : m[1]
    return `${name}${m[2] ? ' ' + m[2].split('.')[0] : ''}`
  }
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

/** IP 友好化：本机回环 → 「本机」；IPv4-mapped（::ffff:1.2.3.4）去掉前缀 */
function fmtIp(ip) {
  const s = String(ip || '').trim()
  if (!s) return '—'
  if (s === '::1' || s === '127.0.0.1' || s === '::ffff:127.0.0.1') return '本机'
  const m = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  return m ? m[1] : s
}

/** 登录方式：UA 里带脚本/命令行特征 → 「脚本」，其余 → 「浏览器」 */
function loginMode(ua) {
  const s = String(ua || '')
  if (!s) return '—'
  return /node|python|curl|wget|axios|postman|okhttp|go-http|java\//i.test(s) ? '脚本' : '浏览器'
}

/** 账号 → 当前配置的角色（已从 LOGIN_USERS 删掉的账号显示 —；这是「当前」角色，不追溯历史） */
function roleOf(username) {
  const hit = (logAccounts.value || []).find((a) => a && a.username === username)
  return hit ? ROLE_LABEL[hit.role] || hit.role : '—'
}

async function loadLog(page) {
  if (page) logQuery.value.page = page
  logLoading.value = true
  try {
    const [startDate, endDate] = Array.isArray(logQuery.value.range) ? logQuery.value.range : ['', '']
    const r = await getLoginLog({
      username: logQuery.value.username || undefined,
      success: logQuery.value.success === '' ? undefined : logQuery.value.success,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      page: logQuery.value.page,
      pageSize: logQuery.value.pageSize,
    })
    logRows.value = r.rows || []
    logTotal.value = r.total || 0
    logAccounts.value = r.accounts || []
    logStats.value = {
      okTotal: r.stats?.ok_total ?? 0,
      failTotal: r.stats?.fail_total ?? 0,
      okToday: r.stats?.ok_today ?? 0,
    }
  } catch (err) {
    console.error('[登录记录] 加载失败:', err)
  } finally {
    logLoading.value = false
  }
}

function onPageChange(p) {
  logQuery.value.page = p
  loadLog()
}

function onSizeChange(s) {
  logQuery.value.pageSize = s
  logQuery.value.page = 1
  loadLog()
}

function resetLog() {
  logQuery.value.username = ''
  logQuery.value.success = ''
  logQuery.value.range = null
  logQuery.value.page = 1
  loadLog()
}

/** 为各数据源补充客户数、业务员/平台数 */
async function enrichSources() {
  const [bu, shipped, cp] = await Promise.all([
    getSummary('billed_unpaid').catch(() => ({})),
    getSummary('shipped_uninvoiced').catch(() => ({})),
    getCustomerPlatformSummary().catch(() => ({})),
  ])
  cfg.value.sources.forEach((s) => {
    if (s.key === 'customer_platform_unpaid') {
      s.customerCount = cp.customerCount ?? '-'
      s.salespersonCount = cp.platformCount ?? '-'
    } else {
      const e = s.key === 'billed_unpaid' ? bu : shipped
      s.customerCount = e.customerCount ?? '-'
      s.salespersonCount = e.salespersonCount ?? '-'
    }
  })
}

/** 加载系统配置 + 快照 */
async function reload() {
  loading.value = true
  try {
    cfg.value = await getSystemConfig()
    await enrichSources()
  } catch (err) {
    console.error('[系统管理] 加载失败:', err)
  } finally {
    loading.value = false
  }
}

/** 同步日志区自动滚到底部 */
watch(
  () => syncLog.value.length,
  async () => {
    if (!logOpen.value.includes('log')) return
    await nextTick()
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  }
)

// ------------------------------------------------------------
// 同步历史（持久化在数据库，重启后仍能看到）
// ------------------------------------------------------------
const runs = ref([])
const runsLoading = ref(false)

async function loadRuns() {
  runsLoading.value = true
  try {
    const { runs: list } = await getSyncRuns(20)
    runs.value = Array.isArray(list) ? list : []
  } catch {
    /* 历史拿不到不影响主流程 */
  } finally {
    runsLoading.value = false
  }
}

/** 历史表里的状态标签 */
function runTag(r) {
  if (r.active) return { type: 'warning', text: '进行中' }
  if (r.step === 'interrupted') return { type: 'info', text: '被中断' }
  if (r.ok === true) return { type: 'success', text: '成功' }
  if (r.ok === false) return { type: 'danger', text: '未完全成功' }
  return { type: 'info', text: r.step || '—' }
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—'
  const sec = Math.max(0, Math.round(ms / 1000))
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
}

/** 轮询一次状态 */
async function poll() {
  try {
    const st = await getSyncStatus()
    if (Array.isArray(st.log)) syncLog.value = st.log
    currentStep.value = st.step || 'pull'
    const wasRunning = syncing.value
    syncing.value = !!st.running

    if (wasRunning && !st.running) {
      // 刚跑完
      lastResult.value = {
        ok: st.ok,
        message: st.message,
        finishedAt: st.finishedAt,
        interrupted: st.interrupted,
      }
      stopPolling()
      if (st.ok) {
        ElMessage.success('同步完成，看板已是最新数据')
      } else {
        ElMessage.warning(st.message || '同步未完全成功，请查看日志')
      }
      // 用本次结果直接刷新表格，避免再多一轮请求
      if (Array.isArray(st.sources) && st.sources.length) {
        cfg.value.sources = st.sources
        await enrichSources()
      } else {
        await reload()
      }
      loadRuns()
    }
  } catch {
    /* 轮询失败不打扰用户，下个周期再试 */
  }
}

function startPolling() {
  stopPolling()
  nowTick.value = Date.now()
  timer = setInterval(() => {
    nowTick.value = Date.now()
    poll()
  }, 1000)
}

function stopPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 点击「立即同步」 */
async function onSync() {
  syncing.value = true
  currentStep.value = 'pull'
  startedAt.value = Date.now()
  nowTick.value = Date.now()
  syncLog.value = []
  lastResult.value = null
  logOpen.value = ['log']

  try {
    await startSync()
    ElMessage.info('已开始同步，请稍候…')
    startPolling()
    loadRuns()
  } catch (err) {
    syncing.value = false
    const status = err?.response?.status
    // 409 = 已有任务在跑：接上现有进度而不是报错
    if (status === 409) {
      ElMessage.warning('已有同步任务正在执行，正在接入进度…')
      startPolling()
      loadRuns()
      return
    }
    // 401 由全局拦截器处理（跳登录页），这里不重复提示
    if (status !== 401) {
      ElMessage.error(err?.response?.data?.error || '启动同步失败')
    }
  }
}

onMounted(async () => {
  await reload()
  loadLog(1)
  loadRuns()
  // 进入页面时若后端正在跑同步（比如另一个标签页触发的），直接接上进度
  try {
    const st = await getSyncStatus()
    if (st.running) {
      syncing.value = true
      currentStep.value = st.step
      startedAt.value = st.startedAt ? new Date(st.startedAt).getTime() : Date.now()
      logOpen.value = ['log']
      startPolling()
    } else if (st.startedAt) {
      lastResult.value = {
        ok: st.ok,
        message: st.message,
        finishedAt: st.finishedAt,
        interrupted: st.interrupted,
      }
      // 上次是被重启打断的，直接把日志展开，省得用户以为「什么都没发生」
      if (st.interrupted) {
        logOpen.value = ['log']
        if (Array.isArray(st.log) && st.log.length) syncLog.value = st.log
      }
    }
  } catch {
    /* 忽略 */
  }
})

onUnmounted(stopPolling)
</script>

<style scoped>
.container { padding: 20px; background: #f0f2f5; }
/* 头部已交给 PageHeader 组件统一 */
.block { margin-bottom: 16px; background: #fff; }
.tip { color: #909399; font-size: 13px; margin: 12px 0 0; line-height: 1.7; }
.tip code { background: #f5f7fa; padding: 1px 5px; border-radius: 3px; color: #606266; }
.amount { font-weight: 600; color: #f56c6c; }

.card-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.head-sub { color: #909399; font-size: 13px; font-weight: 400; }

.sync-bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.sync-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.muted { color: #909399; font-size: 13px; }

.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.pager { display: flex; justify-content: flex-end; margin-top: 14px; }
.head-right { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }

.pwd-tip { color: #909399; font-size: 13px; margin: 0 0 12px; line-height: 1.6; }
.pwd-err { color: #f56c6c; font-size: 13px; margin: 8px 0 0; }
.warn-text { color: #e6a23c; font-weight: 600; }

.log-collapse { margin-top: 14px; }
.log-title { font-size: 13px; color: #606266; }
.log-count { margin-left: 8px; }
.log-box {
  margin: 0;
  max-height: 300px;
  overflow: auto;
  background: #1e1e1e;
  color: #d4d4d4;
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.65;
  padding: 12px 14px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
}
:deep(.el-collapse-item__header) { font-weight: 400; }
</style>
