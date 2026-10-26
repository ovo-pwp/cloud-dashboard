/**
 * 建「部门备注」表（2026-10-26 使用者「建一列备注」——首页矩阵按部门写一句话）
 *
 * 与 detail_note 的区别：
 *   detail_note 按「单据号」存（每张单一条备注）；
 *   dept_note   按「业务线 + 部门」存（每个部门一条备注，跨批次长期保留，不跟日期走）。
 *   为什么不绑日期：备注多是「这个部门这笔大单已开票」这类长期跟进说明，
 *   绑日期后第二天就丢了，反而要重写。
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { Pool } = require('pg')
const fs = require('node:fs')
const path = require('node:path')
const dotenv = require('dotenv')

dotenv.config({ path: path.join(process.cwd(), '.env') })

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'cloud_dashboard',
})

const sql = `
CREATE TABLE IF NOT EXISTS dept_note (
  biz_type   text        NOT NULL,
  department text        NOT NULL,
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (biz_type, department)
);
COMMENT ON TABLE dept_note IS '首页矩阵「部门」行的备注，按 业务线+部门 唯一，跨批次保留';
`

const main = async () => {
  await pool.query(sql)
  const r = await pool.query('SELECT COUNT(*)::int n FROM dept_note')
  console.log('✅ dept_note 已就绪（幂等），现有 ' + r.rows[0].n + ' 条')
  await pool.end()
}

main().catch((e) => {
  console.error('❌ 建表失败:', e.message)
  process.exit(1)
})
