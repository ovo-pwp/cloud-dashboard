/**
 * 客户欠款 · 每日快照与变化（2026-11-19）
 *
 * 使用者要求：「每天的变化记录起来，好知道有没有发生变化」
 * ⇒ 每次同步后把**客户级汇总**存一份当日快照（当天重复写就覆盖 = 取最新状态），
 *   这样任何时候都能拿「今天 vs 昨天」比出：
 *     · 哪些客户是新出现的（有余额了）
 *     · 哪些客户消失了（结清了 / 剔除了）
 *     · 哪些客户金额变了（变了多少、朝哪个方向）
 *
 * 为什么单独建表、不复用 receivable_detail：
 *   receivable_detail 是**单据级 + 每小时一批**，客户级汇算是现算的，
 *   要回答「昨天这个客户多少」得翻批次重算；这里存的是**已经算好的客户级**，
 *   直接按 snapshot_date 对比即可。
 *
 * 口径与页面「客户欠款总览」完全一致：
 *   已发货未开票 / 已开票未回款 取 receivable_detail 两条线最新批次
 */

const TABLE = 'customer_debt_daily'

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  snapshot_date     date NOT NULL,
  customer_name    text NOT NULL,
  dept             text,
  salesperson      text,
  total_receivable numeric(18,2),
  uninvoiced_amount numeric(18,2),
  unpaid_amount    numeric(18,2),
  updated_at       timestamptz DEFAULT now(),
  PRIMARY KEY (snapshot_date, customer_name)
);
CREATE INDEX IF NOT EXISTS idx_customer_debt_daily_date ON ${TABLE} (snapshot_date);
`

/** 确保快照表存在（API 与同步都会调用；幂等） */
export async function ensureCustomerDailyTable(pool) {
  await pool.query(CREATE_SQL)
}

/** 本地日期 YYYY-MM-DD（🔴 不能用 toISOString：那是 UTC，早上 8 点前会算成「昨天」，
 *  把昨天的最终快照覆盖成凌晨的数据） */
function localDay() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 写当日客户级快照（同一天重复调用会覆盖 ⇒ 始终是最新状态）
 * @returns {{rows:number, snapshotDate:string}}
 */
export async function writeCustomerDailySnapshot(pool, { snapshotDate } = {}) {
  const day = snapshotDate || localDay()
  await pool.query(CREATE_SQL)

  // 取两条线各自最新批次
  const latest = await pool.query(
    `SELECT biz_type, id FROM import_batch b
      WHERE biz_type IN ('billed_unpaid','shipped_uninvoiced')
        AND id = (SELECT id FROM import_batch WHERE biz_type = b.biz_type
                   ORDER BY snapshot_date DESC, id DESC LIMIT 1)`
  )
  const bid = {}
  latest.rows.forEach((r) => { bid[r.biz_type] = r.id })
  const billedId = bid.billed_unpaid || 0
  const shippedId = bid.shipped_uninvoiced || 0
  if (!billedId && !shippedId) return { rows: 0, snapshotDate: day }

  await pool.query(`DELETE FROM ${TABLE} WHERE snapshot_date = $1`, [day])
  const res = await pool.query(
    `INSERT INTO ${TABLE}
       (snapshot_date, customer_name, dept, salesperson, total_receivable, uninvoiced_amount, unpaid_amount)
     WITH live AS (
       SELECT d.customer_name,
              COALESCE(NULLIF(TRIM(d.department),''),'（未分类）') AS dept,
              d.salesperson,
              SUM(CASE WHEN d.biz_type = 'shipped_uninvoiced' THEN d.amount_total ELSE 0 END) AS uninvoiced_amount,
              SUM(CASE WHEN d.biz_type = 'billed_unpaid' THEN d.amount_total ELSE 0 END)    AS unpaid_amount
         FROM receivable_detail d
        WHERE d.batch_id IN ($1, $2)
        GROUP BY 1, 2, 3
     )
     SELECT $3, customer_name, dept, salesperson,
            COALESCE(uninvoiced_amount,0) + COALESCE(unpaid_amount,0),
            uninvoiced_amount, unpaid_amount
       FROM live`,
    [billedId, shippedId, day]
  )
  return { rows: res.rowCount || 0, snapshotDate: day }
}

/**
 * 取最近两天的快照日期（今天、上一份可比的那天）
 * @returns {{cur:string|null, prev:string|null}}
 */
export async function getCustomerDailyDates(pool) {
  const { rows } = await pool.query(
    `SELECT snapshot_date::text AS d FROM ${TABLE}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 2`
  )
  return { cur: rows[0]?.d || null, prev: rows[1]?.d || null }
}
