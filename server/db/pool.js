/**
 * 数据库连接池与查询封装
 */
import { Pool } from 'pg'

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/cloud_dashboard',
  max: 10,
  idleTimeoutMillis: 30000,
})

pool.on('error', (err) => {
  console.error('[db] 空闲连接异常:', err.message)
})

/** 统一封装查询，自动记录慢查询与错误 */
export async function query(sql, params = []) {
  const started = Date.now()
  try {
    const result = await pool.query(sql, params)
    const cost = Date.now() - started
    if (cost > 500) console.warn(`[db] 慢查询 ${cost}ms: ${sql.slice(0, 80)}...`)
    return result
  } catch (err) {
    console.error('[db] 查询失败:', err.message)
    console.error('[db] SQL:', sql)
    console.error('[db] 参数:', params)
    throw err
  }
}

/** 统一的日期参数校验：非法则返回 null */
export function normalizeDate(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return value
}
