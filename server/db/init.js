/**
 * 数据库初始化脚本
 * 用法：npm run db:init
 *
 * 只执行建表（schema.sql）。
 * 数据导入请用：npm run db:import "<xlsx路径>" [快照日期]
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { Pool } from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/cloud_dashboard',
})

async function main() {
  console.log('目标数据库:', process.env.DATABASE_URL ? '（来自 DATABASE_URL）' : 'cloud_dashboard')

  try {
    await pool.query('SELECT 1')
    console.log('✔ 数据库连接成功')
  } catch (err) {
    console.error('\n✖ 无法连接数据库:', err.message)
    console.error('\n请检查：')
    console.error('  1. PostgreSQL 服务是否已启动')
    console.error('  2. 数据库 cloud_dashboard 是否已创建')
    console.error('     CREATE DATABASE cloud_dashboard;')
    console.error('  3. .env 中的 DATABASE_URL 是否正确\n')
    process.exit(1)
  }

  const schemaPath = join(__dirname, 'schema.sql')
  const sql = readFileSync(schemaPath, 'utf8')

  // 建表前先看现有数据量，避免无提示清空
  let existing = []
  try {
    const r = await pool.query(
      `SELECT biz_type, count(*) AS cnt FROM receivable_detail GROUP BY biz_type ORDER BY 1`
    )
    existing = r.rows
  } catch {
    /* 表还不存在，忽略 */
  }

  if (existing.length) {
    console.warn('\n⚠  警告：schema.sql 会 DROP 并重建以下表，其中数据将被清空：')
    for (const row of existing) {
      console.warn(`     receivable_detail [${row.biz_type}]  ${row.cnt} 条`)
    }
    console.warn('   若只想更新数据，请改用：node sync.js --import')
    console.warn('   5 秒后继续执行（Ctrl+C 可中止）...\n')
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  console.log(`\n▶ 执行建表 schema.sql`)

  const client = await pool.connect()
  try {
    await client.query(sql)
    console.log('✔ 建表成功（表：import_batch / receivable_detail / customer_platform_unpaid，6 个视图）')
  } finally {
    client.release()
  }

  console.log('\n下一步：导入数据')
  console.log('  npm run db:import "<xlsx路径>" [快照日期YYYY-MM-DD]\n')

  await pool.end()
}

main().catch(async (err) => {
  console.error('\n✖ 初始化失败:', err.message)
  await pool.end()
  process.exit(1)
})
