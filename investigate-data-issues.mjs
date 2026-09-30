/**
 * 考据「城港市」与「僵尸单」两类数据问题
 * 输出为 JSON，供后续决策（改源表 vs 改库）
 */
import 'dotenv/config'
import { query } from './server/db/pool.js'

const out = {}

// ---- 1. 城市拼写：找出所有 city 值，看有没有像「城港市」这种缺字的 ----
const cities = await query(`
  SELECT city, COUNT(*)::int AS cnt, SUM(amount_total)::numeric AS amt
    FROM receivable_detail
   WHERE city IS NOT NULL AND city <> ''
   GROUP BY city ORDER BY cnt DESC
`)
out.cities = cities.rows.map(r => ({ city: r.city, cnt: r.cnt, amt: Number(r.amt).toFixed(2) }))

// ---- 2. 「城港市」这几条的具体客户名（看是不是「防城港」被写掉了一个字）----
const typo = await query(`
  SELECT customer_name, city, COUNT(*)::int AS cnt, SUM(amount_total)::numeric AS amt
    FROM receivable_detail
   WHERE city = '城港市'
   GROUP BY customer_name, city ORDER BY cnt DESC
`)
out.typoRows = typo.rows.map(r => ({ customer: r.customer_name, city: r.city, cnt: r.cnt, amt: Number(r.amt).toFixed(2) }))

// ---- 3. 同客户名的其他记录的 city（用于佐证「防城港」）----
const sameCust = await query(`
  SELECT DISTINCT customer_name, city
    FROM receivable_detail
   WHERE customer_name IN (SELECT DISTINCT customer_name FROM receivable_detail WHERE city='城港市')
   ORDER BY customer_name, city
`)
out.sameCustomerCities = sameCust.rows

// ---- 4. 僵尸单：doc_date 早于 2025 年的（最早的那批）----
const zombies = await query(`
  SELECT b.snapshot_date::text AS snap, d.biz_type, d.doc_date::text AS doc_date,
         d.doc_no, d.customer_name, d.salesperson, d.aging_category,
         d.amount_total::numeric AS amount, d.batch_id
    FROM receivable_detail d
    JOIN import_batch b ON b.id = d.batch_id
   WHERE d.doc_date < '2025-01-01'
   ORDER BY d.doc_date ASC
`)
out.zombies = zombies.rows.map(r => ({
  snap: r.snap, biz: r.biz_type, docDate: r.doc_date, docNo: r.doc_no,
  customer: r.customer_name, salesperson: r.salesperson, aging: r.aging_category,
  amount: Number(r.amount).toFixed(2), batchId: r.batch_id,
}))

// ---- 5. 这些僵尸单属于哪个批次、该批次是哪天同步的 ----
const zBatches = await query(`
  SELECT b.id, b.biz_type, b.snapshot_date::text AS snap, b.imported_at::text AS created
    FROM import_batch b
   WHERE b.id IN (
     SELECT DISTINCT batch_id FROM receivable_detail WHERE doc_date < '2025-01-01'
   )
   ORDER BY b.snapshot_date
`)
out.zombieBatches = zBatches.rows

// ---- 6. 最新批次里有没有这些单（如果最新批里还在，说明是真实存在的未回款）----
const latest = await query(`
  SELECT id, biz_type, snapshot_date::text AS snap
    FROM import_batch
   WHERE (biz_type, snapshot_date) IN (
     SELECT biz_type, MAX(snapshot_date) FROM import_batch GROUP BY biz_type
   )
`)
out.latestBatches = latest.rows

const stillThere = await query(`
  SELECT d.biz_type, COUNT(*)::int AS cnt, SUM(d.amount_total)::numeric AS amt
    FROM receivable_detail d
    JOIN import_batch b ON b.id = d.batch_id
   WHERE d.doc_date < '2025-01-01'
     AND b.snapshot_date = (SELECT MAX(snapshot_date) FROM import_batch b2 WHERE b2.biz_type = d.biz_type)
   GROUP BY d.biz_type
`)
out.zombiesInLatest = stillThere.rows.map(r => ({ biz: r.biz_type, cnt: r.cnt, amt: Number(r.amt).toFixed(2) }))

console.log(JSON.stringify(out, null, 2))
