/**
 * 增量加列：明细的「人工提醒」
 *
 * 为什么是单独脚本、不走 schema.sql：
 *   schema.sql 会 DROP 重建业务表，把真实数据清掉。老库只能靠这种幂等脚本补列。
 *
 * 为什么另开一个字段而不是复用 data_warning：
 *   data_warning 是**系统自动检测**的数据质量提示（账龄分档与总额不符），
 *   是「报告」；人工提醒是**人写的**（如「客户已承诺月底付款」），是「记录」。
 *   两者混写在一个字段里，同步一次就会被覆盖掉 —— 分开存，互不干扰。
 *
 *   node server/db/migrate-detail-reminder.js
 */
import 'dotenv/config'
import { pool } from './pool.js'

const COLUMN = 'manual_reminder'

const { rows: before } = await pool.query(
  `SELECT count(*) :: int AS c
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'receivable_detail'
      AND column_name  = $1`,
  [COLUMN]
)
const existed = before[0].c > 0

await pool.query(`ALTER TABLE receivable_detail ADD COLUMN IF NOT EXISTS ${COLUMN} TEXT`)

await pool.query(
  `COMMENT ON COLUMN receivable_detail.${COLUMN} IS '人工提醒（手填，如催款进展）；与系统自动的 data_warning 分开，避免同步覆盖'`
)

const { rows: after } = await pool.query(
  `SELECT count(*) :: int AS c
     FROM receivable_detail
    WHERE ${COLUMN} IS NOT NULL`
)

console.log(
  existed
    ? `✔ 列 receivable_detail.${COLUMN} 已存在，未做改动（当前 ${after[0].c} 行有内容）`
    : `✔ 加列成功：receivable_detail.${COLUMN}（当前 ${after[0].c} 行有内容）`
)

await pool.end()
