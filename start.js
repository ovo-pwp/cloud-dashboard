#!/usr/bin/env node
/**
 * 一键启动 cloud-dashboard
 *
 *   node start.js          启动前后端（开发模式）
 *   node start.js --check  只做环境体检，不启动
 *
 * 会依次检查：PostgreSQL 服务 → 数据库连通 → 数据是否已导入 → 依赖是否装好，
 * 全部通过后再并行拉起前端 + 后端。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'
const CHECK_ONLY = process.argv.includes('--check')

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
}
const ok = (m) => console.log(`  ${C.green}✔${C.reset} ${m}`)
const bad = (m) => console.log(`  ${C.red}✘${C.reset} ${m}`)
const warn = (m) => console.log(`  ${C.yellow}!${C.reset} ${m}`)
const info = (m) => console.log(`  ${C.dim}${m}${C.reset}`)

// ------------------------------------------------------------
// 检查 1：依赖
// ------------------------------------------------------------
function checkDeps() {
  if (!existsSync(path.join(__dirname, 'node_modules'))) {
    bad('未安装依赖，请先执行：npm install')
    return false
  }
  ok('依赖已安装')
  return true
}

// ------------------------------------------------------------
// 检查 2：.env
// ------------------------------------------------------------
async function checkEnv() {
  const envPath = path.join(__dirname, '.env')
  if (!existsSync(envPath)) {
    warn('.env 不存在，将使用默认连接串 postgresql://postgres:postgres@localhost:5432/cloud_dashboard')
    return true
  }
  ok('.env 已配置')
  return true
}

// ------------------------------------------------------------
// 检查 3：数据库连通 + 数据是否导入
// ------------------------------------------------------------
async function checkDb() {
  let pool
  try {
    const { pool: p } = await import('./server/db/pool.js')
    pool = p
    const r = await pool.query('SELECT version() AS v')
    const ver = String(r.rows[0].v).split(' ').slice(0, 2).join(' ')
    ok(`数据库连通 (${ver})`)

    const b = await pool.query(`
      SELECT biz_type, snapshot_date::text AS d, row_count, total_amount
        FROM import_batch
       ORDER BY biz_type, snapshot_date DESC
    `)
    if (b.rowCount === 0) {
      warn('数据库里还没有数据，请先导入：')
      info('npm run db:import:unpaid     "<已开票未回款.xlsx>"')
      info('npm run db:import:uninvoiced "<已发货未开票.xlsx>"')
    } else {
      for (const row of b.rows) {
        const amt = Number(row.total_amount).toLocaleString('zh-CN', { minimumFractionDigits: 2 })
        ok(`${row.biz_type}  快照 ${row.d}  ${row.row_count} 单  ¥${amt}`)
      }
    }
    return true
  } catch (err) {
    const code = err.code || (err.errors || [])[0]?.code
    if (code === 'ECONNREFUSED') {
      bad('无法连接 PostgreSQL（连接被拒绝）')
      info('请确认数据库服务已启动，在 PowerShell 中执行：')
      info('  Start-Service -Name "postgresql-x64-16"')
      info('或检查 .env 里的 DATABASE_URL 是否正确')
    } else if (code === '3D000') {
      bad('数据库 cloud_dashboard 不存在，请先执行：npm run db:init')
    } else if (code === '42P01') {
      bad('数据表不存在，请先执行：npm run db:init')
    } else {
      bad(`数据库检查失败：${err.message}`)
    }
    return false
  } finally {
    if (pool) await pool.end().catch(() => {})
  }
}

// ------------------------------------------------------------
// 启动前后端
// ------------------------------------------------------------
function start() {
  console.log(`\n${C.cyan}正在启动前后端...${C.reset}\n`)
  const npm = isWin ? 'npm.cmd' : 'npm'
  const child = spawn(npm, ['run', 'dev'], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: isWin,
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { child.kill() } catch {} })
  }
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
console.log(`\n${C.cyan}cloud-dashboard 启动检查${C.reset}`)
console.log(`${C.dim}${'─'.repeat(52)}${C.reset}`)

if (!checkDeps()) process.exit(1)
await checkEnv()
const dbOk = await checkDb()

console.log(`${C.dim}${'─'.repeat(52)}${C.reset}`)

if (!dbOk) {
  console.log(`\n${C.red}环境检查未通过，已中止启动。${C.reset}\n`)
  process.exit(1)
}

if (CHECK_ONLY) {
  console.log(`\n${C.green}环境检查全部通过。${C.reset}\n`)
  process.exit(0)
}

start()
