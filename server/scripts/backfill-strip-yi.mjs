/**
 * 人名里的多余「一」回填（2026-11-23 使用者「把那些有一的去掉一」）
 *
 * 源表把「刘洋」写成「刘一洋」、「郑鹏」写成「郑一鹏」。归一器已加规则
 * （normalizeCustomerName 第 3.5 步，只动最后一段人名），但**存量数据是按旧名字入库的**，
 * 而且「重复批跳过」机制会让新规则永远不生效 ⇒ 必须单独回填一次。
 *
 * 用法：
 *   node server/scripts/backfill-strip-yi.mjs            # 预演，只打印
 *   node server/scripts/backfill-strip-yi.mjs --apply    # 真正写库
 *
 * 🔴 只改「姓 + 一 + 1~2 字」的人名段（复用全站同一条规则），机构名（五一路支行）不动。
 */
import 'dotenv/config'
import { query, pool } from '../db/pool.js'
import { normalizeCustomerName } from '../utils/customerName.js'

const APPLY = process.argv.includes('--apply')

/** 表 → 客户名列（含历史批次；漏一张就会出现同一客户两种名字） */
const TARGETS = [
  { table: 'receivable_detail', col: 'customer_name', key: 'batch_id' },
  { table: 'customer_debt_daily', col: 'customer_name' },
  { table: 'customer_debt_product', col: 'customer_name' },
  { table: 'customer_recon', col: 'customer' },
  { table: 'customer_invoice', col: 'customer' },
  { table: 'ledger_note', col: 'customer' },
  { table: 'customer_platform_unpaid', col: 'customer_name' },
]

let total = 0
for (const { table, col } of TARGETS) {
  let rows
  try {
    rows = (
      await query(`SELECT DISTINCT ${col} AS n FROM ${table} WHERE ${col} LIKE '%一%' ORDER BY 1`)
    ).rows
  } catch (e) {
    console.log(`- ${table}: 跳过（${e.message}）`)
    continue
  }
  const plan = []
  for (const r of rows) {
    const next = normalizeCustomerName(r.n).name
    if (next !== r.n) plan.push([r.n, next])
  }
  if (!plan.length) {
    console.log(`- ${table}: 无需改动（含「一」的 ${rows.length} 条都保留）`)
    continue
  }
  console.log(`\n- ${table}.${col}: ${plan.length} 个名字要改`)
  for (const [a, b] of plan) console.log(`    ${a}  →  ${b}`)
  total += plan.length
  if (!APPLY) continue

  // 目标名已存在 ⇒ 不能直接改（会撞主键/重复行），只提示人工处理
  for (const [a, b] of plan) {
    const dup = await query(`SELECT 1 FROM ${table} WHERE ${col} = $1 LIMIT 1`, [b])
    if (dup.rows.length) {
      console.log(`    ⚠ 跳过「${a} → ${b}」：表里已经存在 ${b}，需要人工合并`)
      continue
    }
    const r = await query(`UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`, [b, a])
    console.log(`    ✔ ${a} → ${b}（${r.rowCount} 行）`)
  }
}

console.log(`\n${APPLY ? '已写库' : '预演'}：共 ${total} 个名字${APPLY ? '' : '，加 --apply 才会写入'}`)
await pool.end()
