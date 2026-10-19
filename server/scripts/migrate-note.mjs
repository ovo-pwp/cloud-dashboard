/**
 * 一次性迁移：把「备注」从会被同步覆盖的 receivable_detail.follow_up_note
 * 迁到独立表 detail_note（按 biz_type + doc_no 唯一），与源表导入彻底解耦。
 *
 * 背景（2026-10-19 使用者决定）：
 *   以前备注存在 receivable_detail.follow_up_note，但每次同步是「DELETE 整批 + INSERT 重建」，
 *   且 importer.js 会拿源表第 13 列(r[12])的备注覆盖掉这一列 —— 使用者在系统里填的跟进情况
 *   会在下次同步时被冲掉。现在改成：备注只在系统里加、只在系统里存，源表备注一律不带进来。
 *
 * 归属语义：一条单据（doc_no）一份备注。同一条单据在源表里会按账龄拆成很多行
 *   （实测 2026-376 有 18 行、客户/业务员/金额全一样、仅备注有的行有有的行空），
 *   这些行本质是同一单，备注应该共用一份 ⇒ 主键 (biz_type, doc_no)。
 *
 * 迁移规则：
 *   - 建表 detail_note (biz_type, doc_no, note, updated_at)。
 *   - 从 receivable_detail 里按 (biz_type, doc_no) 取「最新一条非空 follow_up_note」迁入。
 *   - 只读不删：receivable_detail.follow_up_note 保留原样（后续导入会置空，这里不动旧数据）。
 *
 * 用法：
 *   node server/scripts/migrate-note.mjs           # 预演（只打印，不建表不写库）
 *   node server/scripts/migrate-note.mjs --apply   # 真正执行
 */
import fs from 'node:fs'
import { Client } from 'pg'

const ENV_PATH = new URL('../../.env', import.meta.url)
const env = fs.readFileSync(ENV_PATH, 'utf8')
const g = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'))
  return m ? m[1].trim() : ''
}
const APPLY = process.argv.includes('--apply')
const DBURL = g('DATABASE_URL') || 'postgresql://postgres:postgres@localhost:5432/cloud_dashboard'

const client = new Client({ connectionString: DBURL })
await client.connect()

console.log(`模式：${APPLY ? '真正执行' : '预演（只打印，不写库）'}\n`)

// 1. 建表（幂等）
if (APPLY) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS detail_note (
      biz_type    VARCHAR(30)  NOT NULL,   -- billed_unpaid / shipped_uninvoiced
      doc_no      VARCHAR(30)  NOT NULL,
      note        TEXT,
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_by  VARCHAR(50),
      PRIMARY KEY (biz_type, doc_no)
    )
  `)
  console.log('✅ detail_note 表已就绪（幂等）\n')
}

// 2. 迁移：按 (biz_type, doc_no) 取「最新一条非空备注」
//    follow_up_note 是 TEXT，取非空且非纯空白；同 doc_no 多行时取 id 最大（最新导入）那条
const { rows: src } = await client.query(`
  SELECT DISTINCT ON (biz_type, doc_no)
         biz_type, doc_no, follow_up_note AS note, id
    FROM receivable_detail
   WHERE follow_up_note IS NOT NULL
     AND trim(follow_up_note) <> ''
   ORDER BY biz_type, doc_no, id DESC
`)
console.log(`待迁入：${src.length} 个 (biz_type, doc_no) 备注\n`)

const byType = {}
for (const r of src) {
  byType[r.biz_type] = (byType[r.biz_type] || 0) + 1
}
for (const [k, v] of Object.entries(byType)) {
  console.log(`  ${k}: ${v} 条`)
}

if (src.length > 0) {
  console.log('\n样例（前 10）：')
  src.slice(0, 10).forEach((r) => console.log(`  [${r.biz_type}] ${r.doc_no} → ${r.note}`))
}

if (APPLY && src.length > 0) {
  // 逐条 upsert（数量不大，逐条清晰可核对；用 ON CONFLICT 保证幂等可重跑）
  let done = 0
  for (const r of src) {
    await client.query(
      `INSERT INTO detail_note (biz_type, doc_no, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (biz_type, doc_no)
       DO UPDATE SET note = EXCLUDED.note, updated_at = now()`,
      [r.biz_type, r.doc_no, r.note]
    )
    done++
  }
  console.log(`\n✅ 已迁入 ${done} 条到 detail_note`)
}

if (!APPLY) {
  console.log('\n（未执行。加 --apply 真正写入）')
}

await client.end()
