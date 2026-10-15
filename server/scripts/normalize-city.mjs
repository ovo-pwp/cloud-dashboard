/**
 * 一次性回填：把 `receivable_detail.city` 从「完整地址」归一化成「只到市」
 * （2026-10-12，使用者要求「城市这里不用这么详细到市就行了」）
 *
 * 为什么需要这个脚本
 *   归一化逻辑已经加进 `services/importer.js`，但那是**下一次导入**才生效；
 *   定时同步是小时级，使用者想立刻看到，所以先把存量按同一套规则回填一遍。
 *   规则与本脚本用的都是 `services/city.js` 里**同一个** `toCityBatch`，
 *   不存在「回填和后续导入口径不一致」的问题。
 *
 * 安全说明
 *   - 只 UPDATE `city` 一列，不碰任何金额 / 批次 / 账龄字段；批次合计不受影响。
 *   - 先 `SELECT` 出全部去重值算好映射，再按「原值 → 新值」批量 UPDATE，逐条打印。
 *   - 打印 before → after，跑完可肉眼核对。
 *
 * 用法
 *   node server/scripts/normalize-city.mjs          # 预演（只打印，不写库）
 *   node server/scripts/normalize-city.mjs --apply  # 真正执行
 */
import fs from 'node:fs'
import { Client } from 'pg'
import { toCityBatch } from '../services/city.js'

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
  `SELECT city, COUNT(*)::int AS n
     FROM receivable_detail
    WHERE city IS NOT NULL AND city <> ''
    GROUP BY city ORDER BY n DESC`
)

const raws = rows.map((r) => r.city)
const outs = toCityBatch(raws)

const changes = []
for (let i = 0; i < raws.length; i++) {
  if (raws[i] !== outs[i]) changes.push({ before: raws[i], after: outs[i], n: rows[i].n })
}

console.log(`共 ${raws.length} 个不同城市值，其中 ${changes.length} 个需要改写：\n`)
for (const ch of changes) console.log(`  ${String(ch.n).padStart(4)}  ${ch.before}  →  ${ch.after}`)

// 改写后合并后的目标分布（便于确认「同一个市被合并到一起」）
const merged = {}
for (let i = 0; i < raws.length; i++) merged[outs[i]] = (merged[outs[i]] || 0) + rows[i].n
console.log(`\n改写后共有 ${Object.keys(merged).length} 个城市：`)
console.log('  ' + Object.entries(merged).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join('  '))

if (!changes.length) {
  console.log('\n无需改写。')
} else if (!APPLY) {
  console.log('\n（预演模式，未写库。加 --apply 执行）')
} else {
  let total = 0
  for (const ch of changes) {
    const res = await client.query(
      'UPDATE receivable_detail SET city = $1 WHERE city = $2',
      [ch.after, ch.before]
    )
    total += res.rowCount
  }
  console.log(`\n✅ 已改写 ${changes.length} 个值，共 ${total} 行`)
  const after = await client.query(
    `SELECT COUNT(DISTINCT city)::int AS cnt FROM receivable_detail WHERE city IS NOT NULL AND city <> ''`
  )
  const long = await client.query(
    `SELECT COUNT(*)::int AS cnt FROM receivable_detail
      WHERE city IS NOT NULL AND city <> '' AND city NOT LIKE '%市' AND city NOT LIKE '%县'`
  )
  console.log(`   回填后不同城市数：${after.rows[0].cnt}；既不以「市」也不以「县」结尾的：${long.rows[0].cnt}`)
}

await client.end()
