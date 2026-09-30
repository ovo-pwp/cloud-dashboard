/**
 * 增量加列：明细的「城市」
 *
 * 来由：2026-09-23 用户在金山文档「未回款」源表加了一列「地址」，值是城市名
 *   （南宁市 / 崇左市 / 玉林市 …，190 行全有值）。这里把它接进看板。
 *
 * 为什么叫 city 而不是 address：
 *   源表列名是「地址」，但取值就是城市，看板上按城市展示与筛选更准确；
 *   映射在 importer.js 里（读第 14 列）。
 *
 * 只有「已开票未回款」(billed_unpaid) 那张源表有这列；
 *   「已发货未开票」(shipped_uninvoiced) 源表还没有，它的行 city 为 NULL。
 *
 * 为什么是单独脚本、不走 schema.sql：
 *   schema.sql 会 DROP 重建业务表，把真实数据清掉。老库只能靠这种幂等脚本补列。
 *
 *   node server/db/migrate-city.js
 */
import 'dotenv/config'
import { pool } from './pool.js'

const COLUMN = 'city'

const { rows: before } = await pool.query(
  `SELECT count(*) :: int AS c
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'receivable_detail'
      AND column_name  = $1`,
  [COLUMN]
)
const existed = before[0].c > 0

await pool.query(`ALTER TABLE receivable_detail ADD COLUMN IF NOT EXISTS ${COLUMN} VARCHAR(50)`)

await pool.query(
  `COMMENT ON COLUMN receivable_detail.${COLUMN} IS '城市（源表「地址」列，仅「已开票未回款」有值）'`
)

const { rows: after } = await pool.query(
  `SELECT count(*) :: int AS c
     FROM receivable_detail
    WHERE ${COLUMN} IS NOT NULL AND ${COLUMN} <> ''`
)

console.log(
  existed
    ? `✔ 列 receivable_detail.${COLUMN} 已存在，未做改动（当前 ${after[0].c} 行有内容）`
    : `✔ 加列成功：receivable_detail.${COLUMN}（当前 ${after[0].c} 行有内容）`
)
console.log('  下一步：重新同步一次数据，才会写入城市值 ——  npm run sync 或页面上的「立即同步」')

await pool.end()
