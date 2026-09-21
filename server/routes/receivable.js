/**
 * 回款 / 开票管理看板接口
 * 支持两种业务类型：billed_unpaid（已开票未回款）、shipped_uninvoiced（已发货未开票）
 */
import { Router } from 'express'
import { query, normalizeDate } from '../db/pool.js'
import {
  startSync,
  getSyncState,
  collectSources,
  listSyncRuns,
} from '../services/syncRunner.js'
import {
  requireSyncAuth,
  isLoginEnabled,
  listUsernames,
  verifyLogin,
  issueLoginToken,
  verifyLoginToken,
  LOGIN_TTL,
  REMEMBER_TTL,
} from '../services/syncAuth.js'
import { checkThrottle, THROTTLE } from '../services/loginThrottle.js'
import { buildXlsx, sendXlsx, safeFilename } from '../services/exportExcel.js'

const router = Router()

// ------------------------------------------------------------
// 登录审计 / 限流 共用的来源 IP
// ------------------------------------------------------------
/**
 * 是否信任 X-Forwarded-For。
 *
 * 默认 **不信任** —— 因为后端是直接监听 0.0.0.0 对外提供服务的，
 * 没有反向代理在前面覆写这个头。若此时采信它，任何客户端都能随手
 * 伪造 / 轮换该头，从而完全绕过基于 IP 的登录限流。
 *
 * 只有当确实在前面挂了 Nginx 等反向代理（且代理会覆写该头）时，
 * 才在 .env 里把 TRUST_PROXY 设为 true。
 */
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true'

/** 取客户端 IP：默认用 TCP 连接的真实来源，仅信任代理时才读转发头 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for']
    if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim().slice(0, 64)
  }
  const ip = req.socket?.remoteAddress || req.ip || ''
  return String(ip).replace(/^::ffff:/, '').slice(0, 64)
}

/**
 * 写入一条登录审计记录。
 * 审计失败不能影响登录本身，因此只记日志、不抛错。
 */
async function logLogin({ username, success, reason, req }) {
  try {
    await query(
      `INSERT INTO login_log (username, success, reason, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        String(username || '').slice(0, 100) || '(空)',
        !!success,
        reason ? String(reason).slice(0, 100) : null,
        clientIp(req),
        String(req.get('user-agent') || '').slice(0, 500) || null,
      ]
    )
  } catch (err) {
    console.warn('[login_log] 写入失败：', err.message)
  }
}

// ------------------------------------------------------------
// 登录（保护整个看板）
//   POST /api/login   用户名 + 密码 (+ remember) → 登录令牌
//   GET  /api/me      查当前登录状态
//   POST /api/logout  退出
// ------------------------------------------------------------
router.post('/login', async (req, res) => {
  if (!isLoginEnabled()) {
    return res.json({ loginEnabled: false, token: null, message: '未启用登录保护' })
  }
  const { username, password, remember } = req.body || {}
  const name = typeof username === 'string' ? username.trim() : ''

  // ---------- 限流：先看这个 IP 最近是不是撞太多次了 ----------
  const gate = await checkThrottle(clientIp(req))
  if (gate.blocked) {
    // 被拦下的请求也记一条，便于事后回溯谁在爆破（该原因不计入窗口，不会无限续期）
    await logLogin({ username: name, success: false, reason: '触发限流', req })
    const mins = Math.max(1, Math.ceil(gate.retryAfterSec / 60))
    res.set('Retry-After', String(gate.retryAfterSec))
    return res.status(429).json({
      error: `尝试次数过多，请 ${mins} 分钟后再试`,
      code: 'TOO_MANY_ATTEMPTS',
      retryAfterSec: gate.retryAfterSec,
      maxFails: THROTTLE.maxFails,
      windowMinutes: THROTTLE.windowMinutes,
    })
  }

  const result = verifyLogin(username, password)
  if (!result.ok) {
    await logLogin({ username: name, success: false, reason: result.reason, req })
    // 告知还剩几次；用完下一次就会被限流
    const remaining = gate.remaining - 1
    return res.status(401).json({
      error: '用户名或密码不正确',
      code: 'BAD_CREDENTIALS',
      remaining: Math.max(0, remaining),
      maxFails: THROTTLE.maxFails,
    })
  }

  // ---------- 登录成功 ----------
  const remembered = remember === true || remember === 'true'
  const token = issueLoginToken(name, remembered)
  await logLogin({ username: name, success: true, reason: null, req })

  res.json({
    loginEnabled: true,
    token,
    username: name,
    remember: remembered,
    ttlHours: remembered ? REMEMBER_TTL : LOGIN_TTL,
  })
})

router.get('/me', (req, res) => {
  if (!isLoginEnabled()) {
    return res.json({ loginEnabled: false, loggedIn: true, username: '匿名' })
  }
  const payload = verifyLoginToken(
    req.get('X-Auth-Token') || req.query.authToken || ''
  )
  if (!payload) {
    return res.status(401).json({ loginEnabled: true, loggedIn: false, code: 'LOGIN_REQUIRED' })
  }
  res.json({
    loginEnabled: true,
    loggedIn: true,
    username: payload.user,
    remember: !!payload.remember,
    ttlHours: payload.remember ? REMEMBER_TTL : LOGIN_TTL,
    expireAt: payload.exp ? new Date(payload.exp).toISOString() : null,
  })
})

router.post('/logout', async (req, res) => {
  // 令牌是无状态的，服务端只需告知前端丢弃即可；这里补一条审计便于回溯
  const payload = verifyLoginToken(req.get('X-Auth-Token') || '')
  if (payload?.user) {
    await logLogin({ username: payload.user, success: true, reason: '主动退出', req })
  }
  res.json({ ok: true })
})

// ------------------------------------------------------------
// 登录记录（谁在什么时候从哪里登录了平台）
//   GET /api/login-log  分页 + 可按账号/结果/时间范围过滤
//   GET /api/login-users  当前配置了哪些账号（不含密码）
// ------------------------------------------------------------
router.get('/login-log', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20))
    const offset = (page - 1) * pageSize

    const where = []
    const params = []
    const push = (v) => {
      params.push(v)
      return `$${params.length}`
    }

    const username = String(req.query.username || '').trim()
    if (username) where.push(`username ILIKE ${push(`%${username}%`)}`)

    // success=1 只看成功；success=0 只看失败；其它值不过滤
    const success = String(req.query.success ?? '')
    if (success === '1' || success === 'true') where.push(`success = TRUE`)
    else if (success === '0' || success === 'false') where.push(`success = FALSE`)

    const start = String(req.query.startDate || '').trim()
    if (start) where.push(`created_at >= ${push(start)}::date`)
    const end = String(req.query.endDate || '').trim()
    if (end) where.push(`created_at < (${push(end)}::date + INTERVAL '1 day')`)

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const { rows: cnt } = await query(
      `SELECT COUNT(*)::int AS total FROM login_log ${clause}`,
      params
    )
    const { rows } = await query(
      `SELECT id, username, success, reason, ip, user_agent,
              to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
         FROM login_log
         ${clause}
        ORDER BY id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    )

    // 顺便带一点统计，页面顶部可以显示「今日登录次数 / 失败尝试」
    const { rows: stat } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE success)::int AS ok_total,
         COUNT(*) FILTER (WHERE NOT success)::int AS fail_total,
         COUNT(*) FILTER (WHERE success AND created_at >= CURRENT_DATE)::int AS ok_today
       FROM login_log`
    )

    res.json({
      total: cnt[0].total,
      page,
      pageSize,
      rows: rows.map((r) => ({
        id: Number(r.id),
        username: r.username,
        success: r.success,
        reason: r.reason,
        ip: r.ip,
        userAgent: r.user_agent,
        createdAt: r.created_at,
      })),
      stats: stat[0],
      accounts: listUsernames(),
    })
  } catch (err) {
    next(err)
  }
})

router.get('/login-users', (req, res) => {
  res.json({ accounts: listUsernames() })
})

const BIZ_TYPES = {
  billed_unpaid: '已开票未回款',
  shipped_uninvoiced: '已发货未开票',
}

/** 校验并取业务类型，默认 billed_unpaid */
function resolveBizType(req) {
  const t = req.query.bizType
  return BIZ_TYPES[t] ? t : 'billed_unpaid'
}

/** 取指定业务类型的最新快照批次 */
async function getLatestBatch(bizType) {
  const { rows } = await query(
    `SELECT id,
            biz_type,
            to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date,
            row_count, total_amount, skipped_count, source_file,
            imported_at
       FROM import_batch
      WHERE biz_type = $1
      ORDER BY snapshot_date DESC, id DESC LIMIT 1`,
    [bizType]
  )
  return rows[0] || null
}

/** 金额转数字（pg numeric 返回字符串） */
function nums(row) {
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
  }
  return out
}

// ------------------------------------------------------------
// GET /api/health
// ------------------------------------------------------------
router.get('/health', async (req, res) => {
  try {
    const { rows } = await query('SELECT now() AS db_time')
    res.json({ ok: true, dbTime: rows[0].db_time })
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message })
  }
})

// ------------------------------------------------------------
// GET /api/biz-types  可用业务类型及其最新快照
// ------------------------------------------------------------
router.get('/biz-types', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT biz_type,
              to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date,
              row_count, total_amount, skipped_count,
              to_char(imported_at, 'YYYY-MM-DD HH24:MI') AS imported_at
         FROM import_batch
        WHERE id IN (
          SELECT DISTINCT ON (biz_type) id
            FROM import_batch
           ORDER BY biz_type, snapshot_date DESC, id DESC
        )
        ORDER BY biz_type`
    )
    res.json(
      rows.map((r) => ({
        bizType: r.biz_type,
        label: BIZ_TYPES[r.biz_type] || r.biz_type,
        snapshotDate: r.snapshot_date,
        rowCount: Number(r.row_count),
        totalAmount: Number(r.total_amount),
        skippedCount: Number(r.skipped_count),
        importedAt: r.imported_at,
        hasData: true,
      }))
    )
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/summary  顶部汇总
// query: bizType
// ------------------------------------------------------------
router.get('/summary', async (req, res, next) => {
  try {
    const bizType = resolveBizType(req)
    const batch = await getLatestBatch(bizType)

    if (!batch) {
      return res.json({
        hasData: false,
        bizType,
        bizLabel: BIZ_TYPES[bizType],
        snapshotDate: null,
        total: 0,
      })
    }

    const { rows } = await query(
      `SELECT
         COUNT(*)                                 AS doc_count,
         COUNT(DISTINCT customer_name)            AS customer_count,
         COUNT(DISTINCT salesperson)              AS salesperson_count,
         COALESCE(SUM(amount_total), 0)           AS total,
         COALESCE(SUM(amount_over3m), 0)          AS over3m,
         COALESCE(SUM(amount_3m), 0)              AS m3,
         COALESCE(SUM(amount_2m), 0)              AS m2,
         COALESCE(SUM(amount_1m), 0)              AS m1,
         COALESCE(SUM(amount_current), 0)         AS current_month,
         COUNT(*) FILTER (WHERE data_warning IS NOT NULL) AS warn_count
       FROM receivable_detail WHERE batch_id = $1`,
      [batch.id]
    )

    const r = nums(rows[0])
    res.json({
      hasData: true,
      bizType,
      bizLabel: BIZ_TYPES[bizType],
      snapshotDate: batch.snapshot_date,
      invoiceCount: r.doc_count,
      customerCount: r.customer_count,
      salespersonCount: r.salesperson_count,
      total: r.total,
      over3m: r.over3m,
      m3: r.m3,
      m2: r.m2,
      m1: r.m1,
      currentMonth: r.current_month,
      over3mRatio: r.total > 0 ? r.over3m / r.total : 0,
      warnCount: r.warn_count,
      skippedCount: Number(batch.skipped_count),
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/aging-by-salesperson  业务员 × 账龄档
// ------------------------------------------------------------
router.get('/aging-by-salesperson', async (req, res, next) => {
  try {
    const bizType = resolveBizType(req)
    const batch = await getLatestBatch(bizType)
    if (!batch) return res.json({ records: [], total: 0, bizType })

    const { rows } = await query(
      `SELECT
         salesperson,
         department,
         COUNT(*)                       AS "docCount",
         SUM(amount_over3m)::float8     AS "over3m",
         SUM(amount_3m)::float8         AS "m3",
         SUM(amount_2m)::float8         AS "m2",
         SUM(amount_1m)::float8         AS "m1",
         SUM(amount_current)::float8    AS "currentMonth",
         SUM(amount_total)::float8      AS "total"
       FROM receivable_detail
      WHERE batch_id = $1
      GROUP BY salesperson, department
      ORDER BY "total" DESC`,
      [batch.id]
    )

    const total = rows.reduce((s, r) => s + r.total, 0)
    res.json({ records: rows, total, bizType, snapshotDate: batch.snapshot_date })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/aging-summary  账龄分档汇总
// ------------------------------------------------------------
router.get('/aging-summary', async (req, res, next) => {
  try {
    const bizType = resolveBizType(req)
    const batch = await getLatestBatch(bizType)
    if (!batch) return res.json({ records: [], total: 0, bizType })

    const { rows } = await query(
      `SELECT
         COALESCE(aging_category, '未分类') AS "category",
         COUNT(*)                           AS "docCount",
         SUM(amount_total)::float8          AS "total"
       FROM receivable_detail
      WHERE batch_id = $1
      GROUP BY COALESCE(aging_category, '未分类')
      ORDER BY "total" DESC`,
      [batch.id]
    )
    const total = rows.reduce((s, r) => s + r.total, 0)
    res.json({ records: rows, total, bizType, snapshotDate: batch.snapshot_date })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// 明细查询的筛选条件（页面查询与 Excel 导出**共用**）
//   抽出来是为了防止两处逻辑漂移：导出结果必须与页面所见完全一致
// ------------------------------------------------------------
function buildDetailFilter(req, batchId) {
  const { salesperson, customer, agingCategory, keyword } = req.query
  const from = normalizeDate(req.query.from)
  const to = normalizeDate(req.query.to)

  const conditions = ['batch_id = $1']
  const params = [batchId]

  if (salesperson) {
    params.push(salesperson)
    conditions.push(`salesperson = $${params.length}`)
  }
  if (customer) {
    params.push(customer)
    conditions.push(`customer_name = $${params.length}`)
  }
  if (agingCategory) {
    if (agingCategory === '未分类') {
      conditions.push(`aging_category IS NULL`)
    } else {
      params.push(agingCategory)
      conditions.push(`aging_category = $${params.length}`)
    }
  }
  if (from) {
    params.push(from)
    conditions.push(`doc_date >= $${params.length}`)
  }
  if (to) {
    params.push(to)
    conditions.push(`doc_date <= $${params.length}`)
  }
  if (keyword) {
    params.push(`%${keyword}%`)
    conditions.push(`(doc_no ILIKE $${params.length} OR customer_name ILIKE $${params.length})`)
  }

  return { where: conditions.join(' AND '), params }
}

/** 明细排序白名单，防注入 */
const DETAIL_SORTABLE = {
  amountTotal: 'amount_total',
  docDate: 'doc_date',
  docNo: 'doc_no',
  customer: 'customer_name',
  over3m: 'amount_over3m',
  m3: 'amount_3m',
  m2: 'amount_2m',
  m1: 'amount_1m',
  currentMonth: 'amount_current',
}

/** 明细导出列（与「明细查询」页表格逐列对应） */
const DETAIL_EXPORT_COLUMNS = [
  { key: 'docNo', label: '单据编号' },
  { key: 'docDate', label: '日期' },
  { key: 'agingCategory', label: '账龄' },
  { key: 'customer', label: '挂账客户' },
  { key: 'salesperson', label: '业务员' },
  { key: 'amountTotal', label: '金额(元)', money: true },
  { key: 'over3m', label: '3个月以上', money: true },
  { key: 'm3', label: '3个月', money: true },
  { key: 'm2', label: '2个月', money: true },
  { key: 'm1', label: '1个月', money: true },
  { key: 'currentMonth', label: '当月', money: true },
  { key: 'note', label: '备注' },
  { key: 'warning', label: '提醒' },
]

/** 导出用的数据列 SQL（与 DETAIL_EXPORT_COLUMNS 对齐） */
const DETAIL_EXPORT_SELECT = `
  doc_no                              AS "docNo",
  to_char(doc_date, 'YYYY-MM-DD')     AS "docDate",
  COALESCE(aging_category, '未分类')  AS "agingCategory",
  customer_name                       AS "customer",
  salesperson,
  amount_total::float8                AS "amountTotal",
  amount_over3m::float8               AS "over3m",
  amount_3m::float8                   AS "m3",
  amount_2m::float8                   AS "m2",
  amount_1m::float8                   AS "m1",
  amount_current::float8              AS "currentMonth",
  follow_up_note                      AS "note",
  data_warning                        AS "warning"
`

/** 单次导出的行数上限，避免一个大查询把服务打满 */
const EXPORT_MAX_ROWS = 20000

// ------------------------------------------------------------
// GET /api/detail  明细查询
// query: bizType, salesperson, customer, agingCategory, from, to,
//        keyword, page, pageSize, sortBy, sortOrder
// ------------------------------------------------------------
router.get('/detail', async (req, res, next) => {
  try {
    const bizType = resolveBizType(req)
    const batch = await getLatestBatch(bizType)

    if (!batch) {
      return res.json({ records: [], total: 0, page: 1, pageSize: 20, totalPages: 0, bizType })
    }

    const { page = 1, pageSize = 20 } = req.query
    const { where, params } = buildDetailFilter(req, batch.id)

    const sortCol = DETAIL_SORTABLE[req.query.sortBy] || 'amount_total'
    const sortDir = String(req.query.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC'

    const countRes = await query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_total),0) AS total
         FROM receivable_detail WHERE ${where}`,
      params
    )
    const count = Number(countRes.rows[0].cnt)
    const sumTotal = Number(countRes.rows[0].total)

    const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 500)
    const currentPage = Math.max(Number(page) || 1, 1)
    const offset = (currentPage - 1) * limit
    params.push(limit, offset)

    const { rows } = await query(
      `SELECT
         id,
         doc_no                              AS "docNo",
         to_char(doc_date, 'YYYY-MM-DD')     AS "docDate",
         COALESCE(aging_category, '未分类')  AS "agingCategory",
         customer_name                       AS "customer",
         permission_raw                      AS "permission",
         salesperson,
         department,
         amount_total::float8                AS "amountTotal",
         amount_over3m::float8               AS "over3m",
         amount_3m::float8                   AS "m3",
         amount_2m::float8                   AS "m2",
         amount_1m::float8                   AS "m1",
         amount_current::float8              AS "currentMonth",
         follow_up_note                      AS "note",
         data_warning                        AS "warning"
       FROM receivable_detail
      WHERE ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    res.json({
      records: rows,
      total: count,
      sumTotal,
      page: currentPage,
      pageSize: limit,
      totalPages: Math.ceil(count / limit),
      bizType,
      snapshotDate: batch.snapshot_date,
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/export/detail  导出台账明细（当前筛选条件下的**全部**行）
//   筛选条件与 /detail 完全共用，保证导出结果 = 页面所见
// ------------------------------------------------------------
router.get('/export/detail', async (req, res, next) => {
  try {
    const bizType = resolveBizType(req)
    const batch = await getLatestBatch(bizType)
    const label = BIZ_TYPES[bizType] || bizType

    if (!batch) {
      return res.status(404).json({ error: '暂无数据可导出，请先同步数据' })
    }

    const { where, params } = buildDetailFilter(req, batch.id)

    // 先数一下行数，超上限就别白跑一趟大查询
    const cntRes = await query(
      `SELECT COUNT(*)::int AS cnt FROM receivable_detail WHERE ${where}`,
      params
    )
    const count = cntRes.rows[0].cnt
    if (count === 0) {
      return res.status(404).json({ error: '当前筛选条件下没有数据' })
    }
    if (count > EXPORT_MAX_ROWS) {
      return res.status(413).json({
        error: `当前筛选有 ${count} 行，超过单次导出上限 ${EXPORT_MAX_ROWS} 行，请缩小范围后重试`,
      })
    }

    const { rows } = await query(
      `SELECT ${DETAIL_EXPORT_SELECT}
         FROM receivable_detail
        WHERE ${where}
        ORDER BY ${DETAIL_SORTABLE[req.query.sortBy] || 'amount_total'} ${
          String(req.query.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC'
        }`,
      params
    )

    const buffer = buildXlsx({
      columns: DETAIL_EXPORT_COLUMNS,
      rows,
      sheetName: label.slice(0, 28),
    })

    const snapshot = new Date(batch.snapshot_date).toISOString().slice(0, 10)
    sendXlsx(res, buffer, safeFilename(`${label}明细_${snapshot}_${count}行.xlsx`))
  } catch (err) {
    next(err)
  }
})


// ------------------------------------------------------------
// GET /api/by-customer  按客户汇总
// ------------------------------------------------------------
router.get('/by-customer', async (req, res, next) => {
  try {
    const bizType = resolveBizType(req)
    const batch = await getLatestBatch(bizType)
    if (!batch) return res.json({ records: [], total: 0, bizType })

    const { rows } = await query(
      `SELECT
         customer_name                    AS "customer",
         COUNT(*)                         AS "docCount",
         SUM(amount_total)::float8        AS "total",
         SUM(amount_over3m)::float8       AS "over3m",
         string_agg(DISTINCT salesperson, '、') AS "salespersons"
       FROM receivable_detail
      WHERE batch_id = $1
      GROUP BY customer_name
      ORDER BY "total" DESC`,
      [batch.id]
    )
    const total = rows.reduce((s, r) => s + r.total, 0)
    res.json({ records: rows, total, bizType })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/filters  筛选选项
// ------------------------------------------------------------
router.get('/filters', async (req, res, next) => {
  try {
    const bizType = resolveBizType(req)
    const batch = await getLatestBatch(bizType)
    if (!batch) {
      return res.json({ salespeople: [], customers: [], agingCategories: [], bizType })
    }

    const [sp, cu, ag] = await Promise.all([
      query(
        `SELECT DISTINCT salesperson, department FROM receivable_detail
          WHERE batch_id = $1 ORDER BY salesperson`,
        [batch.id]
      ),
      query(
        `SELECT DISTINCT customer_name FROM receivable_detail
          WHERE batch_id = $1 ORDER BY customer_name`,
        [batch.id]
      ),
      query(
        `SELECT DISTINCT COALESCE(aging_category,'未分类') AS cat FROM receivable_detail
          WHERE batch_id = $1 ORDER BY cat`,
        [batch.id]
      ),
    ])

    res.json({
      bizType,
      salespeople: sp.rows.map((r) => ({ name: r.salesperson, department: r.department })),
      customers: cu.rows.map((r) => r.customer_name),
      agingCategories: ag.rows.map((r) => r.cat),
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/trend  每日快照趋势（可指定 bizType，不传则返回全部）
// ------------------------------------------------------------
router.get('/trend', async (req, res, next) => {
  try {
    const bizType = req.query.bizType
    const params = []
    let where = ''
    if (BIZ_TYPES[bizType]) {
      params.push(bizType)
      where = 'WHERE biz_type = $1'
    }

    const { rows } = await query(
      `SELECT biz_type AS "bizType",
              to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate",
              row_count AS "rowCount",
              total_amount::float8 AS "totalAmount",
              skipped_count AS "skippedCount",
              source_file AS "sourceFile",
              imported_at AS "importedAt"
         FROM import_batch
         ${where}
        ORDER BY biz_type, snapshot_date ASC`,
      params
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/warnings  数据质量告警（账龄分档与总额不符的行）
// ------------------------------------------------------------
router.get('/warnings', async (req, res, next) => {
  try {
    const bizType = resolveBizType(req)
    const batch = await getLatestBatch(bizType)
    if (!batch) return res.json({ records: [], bizType })

    const { rows } = await query(
      `SELECT
         doc_no                            AS "docNo",
         to_char(doc_date,'YYYY-MM-DD')    AS "docDate",
         customer_name                     AS "customer",
         salesperson,
         amount_total::float8              AS "amountTotal",
         data_warning                      AS "warning"
       FROM receivable_detail
      WHERE batch_id = $1 AND data_warning IS NOT NULL
      ORDER BY amount_total DESC`,
      [batch.id]
    )
    res.json({
      records: rows,
      bizType,
      skippedCount: Number(batch.skipped_count),
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// 客户平台未回款（独立数据源，客户+平台两级）
// 最新快照 = 表内 snapshot_date 最大的一批
// ------------------------------------------------------------
async function getCpuLatestSnapshot() {
  const { rows } = await query(
    `SELECT MAX(snapshot_date) AS d FROM customer_platform_unpaid`
  )
  return rows[0]?.d || null
}

// GET /api/customer-platform-unpaid/summary
router.get('/customer-platform-unpaid/summary', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) {
      return res.json({ hasData: false, snapshotDate: null, total: 0, orderCount: 0, customerCount: 0, platformCount: 0 })
    }
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(sales_amount_total),0) AS total,
         COUNT(*)                             AS order_count,
         COUNT(DISTINCT COALESCE(NULLIF(account_customer,''), customer_name, '未知客户')) AS customer_count,
         COUNT(DISTINCT platform)             AS platform_count
       FROM customer_platform_unpaid
      WHERE snapshot_date = $1`,
      [snapshot]
    )
    const r = nums(rows[0])
    res.json({
      hasData: true,
      snapshotDate: new Date(snapshot).toISOString().slice(0, 10),
      total: r.total,
      orderCount: Number(r.order_count),
      customerCount: Number(r.customer_count),
      platformCount: Number(r.platform_count),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/customer-platform-unpaid/platforms  平台列表（列展示用）
router.get('/customer-platform-unpaid/platforms', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) return res.json({ platforms: [] })
    const { rows } = await query(
      `SELECT platform FROM customer_platform_unpaid
        WHERE snapshot_date = $1 AND COALESCE(platform,'') <> ''
        GROUP BY platform ORDER BY SUM(sales_amount_total) DESC`,
      [snapshot]
    )
    res.json({ platforms: rows.map((r) => r.platform) })
  } catch (err) {
    next(err)
  }
})

// GET /api/customer-platform-unpaid/salespersons  业务员列表（筛选用）
router.get('/customer-platform-unpaid/salespersons', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) return res.json({ salespersons: [] })
    const { rows } = await query(
      `SELECT salesperson
         FROM customer_platform_unpaid
        WHERE snapshot_date = $1 AND COALESCE(salesperson,'') <> ''
        GROUP BY salesperson ORDER BY salesperson`,
      [snapshot]
    )
    res.json({ salespersons: rows.map((r) => r.salesperson) })
  } catch (err) {
    next(err)
  }
})

// GET /api/customer-platform-unpaid/breakdown  客户 → 平台 两级汇总（可按业务员筛选）
router.get('/customer-platform-unpaid/breakdown', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) return res.json({ records: [], total: 0, snapshotDate: null })

    const { salesperson } = req.query
    const conditions = ['snapshot_date = $1']
    const params = [snapshot]
    if (salesperson) {
      params.push(salesperson)
      conditions.push(`salesperson = $${params.length}`)
    }
    const where = conditions.join(' AND ')

    // 客户 × 平台
    const { rows } = await query(
      `SELECT
         COALESCE(NULLIF(account_customer,''), customer_name, '未知客户') AS customer,
         COALESCE(platform, '未知平台') AS platform,
         COUNT(*)     AS order_count,
         SUM(sales_amount_total)::float8 AS total
       FROM customer_platform_unpaid
      WHERE ${where}
      GROUP BY 1, 2
      ORDER BY customer, total DESC`,
      params
    )

    // 汇总到客户层级，并按客户总金额降序
    const customerMap = new Map()
    for (const r of rows) {
      if (!customerMap.has(r.customer)) {
        customerMap.set(r.customer, { customer: r.customer, total: 0, orderCount: 0, platforms: [] })
      }
      const c = customerMap.get(r.customer)
      c.total += r.total
      c.orderCount += Number(r.order_count)
      c.platforms.push({ platform: r.platform, total: r.total, orderCount: Number(r.order_count) })
    }

    const customers = [...customerMap.values()]
      .map((c) => ({ ...c, total: Math.round(c.total * 100) / 100 }))
      .sort((a, b) => b.total - a.total)

    const total = Math.round(customers.reduce((s, c) => s + c.total, 0) * 100) / 100

    res.json({
      records: customers,
      total,
      snapshotDate: new Date(snapshot).toISOString().slice(0, 10),
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// 客户平台明细的筛选条件（页面查询与 Excel 导出**共用**）
// ------------------------------------------------------------
function buildCpuDetailFilter(req, snapshot) {
  const { customer, platform, keyword } = req.query
  const conditions = ['snapshot_date = $1']
  const params = [snapshot]

  if (customer) {
    params.push(customer)
    conditions.push(
      `COALESCE(NULLIF(account_customer,''), customer_name, '未知客户') = $${params.length}`
    )
  }
  if (platform) {
    params.push(platform)
    conditions.push(`platform = $${params.length}`)
  }
  if (keyword) {
    params.push(`%${keyword}%`)
    conditions.push(
      `(customer_order_no ILIKE $${params.length} OR customer_name ILIKE $${params.length} OR account_customer ILIKE $${params.length})`
    )
  }

  return { where: conditions.join(' AND '), params }
}

/** 客户平台明细导出列（与页面表格逐列对应） */
const CPU_EXPORT_COLUMNS = [
  { key: 'platform', label: '平台' },
  { key: 'orderDate', label: '订单日期' },
  { key: 'orderNo', label: '订单号' },
  { key: 'customer', label: '客户' },
  { key: 'accountCustomer', label: '平台账号客户' },
  { key: 'product', label: '商品' },
  { key: 'qty', label: '数量' },
  { key: 'amountTotal', label: '金额(元)', money: true },
  { key: 'salesperson', label: '业务员' },
  { key: 'paymentStatus', label: '回款状态' },
  { key: 'invoiceStatus', label: '开票状态' },
]

/** 与 CPU_EXPORT_COLUMNS 对齐的导出查询列 */
const CPU_EXPORT_SELECT = `
  platform,
  to_char(order_date,'YYYY-MM-DD')                          AS "orderDate",
  customer_order_no                                         AS "orderNo",
  COALESCE(NULLIF(customer_name,''), account_customer, '—')  AS "customer",
  account_customer                                          AS "accountCustomer",
  product_name                                              AS "product",
  qty::float8                                               AS "qty",
  sales_amount_total::float8                                AS "amountTotal",
  salesperson,
  payment_status                                            AS "paymentStatus",
  invoice_status                                            AS "invoiceStatus"
`

// GET /api/customer-platform-unpaid/detail  订单级明细
router.get('/customer-platform-unpaid/detail', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) return res.json({ records: [], total: 0, snapshotDate: null })

    const { page = 1, pageSize = 20 } = req.query
    const { where, params } = buildCpuDetailFilter(req, snapshot)
    const countRes = await query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(sales_amount_total),0) AS total
         FROM customer_platform_unpaid WHERE ${where}`,
      params
    )
    const count = Number(countRes.rows[0].cnt)
    const sumTotal = Number(countRes.rows[0].total)

    const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 500)
    const currentPage = Math.max(Number(page) || 1, 1)
    const offset = (currentPage - 1) * limit
    params.push(limit, offset)

    const { rows } = await query(
      `SELECT
         platform,
         to_char(order_date,'YYYY-MM-DD') AS "orderDate",
         company_name AS "company",
         customer_order_no AS "orderNo",
         customer_name AS "customerName",
         account_customer AS "accountCustomer",
         payment_status AS "paymentStatus",
         product_name AS "product",
         qty::float8 AS "qty",
         sales_amount_total::float8 AS "amountTotal",
         salesperson,
         report_plan_no AS "planNo",
         invoice_status AS "invoiceStatus"
       FROM customer_platform_unpaid
      WHERE ${where}
      ORDER BY sales_amount_total DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    res.json({
      records: rows,
      total: count,
      sumTotal,
      page: currentPage,
      pageSize: limit,
      totalPages: Math.ceil(count / limit),
      snapshotDate: new Date(snapshot).toISOString().slice(0, 10),
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/export/customer-platform-detail  导出订单明细（当前筛选的全部行）
// ------------------------------------------------------------
router.get('/export/customer-platform-detail', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) {
      return res.status(404).json({ error: '暂无数据可导出，请先同步数据' })
    }

    const { where, params } = buildCpuDetailFilter(req, snapshot)

    const cntRes = await query(
      `SELECT COUNT(*)::int AS cnt FROM customer_platform_unpaid WHERE ${where}`,
      params
    )
    const count = cntRes.rows[0].cnt
    if (count === 0) {
      return res.status(404).json({ error: '当前筛选条件下没有数据' })
    }
    if (count > EXPORT_MAX_ROWS) {
      return res.status(413).json({
        error: `当前筛选有 ${count} 行，超过单次导出上限 ${EXPORT_MAX_ROWS} 行，请缩小范围后重试`,
      })
    }

    const { rows } = await query(
      `SELECT ${CPU_EXPORT_SELECT}
         FROM customer_platform_unpaid
        WHERE ${where}
        ORDER BY sales_amount_total DESC`,
      params
    )

    const buffer = buildXlsx({
      columns: CPU_EXPORT_COLUMNS,
      rows,
      sheetName: '客户平台订单明细',
    })

    const snap = new Date(snapshot).toISOString().slice(0, 10)
    sendXlsx(res, buffer, safeFilename(`客户平台订单明细_${snap}_${count}行.xlsx`))
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// 系统配置（监控参数 + 各数据源快照）—— 供「系统管理」页
// ------------------------------------------------------------
router.get('/system-config', async (req, res, next) => {
  try {
    const watcher = {
      enabled: process.env.IMPORT_WATCH_ENABLED !== 'false',
      folder: process.env.IMPORT_WATCH_FOLDER || '',
      intervalMs: Number(process.env.IMPORT_WATCH_INTERVAL) || 15000,
    }

    const { rows: batches } = await query(
      `SELECT biz_type, snapshot_date, imported_at, row_count, total_amount
         FROM import_batch
        WHERE (biz_type, id) IN (
              SELECT biz_type, MAX(id) FROM import_batch
              GROUP BY biz_type)
        ORDER BY biz_type`
    )
    const sources = batches.map((b) => ({
      key: b.biz_type,
      label: b.biz_type === 'billed_unpaid' ? '已开票未回款' : '已发货未开票',
      snapshotDate: new Date(b.snapshot_date).toISOString().slice(0, 10),
      importedAt: b.imported_at,
      rows: Number(b.row_count),
      totalAmount: b.total_amount,
    }))

    const cp = await query(
      `SELECT MAX(snapshot_date) AS d,
              COUNT(*) AS cnt,
              COALESCE(SUM(sales_amount_total),0) AS total
         FROM customer_platform_unpaid`
    )
    if (cp.rows[0].d) {
      sources.push({
        key: 'customer_platform_unpaid',
        label: '客户平台未回款',
        snapshotDate: cp.rows[0].d.toISOString().slice(0, 10),
        importedAt: null,
        rows: Number(cp.rows[0].cnt),
        totalAmount: cp.rows[0].total,
      })
    }

    res.json({ watcher, sources })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// 数据同步（网页端「立即同步」按钮）
//   POST /api/sync          启动一次「抓云端 → 入库」（需登录）
//   GET  /api/sync/status   轮询进度（含滚动日志）
//   GET  /api/sync/runs     最近若干次同步记录（持久化，重启后仍在）
// ------------------------------------------------------------
router.post('/sync', requireSyncAuth, async (req, res, next) => {
  try {
    const { started, reason, missing } = await startSync({ trigger: 'manual' })
    if (!started) {
      const payload = getSyncState({ withLog: false })
      if (reason === 'busy') {
        return res.status(409).json({ ...payload, error: '已有同步任务正在执行，请稍候' })
      }
      return res.status(500).json({ ...payload, error: getSyncState().message, missing })
    }
    res.json({ ...getSyncState({ withLog: false }), message: '同步任务已启动' })
  } catch (err) {
    next(err)
  }
})

router.get('/sync/status', async (req, res, next) => {
  try {
    const st = getSyncState()
    // 刚跑完且成功时，顺带带上最新快照，前端一次请求就能刷新表格
    if (!st.running && st.ok && !st.sources) {
      try {
        st.sources = await collectSources()
      } catch {
        /* 拿不到就等前端自己刷 */
      }
    }
    res.json(st)
  } catch (err) {
    next(err)
  }
})

/** 同步历史：持久化在 sync_run 表，后端重启也能看到 */
router.get('/sync/runs', async (req, res, next) => {
  try {
    const runs = await listSyncRuns({ limit: req.query.limit })
    res.json({ runs })
  } catch (err) {
    next(err)
  }
})

export default router
