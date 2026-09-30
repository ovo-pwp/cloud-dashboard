/**
 * cloud-dashboard 后端服务入口
 * 只负责：中间件装配、路由挂载、错误处理、启动与优雅关闭
 * 具体接口实现见 server/routes/
 */
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import 'dotenv/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../dist')

import { pool } from './db/pool.js'
import receivableRoutes from './routes/receivable.js'
import { startWatcher } from './watcher.js'
import { startScheduler } from './scheduler.js'
import { requireLogin, isLoginEnabled, listAccounts, ROLE_ADMIN, ROLE_LABEL } from './services/syncAuth.js'
import { checkExposureGuard } from './services/exposureGuard.js'
import { THROTTLE } from './services/loginThrottle.js'
import { initSyncState, getSyncState } from './services/syncRunner.js'

const app = express()

// ------------------------------------------------------------
// 中间件
// ------------------------------------------------------------
app.use(cors())
app.use(express.json())

// ------------------------------------------------------------
// 静态文件服务：放在路由之前，优先匹配静态资源
// ------------------------------------------------------------
const isApiPath = (pathname) => pathname.startsWith('/api')
try {
  // 静态文件服务
  app.use(express.static(distDir, { index: 'index.html' }))
  // SPA fallback：非 /api 请求返回 index.html
  app.use((req, res, next) => {
    if (!isApiPath(req.path)) {
      return res.sendFile(path.resolve(distDir, 'index.html'))
    }
    next()
  })
} catch (_) {
  // dist/ 不存在时跳过（开发环境）
}

// ------------------------------------------------------------
// 路由
// ------------------------------------------------------------
// 登录相关接口必须放在鉴权之前，否则无法登录
// （具体实现在 routes/receivable.js 的 /login、/logout、/me）

// 除放行清单外，整个 /api 都需要登录
const PUBLIC_PATHS = new Set(['/login', '/logout', '/me', '/health'])
app.use('/api', (req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next()
  return requireLogin(req, res, next)
})

app.use('/api', receivableRoutes)

// 404（API 路径 unmatched 才走这里）
app.use('/api', (req, res) => {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.originalUrl}` })
})

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[api] 未捕获错误:', err.message || err, err.code ? `(${err.code})` : '')

  // 数据库连不上时，给一个能直接照着排查的提示
  const isDbDown =
    err.code === 'ECONNREFUSED' ||
    err.code === 'ENOTFOUND' ||
    (err.errors || []).some((e) => e.code === 'ECONNREFUSED')

  if (isDbDown) {
    return res.status(503).json({
      error: '无法连接数据库，请确认 PostgreSQL 已启动且 .env 中 DATABASE_URL 正确',
      code: err.code || 'ECONNREFUSED',
    })
  }

  res.status(500).json({
    error: err.message || '服务器内部错误',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  })
})

// ------------------------------------------------------------
// 启动
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000

// ------------------------------------------------------------
// 启动前安全闸
//
// 鉴权在「未配置登录账号」时是放行的（见 services/syncAuth.js 的 requireLogin）。
// 生产环境漏填 LOGIN_USERS，会让真实经营数据以零认证状态对公网开放，
// 所以这里宁可让它起不来。判定规则见 services/exposureGuard.js
// ------------------------------------------------------------
const guard = checkExposureGuard({
  nodeEnv: process.env.NODE_ENV,
  loginEnabled: isLoginEnabled(),
  allowAnonymous: process.env.ALLOW_ANONYMOUS_ACCESS,
})

if (guard.level === 'fatal') {
  console.error(`\n${'='.repeat(66)}`)
  console.error('  启动已中止（安全闸）')
  console.error('='.repeat(66))
  console.error(guard.message)
  console.error(`${'='.repeat(66)}\n`)
  process.exit(1)
}

if (guard.level === 'warn') {
  console.warn(`\n  [安全提醒] ${guard.message}\n`)
}

// 启动文件夹监控（自动导入），仅非生产环境默认启用，也可用 IMPORT_WATCH_ENABLED 关掉
const watchEnabled = process.env.IMPORT_WATCH_ENABLED !== 'false'
if (watchEnabled) {
  startWatcher(
    process.env.IMPORT_WATCH_FOLDER,
    Number(process.env.IMPORT_WATCH_INTERVAL) || 15000
  )
}

// 恢复上一次同步状态（持久化在 sync_run 表）：
// 记录「上次同步跑到哪、结果如何」；若上次是被重启打断的，标记为中断并回收孤儿进程
const syncBoot = await initSyncState()

// 启动定时轮询调度器：定期从金山文档拉取数据并入库
// （放在 initSyncState 之后，保证第一轮抢锁前状态已恢复）
startScheduler()

const server = app.listen(PORT, async () => {
  console.log(`\n  Server running on http://localhost:${PORT}`)

  // 本机所有非回环 IPv4，方便把地址发给同事
  const { networkInterfaces } = await import('node:os')
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
  if (lan.length) {
    console.log(`  局域网访问: ${lan.map((ip) => `http://${ip}:${PORT}`).join('  ')}`)
  }

  console.log(`  环境: ${process.env.NODE_ENV || 'development'}`)
  const accounts = listAccounts()
  console.log(
    `  登录保护: ${
      accounts.length
        ? `已开启（账号 ${accounts
            .map((a) => `${a.username}·${ROLE_LABEL[a.role] || a.role}`)
            .join('、')}｜普通 ${process.env.LOGIN_TTL_HOURS || 12}h，记住我 ${
            process.env.LOGIN_REMEMBER_TTL_HOURS || 168
          }h）`
        : '未开启（任何人都可访问）'
    }`
  )
  if (accounts.length) {
    const members = accounts.filter((a) => a.role !== ROLE_ADMIN).map((a) => a.username)
    console.log(
      `  账号权限: 管理员 = 全部功能；成员 = 看数据 + 导出 Excel + 改备注 / 人工提醒（同步/系统管理仍限管理员）${
        members.length ? `（当前成员：${members.join('、')}）` : '（当前没有成员账号）'
      }`
    )
    console.log(`    · 改角色只需编辑 .env 的 LOGIN_USERS=用户名=密码:角色，重启即生效（无需等令牌过期）`)
    console.log(
      `  登录限流: 同一 IP ${THROTTLE.windowMinutes} 分钟内失败 ${THROTTLE.maxFails} 次即锁定`
    )
  }

  // 同步状态（持久化在 sync_run 表，重启后仍可见）
  const st = getSyncState({ withLog: false })
  if (!syncBoot.ok) {
    console.log(`  上次同步: 状态读取失败（${syncBoot.error}）`)
  } else if (!st.runId) {
    console.log('  上次同步: 无记录')
  } else if (st.interrupted) {
    console.log(`  上次同步: ⚠ #${st.runId} 被重启打断（${st.finishedAt}），已标记为中断`)
  } else {
    console.log(
      `  上次同步: ${st.ok ? '成功' : '未完全成功'}（#${st.runId} ${
        st.triggerLabel || st.trigger || 'manual'
      }｜${st.finishedAt}）`
    )
  }
  console.log(`\n  接口清单（除 biz-types/trend 外均支持 ?bizType= 参数）:`)
  console.log(`    POST /api/login                   登录（换取令牌，支持 remember）
    GET  /api/me                      当前登录状态
    POST /api/logout                  退出登录
    GET  /api/login-log               登录记录（分页+过滤）
    GET  /api/login-users             已配置的账号列表
    GET  /api/health                   健康检查
    POST /api/sync                     立即同步（抓云端→入库）
    GET  /api/sync/status              同步进度（含滚动日志）
    GET  /api/sync/runs                最近同步记录（持久化，重启不丢）`)
  console.log(`    GET /api/biz-types                可用业务类型及最新快照`)
  console.log(`    GET /api/summary                  顶部汇总`)
  console.log(`    GET /api/aging-by-salesperson     业务员×账龄档（看板主表）`)
  console.log(`    GET /api/aging-summary            账龄分档汇总`)
  console.log(`    GET  /api/detail                   明细查询（分页+筛选+排序）
    GET  /api/export/detail            导出明细 Excel（当前筛选的全部行）`)
  console.log(`    GET /api/by-customer              按客户汇总`)
  console.log(`    GET /api/filters                  筛选选项`)
  console.log(`    GET /api/trend                    每日快照趋势`)
  console.log(`    GET /api/warnings                 数据质量告警`)
  console.log(`    GET /api/customer-platform-unpaid/summary      客户平台未回款·汇总`)
  console.log(`    GET /api/customer-platform-unpaid/breakdown    客户平台未回款·客户+平台`)
  console.log(`    GET /api/customer-platform-unpaid/detail       客户平台未回款·明细`)
  console.log(`    GET /api/export/customer-platform-detail       导出客户平台订单明细 Excel`)
  console.log(
    `\n  仅管理员可用（成员 / 其他角色调用返回 403）:
    POST /api/sync  ·  GET /api/system-config
    GET  /api/login-log  ·  GET /api/login-users  ·  GET /api/sync/status  ·  GET /api/sync/runs

  管理员 + 成员都可用（能看数据 + 导出 Excel + 改备注 / 人工提醒）:
    GET  /api/export/detail  ·  GET /api/export/customer-platform-detail
    PUT  /api/detail/note  ·  PUT /api/detail/reminder`
  )
  console.log(`\n  业务类型: billed_unpaid(已开票未回款) | shipped_uninvoiced(已发货未开票)\n`)
})

// 优雅关闭
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在关闭...`)
    server.close(() => {
      pool.end().then(() => {
        console.log('数据库连接池已释放，退出。')
        process.exit(0)
      })
    })
  })
}

// 端口被占用时给出明确提示，而不是抛出难以理解的栈
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。`)
    console.error(`  可能是已有一个后端实例在运行，先确认：curl http://localhost:${PORT}/api/health`)
    console.error(`  如需终止，在 PowerShell 中执行：Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n`)
    process.exit(1)
  }
  throw err
})

export default app
