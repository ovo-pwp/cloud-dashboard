/**
 * 一次性迁移：仅创建 customer_platform_unpaid 表（不 DROP 任何现有数据）
 * 从 schema.sql 中提取该表部分执行，保证 DDL 单一来源。
 * 用法：node server/db/migrate-customer-platform.js
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

const MARKER = '-- 客户平台未回款（订单级明细，独立数据源）'

async function main() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
  const idx = sql.indexOf(MARKER)
  if (idx === -1) {
    throw new Error('schema.sql 中未找到客户平台未回款表定义')
  }
  const ddl = sql.slice(idx)

  const client = await pool.connect()
  try {
    await client.query(ddl)
    console.log('✔ customer_platform_unpaid 表已创建（如已存在则跳过）')
    const { rows } = await client.query('SELECT COUNT(*) AS cnt FROM customer_platform_unpaid')
    console.log(`  当前行数: ${rows[0].cnt}`)
  } finally {
    client.release()
  }
  await pool.end()
}

main().catch(async (err) => {
  console.error('✖ 迁移失败:', err.message)
  await pool.end()
  process.exit(1)
})