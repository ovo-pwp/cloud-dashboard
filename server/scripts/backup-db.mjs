/**
 * 手动备份数据库。
 *
 *   node server/scripts/backup-db.mjs           # 备份（今天已有则跳过）
 *   node server/scripts/backup-db.mjs --force   # 强制重新备份
 *
 * 定时备份由 server/scheduler.js 每天自动调用一次，不需要手动跑；
 * 这个脚本是给排查问题 / 需要立刻备份时用的。
 */
import 'dotenv/config'
import { runBackup, listBackups, BACKUP_DIR } from '../services/dbBackup.js'

const force = process.argv.includes('--force')
const r = await runBackup({ force })

if (r.skipped) {
  console.log(`[backup] 今天已备份过，跳过：${r.file}`)
} else if (r.error) {
  console.error(`[backup] ❌ 失败：${r.error}`)
  process.exitCode = 1
} else {
  console.log(`[backup] ✅ ${r.file}（${(r.bytes / 1024 / 1024).toFixed(2)} MB）`)
  if (r.pruned?.length) console.log(`[backup] 已清理旧备份：${r.pruned.join(', ')}`)
}

const all = listBackups()
console.log(`[backup] 目录 ${BACKUP_DIR}，现有 ${all.length} 份：`)
all.forEach((f) => console.log(`   ${f.name}  ${(f.bytes / 1024 / 1024).toFixed(2)} MB`))
