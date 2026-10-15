/**
 * 数据库备份（每天一份，保留最近 N 份）
 *
 * 为什么必须要有：
 *   库里的**历史快照**（11 批 × 两条业务线 + 4 期客户平台）是**不可再生的** ——
 *   金山文档源表只有「当前状态」，历史批次重建不出来。
 *   另外明细页支持在线编辑备注（manual_reminder），那部分数据源表里也没有。
 *   所以库一丢，历史趋势就彻底没了。
 *
 * 用法：
 *   node server/scripts/backup-db.mjs            # 手动备份一次（已存在当天文件则跳过）
 *   node server/scripts/backup-db.mjs --force    # 强制重新备份
 *   调度器每天自动调用一次（见 server/scheduler.js 的 tick()）
 *
 * 还原：
 *   "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -d cloud_dashboard -f backups\db_YYYY-MM-DD.sql
 *   （还原前建议先停后端，避免连接占用）
 *
 * 配置（.env，都有默认值）：
 *   DB_BACKUP_DIR    备份目录，默认 <项目>/backups
 *   DB_BACKUP_KEEP   保留份数，默认 14
 *   PG_DUMP_PATH     pg_dump 路径
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

const BACKUP_DIR = process.env.DB_BACKUP_DIR || path.join(ROOT, 'backups')
const KEEP = Math.max(1, Number(process.env.DB_BACKUP_KEEP) || 14)
const PG_DUMP =
  process.env.PG_DUMP_PATH || 'C:/Program Files/PostgreSQL/16/bin/pg_dump.exe'

/** 本地日期串 YYYY-MM-DD（不用 toISOString —— 东八区会退一天） */
export function dayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function parseDbUrl(url) {
  // postgresql://user:pass@host:port/dbname
  const m = String(url).match(/^postgres(?:ql)?:\/\/([^:]+):([^@]*)@([^:/]+):?(\d+)?\/(.+?)(\?.*)?$/)
  if (!m) return null
  return { user: m[1], password: m[2], host: m[3], port: m[4] || '5432', database: m[5] }
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', (e) => resolve({ code: -1, err: e.message }))
    p.on('close', (code) => resolve({ code, err }))
  })
}

/**
 * 执行一次备份。已存在当天文件且 force=false 时直接跳过。
 * @returns {Promise<{skipped?:boolean, file?:string, bytes?:number, error?:string}>}
 */
export async function runBackup({ force = false } = {}) {
  const db = parseDbUrl(process.env.DATABASE_URL || '')
  if (!db) return { error: 'DATABASE_URL 解析失败，跳过备份' }
  if (!fs.existsSync(PG_DUMP)) return { error: `找不到 pg_dump：${PG_DUMP}` }

  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const file = path.join(BACKUP_DIR, `db_${dayStamp()}.sql`)
  if (!force && fs.existsSync(file) && fs.statSync(file).size > 1024) {
    return { skipped: true, file }
  }

  const args = [
    '-h', db.host,
    '-p', String(db.port),
    '-U', db.user,
    '-d', db.database,
    '--no-owner',
    '--no-privileges',
    '-f', file,
  ]
  const { code, err } = await run(PG_DUMP, args, { PGPASSWORD: db.password })

  if (code !== 0) {
    // 失败时删掉半截文件，免得下次被当成「今天已备份过」
    try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch { /* 忽略 */ }
    return { error: `pg_dump 退出码 ${code}: ${err.trim().slice(0, 200)}` }
  }

  const bytes = fs.statSync(file).size
  // 健康检查：dump 里必须有建表语句，否则视为无效
  const head = fs.readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(0, 4000)
  if (!/CREATE TABLE/i.test(head) || bytes < 2048) {
    return { error: `备份文件异常（${bytes} 字节，缺少 CREATE TABLE）` }
  }

  return { file, bytes, pruned: pruneOld() }
}

/** 只保留最近 KEEP 份，删掉更早的 */
function pruneOld() {
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^db_\d{4}-\d{2}-\d{2}\.sql$/.test(f))
      .sort() // 文件名带日期，字典序即时间序
    const removed = []
    while (files.length > KEEP) {
      const f = files.shift()
      fs.unlinkSync(path.join(BACKUP_DIR, f))
      removed.push(f)
    }
    return removed
  } catch {
    return []
  }
}

/** 列出已有备份（给运维 / 网页端看） */
export function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return []
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db_') && f.endsWith('.sql'))
      .sort()
      .map((f) => ({ name: f, bytes: fs.statSync(path.join(BACKUP_DIR, f)).size }))
  } catch {
    return []
  }
}

export { BACKUP_DIR, KEEP }
