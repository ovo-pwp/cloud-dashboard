/**
 * 一次性回填：`customer_platform_unpaid.city`（客户平台线的「地区」列）
 * （2026-10-19，使用者要求「客户未回款到平台也一样」加地区列）
 *
 * 为什么需要这个脚本（和 normalize-city.mjs 同一个理由）
 *   解析逻辑已经加进 `services/importer.js`，但那是**下一次成功入库**才生效；
 *   而客户平台线有「重复批跳过」保护 —— 源表《客户未回款》按周出数，
 *   本次抓下来与 2026-10-15 那批「行数 + 金额 + 订单日期范围」逐项一致，
 *   于是被判为「源表未更新」直接不写库（这本身是对的，否则环比恒为 0）。
 *   结果就是：city 列加了好几天，历史 270 行仍然是空的。
 *   所以先把存量按同一套规则回填一遍，不等源表更新。
 *
 * 规则一致性
 *   本脚本 import 的就是 importer.js 里那个 `parsePlatformCustomerCity`（同一个函数），
 *   不存在「回填和后续导入口径不一致」。
 *
 * 安全说明
 *   - 只 UPDATE `city` 一列，不碰金额 / 批次 / 账龄；批次合计不受影响。
 *   - 先 SELECT 出全部去重客户名算好映射，逐条打印，默认只预演。
 *
 * 用法
 *   node server/scripts/backfill-platform-city.mjs          # 预演（只打印，不写库）
 *   node server/scripts/backfill-platform-city.mjs --apply  # 真正执行
 */
import fs from 'node:fs'
import { Client } from 'pg'
import { parsePlatformCustomerCity } from '../services/importer.js'

// .env 在项目根（本文件在 server/scripts/ 下）
const ENV_PATH = new URL('../../.env', import.meta.url)
const env = fs.readFileSync(ENV_PATH, 'utf8')
const g = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'))
  return m ? m[1].trim() : ''
}

const APPLY = process.argv.includes('--apply')

const client = new Client({
  host: g('PGHOST') || 'localhost',
  port: Number(g('PGPORT') || 5432),
  user: g('PGUSER') || 'postgres',
  password: g('PGPASSWORD'),
  database: g('PGDATABASE') || 'cloud_dashboard',
})

await client.connect()

const { rows } = await client.query(
  `SELECT COALESCE(customer_name, '') AS name,
          COUNT(*)::int                        AS n,
          COUNT(*) FILTER (WHERE city IS NOT NULL)::int AS "hasCity"
     FROM customer_platform_unpaid
    GROUP BY 1
    ORDER BY n DESC`
)

console.log(`客户平台表共 ${rows.length} 个唯一客户名\n`)
console.log('客户名'.padEnd(52), '行数'.padStart(6), '已有地区'.padStart(8), ' → 解析结果')
console.log('-'.repeat(100))

let totalRows = 0
let changed = 0
const updates = []

for (const r of rows) {
  const city = parsePlatformCustomerCity(r.name)
  totalRows += r.n
  const diff = (r.hasCity || 0) !== r.n
  if (diff) changed += r.n - (r.hasCity || 0)
  console.log(
    (r.name || '(空)').slice(0, 50).padEnd(52),
    String(r.n).padStart(6),
    String(r.hasCity).padStart(8),
    ' → ' + (city || '(解析不到)'),
    diff ? '' : '  [已一致]'
  )
  if (diff && city) updates.push([city, r.name])
}

console.log('-'.repeat(100))
console.log(`总行数 ${totalRows}，需回填 ${changed} 行，涉及 ${updates.length} 个客户名`)

if (!APPLY) {
  console.log('\n预演模式，未写库。确认无误后加 --apply 执行。')
  await client.end()
  process.exit(0)
}

let touched = 0
for (const [city, name] of updates) {
  const res = await client.query(
    `UPDATE customer_platform_unpaid SET city = $1
      WHERE COALESCE(customer_name, '') = $2 AND city IS DISTINCT FROM $1`,
    [city, name]
  )
  touched += res.rowCount
}

const after = await client.query(
  `SELECT COUNT(*)::int AS "total", COUNT(city)::int AS "withCity" FROM customer_platform_unpaid`
)
console.log(`\n已写入 ${touched} 行`)
console.log(`after: 总 ${after.rows[0].total} 行，其中 ${after.rows[0].withCity} 行有地区`)

await client.end()