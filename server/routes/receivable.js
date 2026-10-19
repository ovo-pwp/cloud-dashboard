/**
 * 回款 / 开票管理看板接口
 * 支持两种业务类型：billed_unpaid（已开票未回款）、shipped_uninvoiced（已发货未开票）
 */
import { Router } from 'express'
import { query, normalizeDate } from '../db/pool.js'
import { toDateOnly } from '../utils/date.js'
import {
  startSync,
  getSyncState,
  collectSources,
  listSyncRuns,
} from '../services/syncRunner.js'
import {
  requireRole,
  isLoginEnabled,
  listAccounts,
  verifyLogin,
  issueLoginToken,
  verifyLoginToken,
  ROLE_ADMIN,
  CAN_EXPORT,
  CAN_EDIT_DETAIL,
  ROLE_LABEL,
  LOGIN_TTL,
  REMEMBER_TTL,
} from '../services/syncAuth.js'
import { checkThrottle, THROTTLE } from '../services/loginThrottle.js'
import { issueCaptcha, verifyCaptcha, CAPTCHA_TTL_SEC } from '../services/captcha.js'
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

// ------------------------------------------------------------
// 登录验证码（2026-10-19）
//   LOGIN_CAPTCHA_ENABLED=true        是否启用（默认关闭）
//   LOGIN_CAPTCHA_LOCAL_BYPASS=true   本机回环免验证码（默认 true）—— 给本机验证脚本用。
//                                     公网请求经 Cloudflare Tunnel 会带真实 IP（TRUST_PROXY=true），
//                                     不命中这条，所以公网访问照样要验证码。
// ------------------------------------------------------------
const CAPTCHA_ENABLED = String(process.env.LOGIN_CAPTCHA_ENABLED || '').toLowerCase() === 'true'
const CAPTCHA_LOCAL_BYPASS = String(process.env.LOGIN_CAPTCHA_LOCAL_BYPASS || 'true').toLowerCase() !== 'false'

/** 本机回环（clientIp 已去掉 ::ffff: 前缀） */
function isLoopback(ip) {
  const s = String(ip || '')
  return s === '::1' || s === '127.0.0.1' || s === 'localhost'
}

/** 本次请求是否需要验证码 */
function captchaRequired(req) {
  if (!CAPTCHA_ENABLED) return false
  if (CAPTCHA_LOCAL_BYPASS && isLoopback(clientIp(req))) return false
  return true
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
/** GET /api/captcha —— 出题（不需要登录） */
router.get('/captcha', (req, res) => {
  if (!captchaRequired(req)) return res.json({ enabled: false })
  const c = issueCaptcha()
  res.json({ enabled: true, token: c.token, question: c.question, ttlSec: CAPTCHA_TTL_SEC })
})

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

  // ---------- 验证码：公网必过；本机回环按配置可免 ----------
  if (captchaRequired(req)) {
    const { captchaToken, captchaAnswer } = req.body || {}
    if (!verifyCaptcha(captchaToken, captchaAnswer)) {
      await logLogin({ username: name, success: false, reason: '验证码错误', req })
      return res.status(400).json({
        code: 'CAPTCHA_INVALID',
        error: '验证码不对或已过期，请重新输入',
      })
    }
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
    role: result.role,
    roleLabel: ROLE_LABEL[result.role] || result.role,
    remember: remembered,
    ttlHours: remembered ? REMEMBER_TTL : LOGIN_TTL,
  })
})

router.get('/me', (req, res) => {
  if (!isLoginEnabled()) {
    return res.json({
      loginEnabled: false,
      loggedIn: true,
      username: '匿名',
      role: ROLE_ADMIN,
      roleLabel: ROLE_LABEL[ROLE_ADMIN],
    })
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
    role: payload.role,
    roleLabel: ROLE_LABEL[payload.role] || payload.role,
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
//
// 两者都含 IP / 浏览器指纹 / 账号清单，只给管理员看。
// ------------------------------------------------------------
router.get('/login-log', requireRole(ROLE_ADMIN), async (req, res, next) => {
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
      accounts: listAccounts(),
    })
  } catch (err) {
    next(err)
  }
})

router.get('/login-users', requireRole(ROLE_ADMIN), (req, res) => {
  res.json({ accounts: listAccounts() })
})

const BIZ_TYPES = {
  billed_unpaid: '已开票未回款',
  shipped_uninvoiced: '已发货未开票',
}

/**
 * 「进度反馈」允许的业务类型 = 应收两条线 + 客户平台。
 *
 * 为什么不直接把 customer_platform 塞进 BIZ_TYPES：BIZ_TYPES 是
 * receivable_detail 的业务线字典（全站各处拿它取中文名、判断是不是应收线），
 * 往里加第三个会让 /detail、/trend、导出等一堆地方都以为多了一条应收线。
 * 这里单独开一个集合，只给备注写入用，范围最小。
 */
const NOTE_BIZ_TYPES = {
  ...BIZ_TYPES,
  customer_platform: '客户平台未回款',
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

/**
 * 取「上一个可用批次」（比 latestSnapshotDate 更早的最近一个批次）。
 *
 * 为什么不直接 ORDER BY snapshot_date DESC LIMIT 1 OFFSET 1：
 *   调用方已经拿到了最新批，这里按「快照日期严格小于最新批」来取，
 *   语义更明确，也不会因为同一天有两个批次而取错。
 *
 * 为什么不用「昨天」：
 *   同步不是每天都跑（实测 09-24 之后直接跳到 09-28），
 *   按「昨天」找会大面积取不到，卡片上就一直显示不出对比。
 *   所以取「上一个真实存在数据的批次」，并在界面上**写明是哪一天**，
 *   让人自己判断这个对比的间隔有多远。
 */
async function getPrevBatch(bizType, latestSnapshotDate) {
  if (!latestSnapshotDate) return null
  const { rows } = await query(
    `SELECT id,
            biz_type,
            to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date,
            row_count, total_amount, skipped_count, source_file,
            imported_at
       FROM import_batch
      WHERE biz_type = $1
        AND snapshot_date < $2::date
      ORDER BY snapshot_date DESC, id DESC LIMIT 1`,
    [bizType, latestSnapshotDate]
  )
  return rows[0] || null
}

/**
 * 「总额 / 3个月以上 / 单据数 / 涉及业务员」四个指标的聚合 SQL。
 * 抽出来是因为 /summary 要对「最新批」和「上一个批」各跑一遍 ——
 * 两边必须用**完全相同**的口径，否则算出来的涨跌是假的。
 */
function summaryAggSql() {
  return `
    SELECT
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
    FROM receivable_detail WHERE `
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

    // 可选按业务员过滤：给「我的业绩」页取某人自己的合计用。
    // 不传 = 全量（数据概览页的调用方式），行为与以前完全一致
    const salesperson = String(req.query.salesperson || '').trim()
    const params = [batch.id]
    let where = 'batch_id = $1'
    if (salesperson) {
      params.push(salesperson)
      where += ` AND salesperson = $${params.length}`
    }

    const { rows } = await query(summaryAggSql() + where, params)

    const r = nums(rows[0])

    // ---- 业务员排名（2026-10-10 新增，「我的业绩」第 4 张卡用）----
    // 口径（使用者 2026-10-10 定）：
    //   · 按「未回款总额」倒序
    //   · 并列同名次（RANK）—— 不用 ROW_NUMBER，否则并列时会凭空吃掉一个名次
    //   · 「大客户中心」算一个参评单位；「未指定」（源表没填业务员）**不算**
    //   · 只在传了 salesperson 时返回：不传是「看全公司」，没有「我的名次」这回事
    let rank = null
    if (salesperson) {
      const rk = await query(
        `WITH agg AS (
           SELECT salesperson, SUM(amount_total) AS total
             FROM receivable_detail
            WHERE batch_id = $1
              AND COALESCE(TRIM(salesperson), '') <> ''
              AND TRIM(salesperson) <> '未指定'
            GROUP BY salesperson
         ), ranked AS (
           SELECT salesperson,
                  total,
                  RANK()     OVER (ORDER BY total DESC) AS pos,
                  COUNT(*)   OVER ()                    AS of_count,
                  SUM(total) OVER ()                    AS pool_total
             FROM agg
         )
         SELECT pos, of_count, pool_total FROM ranked WHERE salesperson = $2`,
        [batch.id, salesperson]
      )
      const row = rk.rows[0]
      if (row) {
        rank = {
          position: Number(row.pos),
          of: Number(row.of_count),
          poolTotal: Number(row.pool_total),
          // 占比的分母用「参评池」而不是整批合计：池里不含「未指定」，
          // 这样分子分母和名次是同一口径
          share: Number(row.pool_total) > 0 ? Number(r.total) / Number(row.pool_total) : 0,
        }
      }
    }

    // ---- 上期对比（2026-09-29 新增）----
    // 口径要点：
    //   1) 与本期用**同一个 where**（同一业务员过滤），否则「个人 vs 全公司」没有意义
    //   2) 取「上一个可用批次」而不是「昨天」——同步不是每天都有
    //   3) 取不到上期就返回 prev:null，前端整块不渲染，**不写死 0、不显示 0.0%**
    //      （0.0% 会让人误以为「和上次一模一样」，而实际是「没有可比数据」）
    const prevBatch = await getPrevBatch(bizType, batch.snapshot_date)
    let prev = null
    if (prevBatch) {
      const prevParams = [prevBatch.id]
      let prevWhere = 'batch_id = $1'
      if (salesperson) {
        prevParams.push(salesperson)
        prevWhere += ` AND salesperson = $${prevParams.length}`
      }
      const prevRes = await query(summaryAggSql() + prevWhere, prevParams)
      const p = nums(prevRes.rows[0])
      prev = {
        snapshotDate: prevBatch.snapshot_date,
        total: p.total,
        over3m: p.over3m,
        invoiceCount: p.doc_count,
        customerCount: p.customer_count,
        salespersonCount: p.salesperson_count,
        // 单均金额 = 总额 ÷ 单据数（与前端 avg 算法一致），单据数为 0 时给 null
        avgAmount: p.doc_count > 0 ? p.total / p.doc_count : null,
      }
    }

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
      /** 单均金额放后端算，保证「本期」和「上期」用同一个公式 */
      avgAmount: r.doc_count > 0 ? r.total / r.doc_count : null,
      // 未回款总额的名次（未传 salesperson 时为 null）
      rank,
      prev,
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
         COUNT(*)::int                  AS "docCount",
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
         COUNT(*)::int                      AS "docCount",
         SUM(amount_total)::float8          AS "total"
       FROM receivable_detail
      WHERE batch_id = $1
      GROUP BY COALESCE(aging_category, '未分类')
      ORDER BY "total" DESC`,
      [batch.id]
    )
    const total = rows.reduce((s, r) => s + r.total, 0)

    // ---- 上期同口径（2026-10-12 新增，给「账龄结构」每档加「较上期」）----
    // 口径与 /summary 的卡片环比**完全一致**：同一个 getPrevBatch（上一个可用批次，
    // 不是「昨天」）。两处若用不同基准，页面会出现「卡片说涨、结构说跌」的矛盾读数。
    // 取不到上期 → prev: null，前端整列不渲染，**不显示 0.0%**。
    let prev = null
    const prevBatch = await getPrevBatch(bizType, batch.snapshot_date)
    if (prevBatch) {
      const prevRows = (await query(
        `SELECT COALESCE(aging_category, '未分类') AS category,
                SUM(amount_total)::float8 AS total
           FROM receivable_detail
          WHERE batch_id = $1
          GROUP BY COALESCE(aging_category, '未分类')`,
        [prevBatch.id]
      )).rows
      prev = {
        snapshotDate: prevBatch.snapshot_date,
        byCategory: Object.fromEntries(prevRows.map((r) => [r.category, Number(r.total || 0)])),
      }
    }

    res.json({
      records: rows,
      total,
      bizType,
      snapshotDate: batch.snapshot_date,
      prev,
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// 明细查询的筛选条件（页面查询与 Excel 导出**共用**）
//   抽出来是为了防止两处逻辑漂移：导出结果必须与页面所见完全一致
// ------------------------------------------------------------
function buildDetailFilter(req, batchId) {
  const { salesperson, customer, agingCategory, keyword, city } = req.query
  const from = normalizeDate(req.query.from)
  const to = normalizeDate(req.query.to)

  const conditions = ['d.batch_id = $1']
  const params = [batchId]

  if (salesperson) {
    params.push(salesperson)
    conditions.push(`d.salesperson = $${params.length}`)
  }
  if (customer) {
    params.push(customer)
    conditions.push(`d.customer_name = $${params.length}`)
  }
  if (city) {
    params.push(city)
    conditions.push(`d.city = $${params.length}`)
  }
  if (agingCategory) {
    if (agingCategory === '未分类') {
      conditions.push(`d.aging_category IS NULL`)
    } else {
      params.push(agingCategory)
      conditions.push(`d.aging_category = $${params.length}`)
    }
  }
  if (from) {
    params.push(from)
    conditions.push(`d.doc_date >= $${params.length}`)
  }
  if (to) {
    params.push(to)
    conditions.push(`d.doc_date <= $${params.length}`)
  }
  if (keyword) {
    params.push(`%${keyword}%`)
    conditions.push(`(d.doc_no ILIKE $${params.length} OR d.customer_name ILIKE $${params.length})`)
  }

  return { where: conditions.join(' AND '), params }
}

/** 明细排序白名单，防注入 */
/**
 * 账龄排序键：按「哪一档有金额」定序，老 → 新（3个月以上 排最前）。
 *
 * 为什么不用 doc_date 排：账龄分档取自**源表自带的 5 个金额列**
 *   （over3m / 3m / 2m / 1m / current），按日期排只在正好按月对齐时才与分档一致，
 *   跨月边界会错位。
 * 为什么不用 aging_category 文本排：源里同一档有多种写法
 *   （「三个月以上未回款」「3个月以上」），按文本排会乱序。
 */
const AGING_ORDER_SQL = `CASE
          WHEN d.amount_over3m  <> 0 THEN 1
          WHEN d.amount_3m      <> 0 THEN 2
          WHEN d.amount_2m      <> 0 THEN 3
          WHEN d.amount_1m      <> 0 THEN 4
          WHEN d.amount_current <> 0 THEN 5
          ELSE 6 END`

const DETAIL_SORTABLE = {
  amountTotal: 'd.amount_total',
  docDate: 'd.doc_date',
  docNo: 'd.doc_no',
  customer: 'd.customer_name',
  // 前端「账龄」列的表头点击排序走这个键
  agingCategory: AGING_ORDER_SQL,
  over3m: 'd.amount_over3m',
  m3: 'd.amount_3m',
  m2: 'd.amount_2m',
  m1: 'd.amount_1m',
  currentMonth: 'd.amount_current',
}

/**
 * 明细 ORDER BY 子句（白名单查表，不拼接用户输入）。
 *
 * 默认 = 账龄（老 → 新）+ 同档内金额从大到小。传了白名单外的 sortBy 也回落到默认。
 * 末尾固定加 id ASC：分页时如果没有唯一键兜底，金额相同的行在不同页会重复/漏掉。
 */
function detailOrderBy(sortBy, sortOrder) {
  const known = sortBy && Object.prototype.hasOwnProperty.call(DETAIL_SORTABLE, sortBy)
  if (!known) return `${AGING_ORDER_SQL} ASC, d.amount_total DESC, d.id ASC`
  const dir = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  return `${DETAIL_SORTABLE[sortBy]} ${dir}, d.amount_total DESC, d.id ASC`
}

/** 明细导出列（与「明细查询」页表格逐列对应） */
const DETAIL_EXPORT_COLUMNS = [
  { key: 'docNo', label: '单据编号' },
  { key: 'docDate', label: '日期' },
  { key: 'agingCategory', label: '账龄' },
  { key: 'customer', label: '挂账客户' },
  { key: 'salesperson', label: '业务员' },
  { key: 'city', label: '城市' },
  { key: 'rowSystem', label: '行系' },
  { key: 'amountTotal', label: '金额(元)', money: true },
  { key: 'over3m', label: '3个月以上', money: true },
  { key: 'm3', label: '3个月', money: true },
  { key: 'm2', label: '2个月', money: true },
  { key: 'm1', label: '1个月', money: true },
  { key: 'currentMonth', label: '当月', money: true },
  { key: 'note', label: '进度反馈' },
  { key: 'reminder', label: '人工提醒' },
  { key: 'warning', label: '提醒' },
]

/** 导出用的数据列 SQL（与 DETAIL_EXPORT_COLUMNS 对齐） */
const DETAIL_EXPORT_SELECT = `
  d.doc_no                            AS "docNo",
  to_char(d.doc_date, 'YYYY-MM-DD')   AS "docDate",
  COALESCE(d.aging_category, '未分类') AS "agingCategory",
  d.customer_name                     AS "customer",
  d.salesperson,
  d.city,
  d.row_system                      AS "rowSystem",
  d.amount_total::float8              AS "amountTotal",
  d.amount_over3m::float8             AS "over3m",
  d.amount_3m::float8                 AS "m3",
  d.amount_2m::float8                 AS "m2",
  d.amount_1m::float8                 AS "m1",
  d.amount_current::float8            AS "currentMonth",
  n.note                              AS "note",
  d.manual_reminder                   AS "reminder",
  d.data_warning                      AS "warning"
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

    const orderBy = detailOrderBy(req.query.sortBy, req.query.sortOrder)

    const countRes = await query(
      `SELECT COUNT(*)           AS cnt,
              COALESCE(SUM(d.amount_total),  0) AS total,
              COALESCE(SUM(d.amount_over3m), 0) AS over3m,
              COALESCE(SUM(d.amount_3m),     0) AS m3,
              COALESCE(SUM(d.amount_2m),     0) AS m2,
              COALESCE(SUM(d.amount_1m),     0) AS m1,
              COALESCE(SUM(d.amount_current),0) AS current_month
         FROM receivable_detail d WHERE ${where}`,
      params
    )
    const count = Number(countRes.rows[0].cnt)
    const sumTotal = Number(countRes.rows[0].total)
    // 全量分列合计：表尾用它，保证「筛选全量」与「表尾」是同一个口径，
    // 不再出现同一屏两个不同的合计数字
    const sumColumns = {
      amountTotal: Number(countRes.rows[0].total),
      over3m: Number(countRes.rows[0].over3m),
      m3: Number(countRes.rows[0].m3),
      m2: Number(countRes.rows[0].m2),
      m1: Number(countRes.rows[0].m1),
      currentMonth: Number(countRes.rows[0].current_month),
    }

    const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 500)
    const currentPage = Math.max(Number(page) || 1, 1)
    const offset = (currentPage - 1) * limit
    params.push(limit, offset)

    const { rows } = await query(
      `SELECT
         d.id,
         d.doc_no                            AS "docNo",
         to_char(d.doc_date, 'YYYY-MM-DD')   AS "docDate",
         COALESCE(d.aging_category, '未分类') AS "agingCategory",
         d.customer_name                     AS "customer",
         d.permission_raw                    AS "permission",
         d.salesperson,
         d.department,
         d.city,
         d.row_system                      AS "rowSystem",
         d.amount_total::float8              AS "amountTotal",
         d.amount_over3m::float8             AS "over3m",
         d.amount_3m::float8                 AS "m3",
         d.amount_2m::float8                 AS "m2",
         d.amount_1m::float8                 AS "m1",
         d.amount_current::float8            AS "currentMonth",
         n.note                              AS "note",
         d.manual_reminder                   AS "reminder",
         d.data_warning                      AS "warning"
       FROM receivable_detail d
       LEFT JOIN detail_note n
              ON n.biz_type = d.biz_type AND n.doc_no = d.doc_no
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    res.json({
      records: rows,
      total: count,
      sumTotal,
      sumColumns,
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
// PUT /api/detail/note      修改某条明细的备注
// PUT /api/detail/reminder  修改某条明细的人工提醒
//
//   两个字段都是「人写的一句话」，落库逻辑完全一样（校验 id → UPDATE → 回写），
//   所以抽成 makeTextUpdater：只有列名、请求字段、字数上限四处不同。
//   不抽的话，第二处必然是复制粘贴改一改 —— 以后改校验规则就会漏掉一边。
//
//   权限：管理员与成员都能改（一线同事追款时最需要写这两句），后端是真正防线。
//   注意「提醒」与 data_warning 是**两个字段**：前者人写、后者系统自动检测，
//   混在一起会被同步覆盖，故分开存（接口返回的 reminder 与 warning 也是分开的）。
// ------------------------------------------------------------
function makeTextUpdater({ column, field, label, maxLen }) {
  return async (req, res, next) => {
    try {
      const id = Number(req.body?.id)
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: '缺少有效的明细 id' })
      }
      const text = typeof req.body?.[field] === 'string' ? req.body[field] : ''
      if (text.length > maxLen) {
        return res.status(400).json({ error: `${label}内容过长（最多 ${maxLen} 字）` })
      }

      const value = text.trim() ? text : null
      const { rowCount } = await query(
        `UPDATE receivable_detail SET ${column} = $2 WHERE id = $1`,
        [id, value]
      )
      if (rowCount === 0) {
        return res.status(404).json({ error: '未找到该明细记录' })
      }
      res.json({ ok: true, id, [field]: value })
    } catch (err) {
      next(err)
    }
  }
}

router.put(
  '/detail/note',
  requireRole(...CAN_EDIT_DETAIL),
  async (req, res, next) => {
    try {
      // 备注现在按「单据号」一份、存独立表 detail_note（主键 biz_type + doc_no），
      // 与源表导入彻底解耦（2026-10-19 使用者决定：备注只在系统里加、只在系统里存）。
      // 请求体：{ bizType, docNo, note }（docNo = 明细行的 docNo，前端 row 里就有）
      const bizType = req.body?.bizType
      const docNo = String(req.body?.docNo ?? '').trim()
      const text = typeof req.body?.note === 'string' ? req.body.note : ''

      if (!NOTE_BIZ_TYPES[bizType]) {
        return res.status(400).json({ error: '缺少有效的业务类型' })
      }
      if (!docNo) {
        return res.status(400).json({ error: '缺少有效的单据编号' })
      }
      if (text.length > 2000) {
        return res.status(400).json({ error: '进度反馈内容过长（最多 2000 字）' })
      }

      const value = text.trim() ? text : null
      const who = req.user || null

      if (value === null) {
        // 清空：删掉这条备注（不存在也算成功，幂等）
        await query('DELETE FROM detail_note WHERE biz_type = $1 AND doc_no = $2', [bizType, docNo])
      } else {
        await query(
          `INSERT INTO detail_note (biz_type, doc_no, note, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (biz_type, doc_no)
           DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [bizType, docNo, value, who]
        )
      }

      res.json({ ok: true, bizType, docNo, note: value })
    } catch (err) {
      next(err)
    }
  }
)

router.put(
  '/detail/reminder',
  requireRole(...CAN_EDIT_DETAIL),
  makeTextUpdater({ column: 'manual_reminder', field: 'reminder', label: '提醒', maxLen: 500 })
)

// ------------------------------------------------------------
// GET /api/export/detail  导出台账明细（当前筛选条件下的**全部**行）
//   筛选条件与 /detail 完全共用，保证导出结果 = 页面所见
//
//   导出是日常动作（对账、发给客户），管理员与成员都能做；
//   真正限管理员的是「同步数据」和「系统管理」。
//   要收回去，把下面的 CAN_EXPORT 换成 ROLE_ADMIN 即可，页面按钮同步改回 isAdmin。
// ------------------------------------------------------------
router.get('/export/detail', requireRole(...CAN_EXPORT), async (req, res, next) => {
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
      `SELECT COUNT(*)::int AS cnt FROM receivable_detail d WHERE ${where}`,
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
         FROM receivable_detail d
         LEFT JOIN detail_note n
                ON n.biz_type = d.biz_type AND n.doc_no = d.doc_no
        WHERE ${where}
        ORDER BY ${detailOrderBy(req.query.sortBy, req.query.sortOrder)}`,
      params
    )

    const buffer = buildXlsx({
      columns: DETAIL_EXPORT_COLUMNS,
      rows,
      sheetName: label.slice(0, 28),
    })

    const snapshot = toDateOnly(batch.snapshot_date)
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
         COUNT(*)::int                    AS "docCount",
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
      return res.json({ salespeople: [], customers: [], agingCategories: [], cities: [], rowSystems: [], bizType })
    }

    // 可选按业务员过滤「客户」候选：「我的业绩」页只想列这个人自己的客户，
    // 下拉里塞全公司的客户会很难找。其余列表不受影响（不传 salesperson 时行为不变）
    const filterSp = String(req.query.salesperson || '').trim()
    const cuParams = filterSp ? [batch.id, filterSp] : [batch.id]
    const cuWhere = filterSp
      ? 'batch_id = $1 AND salesperson = $2'
      : 'batch_id = $1'

    const [sp, cu, ag, ct, rs] = await Promise.all([
      query(
        `SELECT DISTINCT salesperson, department FROM receivable_detail
          WHERE batch_id = $1 ORDER BY salesperson`,
        [batch.id]
      ),
      query(
        `SELECT DISTINCT customer_name FROM receivable_detail
          WHERE ${cuWhere} ORDER BY customer_name`,
        cuParams
      ),
      query(
        `SELECT DISTINCT COALESCE(aging_category,'未分类') AS cat FROM receivable_detail
          WHERE batch_id = $1 ORDER BY cat`,
        [batch.id]
      ),
      // 城市：只有「已开票未回款」那张源表有这列，未开票取到会全是 NULL
      query(
        `SELECT DISTINCT city FROM receivable_detail
          WHERE batch_id = $1 AND city IS NOT NULL AND city <> '' ORDER BY city`,
        [batch.id]
      ),
      // 行系：与城市相反 —— 只有「已发货未开票」源表有这列，未回款取到全是 NULL
      query(
        `SELECT DISTINCT row_system FROM receivable_detail
          WHERE batch_id = $1 AND row_system IS NOT NULL AND row_system <> '' ORDER BY row_system`,
        [batch.id]
      ),
    ])

    res.json({
      bizType,
      salespeople: sp.rows.map((r) => ({ name: r.salesperson, department: r.department })),
      customers: cu.rows.map((r) => r.customer_name),
      agingCategories: ag.rows.map((r) => r.cat),
      cities: ct.rows.map((r) => r.city),
      rowSystems: rs.rows.map((r) => r.row_system),
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/trend  每日快照趋势
//
//   2026-10-10 起改为**按日期透视**：一行 = 一个快照日期，两条业务线并排。
//   以前是「一行 = 一个批次」，同一个日期占两行，横着看不出两条线的关系。
//
//   🔴 「回款」「已开票」在库里**没有现成字段**，是推算出来的：
//      源表是「未回款 / 未开票」的**快照** —— 一笔单收回款（或开完票）后，
//      它就从表里**消失**。所以逐单对比相邻两批：
//        回款   = 上一批有、本批消失的单（整笔） + 本批金额变小的单（部分）
//        已开票 = 未开票线同理（消失 / 变小）
//      匹配键 = doc_no | customer_name | doc_date（实测在批次内唯一）。
//      恒等式：推定新增 − 推定回款 = 余额差（实测 5 组相邻批次全部为 0）。
//
//   ⚠️ 固有风险：「源表人工改数」会被算成回款。例如某单金额从 1 万改成 8 千（纠错），
//      这里会记成「回款 2 千」。目前实测噪声为 0，但无法根除 —— 用的时候要心里有数。
//   ⚠️ 「本批较上批」≠「今日」：同步不是每天都有（国庆断档），一天也可能跑多批
//      （同类型同日覆盖，只留最后一批）。所以返回值带 prevSnapshotDate，
//      前端必须把基准日期显示出来，否则会被读成「昨天」。
// ------------------------------------------------------------
function round2(n) {
  return Math.round(n * 100) / 100
}

router.get('/trend', async (req, res, next) => {
  try {
    const bizType = req.query.bizType
    const params = []
    let where = ''
    if (BIZ_TYPES[bizType]) {
      params.push(bizType)
      where = 'WHERE biz_type = $1'
    }

    const batches = (await query(
      `SELECT id,
              biz_type AS "bizType",
              to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate",
              row_count AS "rowCount",
              total_amount::float8 AS "totalAmount",
              source_file AS "sourceFile",
              imported_at AS "importedAt"
         FROM import_batch
         ${where}
        ORDER BY biz_type, snapshot_date, id`,
      params
    )).rows

    if (!batches.length) return res.json([])

    // 一次把涉及的明细按「批次 × 单据键」聚合出来（约 20 批 × 几百行，量很小）。
    // 不用「逐对批次各查一次」是为了避免 N+1：批次会随时间线性增长。
    const ids = batches.map((b) => b.id)
    const detail = (await query(
      `SELECT batch_id AS "batchId",
              doc_no || '|' || customer_name || '|' ||
                COALESCE(to_char(doc_date, 'YYYY-MM-DD'), '') AS k,
              SUM(amount_total)::float8 AS amt
         FROM receivable_detail
        WHERE batch_id = ANY($1::int[])
        GROUP BY 1, 2`,
      [ids]
    )).rows

    const byBatch = new Map()
    for (const d of detail) {
      if (!byBatch.has(d.batchId)) byBatch.set(d.batchId, new Map())
      byBatch.get(d.batchId).set(d.k, Number(d.amt))
    }

    // 「1个月以上」小计 = over3m + 3m + 2m + 1m（**不含当月**）
    //
    // 2026-10-13 使用者要求：「每日趋势换成按 1个月以上 统计，不要当月的，因为单月的只有上升到趋势」。
    // 原因（实测）：当月档在月内只进不出、逐日堆高，把总额的趋势盖住了 ——
    //   未回款总额 10-08 5,738,243 → 10-09 6,082,993 → 10-10 6,603,724（一路被当月顶上）
    //   而同期「1个月以上」5,733,162 → 5,592,832 → 5,566,455（才是真在降）
    // 所以趋势的**对比基准改成 1个月以上**，`flow`（回款/已开票）**保持全量口径不动**
    // （那是单据层面的进出，与账龄档无关 —— 使用者 10-13 定的）。
    const over1mByBatch = new Map(
      (await query(
        `SELECT batch_id AS "batchId",
                SUM(amount_over3m + amount_3m + amount_2m + amount_1m)::float8 AS "over1m"
           FROM receivable_detail
          WHERE batch_id = ANY($1::int[])
          GROUP BY 1`,
        [ids]
      )).rows.map((r) => [r.batchId, Number(r.over1m || 0)])
    )

    // 按业务线、按时间顺序做「相邻两批」的差
    const groups = new Map()
    for (const b of batches) {
      if (!groups.has(b.bizType)) groups.set(b.bizType, [])
      groups.get(b.bizType).push(b)
    }

    const stat = new Map() // batchId -> { flow, prevSnapshotDate, delta, deltaPct }
    for (const arr of groups.values()) {
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i]
        const s = { flow: null, prevSnapshotDate: null, delta: null, deltaPct: null }
        if (i > 0) {
          const prev = arr[i - 1]
          const pm = byBatch.get(prev.id) || new Map()
          const cm = byBatch.get(b.id) || new Map()
          let flow = 0
          for (const [k, v] of pm) {
            if (!cm.has(k)) flow += v // 整笔消失 = 已回款 / 已开票
            else if (cm.get(k) < v - 0.005) flow += v - cm.get(k) // 部分回款 / 冲减
          }
          s.flow = round2(flow)
          s.prevSnapshotDate = prev.snapshotDate
          // 环比基准 = 「1个月以上」小计，**不是**总额（见 over1mByBatch 的说明）
          const cur1m = over1mByBatch.get(b.id) || 0
          const prev1m = over1mByBatch.get(prev.id) || 0
          s.delta = round2(cur1m - prev1m)
          s.deltaPct = prev1m !== 0 ? Math.round((s.delta / prev1m) * 10000) / 100 : null
        }
        stat.set(b.id, s)
      }
    }

    // 透视：一个快照日期一行
    const byDate = new Map()
    for (const b of batches) {
      if (!byDate.has(b.snapshotDate)) byDate.set(b.snapshotDate, { snapshotDate: b.snapshotDate })
      const s = stat.get(b.id)
      byDate.get(b.snapshotDate)[b.bizType] = {
        total: round2(b.totalAmount),
        /** 「1个月以上」小计（不含当月）—— 2026-10-13 起趋势页显示与对比都用它 */
        over1m: round2(over1mByBatch.get(b.id) || 0),
        rowCount: b.rowCount,
        flow: s.flow, // 回款 / 已开票（推算值，全量口径；第一个批次没有上一批 → null）
        delta: s.delta,
        deltaPct: s.deltaPct,
        prevSnapshotDate: s.prevSnapshotDate,
        sourceFile: b.sourceFile,
        importedAt: b.importedAt,
      }
    }

    res.json([...byDate.values()].sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate)))
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
  // 用 to_char 直接取字符串：DATE → Date → toISOString 会在东八区退回一天
  const { rows } = await query(
    `SELECT to_char(MAX(snapshot_date), 'YYYY-MM-DD') AS d FROM customer_platform_unpaid`
  )
  return rows[0]?.d || null
}

// ⚠ 金额口径（2026-09-28 变更，使用者拍板）
//   源表《(客户未回款平台)未回款.xlsx》里有两个并列的金额列，含义完全不同：
//     sales_amount       销售金额     = 销售单价 × 数量     （如 259 × 20 = 5,180）
//     sales_amount_total 销售金额合计 = 导单销售金额        （如 20,170，通常大 3 倍）
//   看板原先用的是 sales_amount_total，而使用者给的对标报表（客户未回款平台金额合计
//   190.96 万）用的是 sales_amount。两者同一天同为 235 单，差 3 倍（574.78 万 vs 190.96 万）。
//   使用者 2026-09-28 明确选择「改用 sales_amount（同参考图）」，故统一到这里。
//   全部客户平台相关的 SQL 金额列都引用这个常量，避免漏改造成同一页两套口径。
const CPU_AMOUNT_COL = 'sales_amount'

/**
 * 上一期快照：用于头部「较上期 ↓ xx万」。
 *
 * 背景（2026-09-28 查明）：源表《客户未回款》按周出数，但同步每天跑，
 * 所以库里会有「同一批数据被连续抓几天、金额完全相同」的快照，也会偶尔出现
 * **口径跑偏的异常批次**。当时的实际情况：
 *   09-20 周日  261.24万 / 238 行   最早订单 2026-01-07
 *   09-21 周一  261.24万 / 238 行   （与 09-20 完全相同 = 同一批）
 *   09-22 周二  261.24万 / 238 行
 *   09-23 周三  283.34万 / 273 行   最早订单 **2024-12-26**  ← 异常批
 *   09-24 周四  190.96万 / 235 行   最早订单 2026-01-07   ← 本期
 *
 * 09-23 唯独把 2024 年的陈年订单也带了进来（比其他批次早一年多），
 * 明显是源表视图口径跑偏，不是正式期次。对标报表的「上期 261.24 万」（源表标 9月18日）
 * 也印证了这一点 —— 它跳过了 09-23。使用者 2026-09-28 确认按此处理。
 *
 * 判定规则（2026-09-29 修正，v2）：
 *   **一批数据里出现了「订单日期早于基准年」的行，即视为异常批，跳过。**
 *   基准年 = **全库最新批**里最小订单日期的年份（不是每批自己的年份！）。
 *
 * 为什么改（两次修正）：
 *   v0「最早订单比本期早 180 天以上」—— 2026-09-29 实测全库批次 gap 都是 255~635 天，
 *      **全部 > 180**，规则完全失效，只是靠 fallback 兜底才看起来能用。
 *   v1「用每批自己的最早订单年份」—— 错。09-23 那批最早订单是 2024-12-27，
 *      年份界随之退到 2024-01-01，于是它自己的跨年行数算成 0，反而没被抓出来。
 *   v2（当前）「统一用最新批的年份当基准」—— 实测精准命中：
 *      09-20/09-21/09-22/09-24/09-28  跨年行 = 0
 *      09-23                          跨年行 = 4（订单日期 2024-12-27）← 唯一被判异常的批
 *
 * 用「年份」而不是「天数」：源表按自然年出数，跨年订单一出现就说明视图口径跑偏；
 * 且基准年取自最新批，不会随被比较的批次漂移。
 */
async function getCpuPrevSnapshot(current) {
  const { rows } = await query(
    `WITH base_year AS (
       SELECT EXTRACT(YEAR FROM MIN(order_date))::int AS y
         FROM customer_platform_unpaid
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM customer_platform_unpaid)
     ),
     meta AS (
       SELECT snapshot_date,
              COUNT(*) FILTER (WHERE order_date < make_date((SELECT y FROM base_year), 1, 1))
                AS out_of_year,
              ROUND(SUM(${CPU_AMOUNT_COL})::numeric, 2) AS amount
         FROM customer_platform_unpaid
        GROUP BY snapshot_date
     ),
     -- 金额相同 = 同一批数据被重复抓，只保留最早那天
     dedup AS (
       SELECT DISTINCT ON (amount) snapshot_date, amount, out_of_year
         FROM meta
        WHERE snapshot_date < $1::date
        ORDER BY amount, snapshot_date
     ),
     -- 跨年订单数为 0 的才是正常批
     ok AS (
       SELECT snapshot_date FROM dedup
        WHERE out_of_year = 0
        ORDER BY snapshot_date DESC
        LIMIT 1
     ),
     fallback AS (
       SELECT MAX(snapshot_date) AS snapshot_date
         FROM meta WHERE snapshot_date < $1::date
     )
     SELECT to_char(COALESCE((SELECT snapshot_date FROM ok),
                             (SELECT snapshot_date FROM fallback)), 'YYYY-MM-DD') AS d`,
    [current]
  )
  return rows[0]?.d || null
}

// GET /api/customer-platform-unpaid/summary
router.get('/customer-platform-unpaid/summary', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) {
      return res.json({
        hasData: false, snapshotDate: null, total: 0, prevTotal: null, prevSnapshotDate: null,
        orderCount: 0, customerCount: 0, platformCount: 0, deltaAmount: null, deltaPct: null,
      })
    }

    // 可选按业务员过滤：给「我的业绩」页取某人自己的合计用。
    // 不传 = 全量（客户平台看板页、首页的调用方式），行为与以前完全一致。
    const salesperson = String(req.query.salesperson || '').trim()
    const spFilter = salesperson ? ' AND salesperson = $2' : ''
    const spParams = salesperson ? [snapshot, salesperson] : [snapshot]

    const { rows } = await query(
      `SELECT
         COALESCE(SUM(${CPU_AMOUNT_COL}),0) AS total,
         COUNT(*)                             AS order_count,
         COUNT(DISTINCT COALESCE(NULLIF(account_customer,''), customer_name, '未知客户')) AS customer_count,
         COUNT(DISTINCT platform)             AS platform_count
       FROM customer_platform_unpaid
      WHERE snapshot_date = $1${spFilter}`,
      spParams
    )
    const r = nums(rows[0])

    // 上一期快照（用于头部的「较上期 ↓ xx%」，参考图有这个信息）
    // 注意：上期也要套用同一个业务员过滤，否则「较上期」是拿个人比全公司
    const prev = await getCpuPrevSnapshot(snapshot)
    let prevTotal = null
    if (prev) {
      const p = await query(
        `SELECT COALESCE(SUM(${CPU_AMOUNT_COL}),0) AS total
           FROM customer_platform_unpaid WHERE snapshot_date = $1${spFilter}`,
        salesperson ? [prev, salesperson] : [prev]
      )
      prevTotal = Number(p.rows[0]?.total || 0)
    }

    const total = Number(r.total)
    const deltaAmount = prevTotal === null ? null : Math.round((total - prevTotal) * 100) / 100
    const deltaPct =
      prevTotal === null || prevTotal === 0
        ? null
        : Math.round(((total - prevTotal) / prevTotal) * 1000) / 10

    res.json({
      hasData: true,
      snapshotDate: snapshot,
      total,
      prevSnapshotDate: prev,
      prevTotal,
      deltaAmount,
      deltaPct,
      orderCount: Number(r.order_count),
      customerCount: Number(r.customer_count),
      platformCount: Number(r.platform_count),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/customer-platform-unpaid/aging  账龄分布（参考图第一张表）
//   表里没有账龄字段，用「订单日期」到「快照当月月末」的天数分档。
//   边界规则是从使用者给的参考图反推出来的，4 档金额与单数全部精确吻合：
//     基准 = 快照所在月的最后一天；age = 基准 - order_date
//     age >= 90 → 3个月以上 / >= 60 → 2个月 / >= 30 → 1个月 / 其余 → 当月
//
// 🔴 这段 CASE 2026-10-19 抽成函数：新增的「明细里的账龄列」必须与账龄分布用同一套边界，
//    两处各写一遍的话，以后改边界必然只改一处，明细和汇总就会对不上。
function cpuAgingCaseSql(ageExpr) {
  return `CASE
            WHEN ${ageExpr} >= 90 THEN '3个月以上'
            WHEN ${ageExpr} >= 60 THEN '2个月'
            WHEN ${ageExpr} >= 30 THEN '1个月'
            ELSE '当月'
          END`
}
router.get('/customer-platform-unpaid/aging', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) return res.json({ segments: [], total: 0, orderCount: 0, snapshotDate: null })

    // 可选按业务员过滤（「我的业绩」页要看这个人自己的账龄结构）。
    // 不传 = 全量，与客户平台看板页原来的行为完全一致。
    const salesperson = String(req.query.salesperson || '').trim()
    const spFilter = salesperson ? ' AND salesperson = $2' : ''
    const params = salesperson ? [snapshot, salesperson] : [snapshot]

    const { rows } = await query(
      `WITH base AS (
         SELECT (date_trunc('month', $1::date) + INTERVAL '1 month - 1 day')::date AS month_end
       ),
       x AS (
         SELECT ${CPU_AMOUNT_COL} AS amt,
                (SELECT month_end FROM base) - order_date AS age
           FROM customer_platform_unpaid
          WHERE snapshot_date = $1${spFilter}
       )
       SELECT ${cpuAgingCaseSql('age')} AS segment,
              ROUND(SUM(amt)::numeric, 2)::float8 AS total,
              COUNT(*)::int AS order_count,
              MIN(age) AS min_age
         FROM x
        GROUP BY 1
        ORDER BY MIN(age) DESC`,
      params
    )

    const segments = rows.map((r) => ({
      segment: r.segment,
      total: Number(r.total),
      orderCount: Number(r.order_count),
    }))
    res.json({
      segments,
      total: Math.round(segments.reduce((s, r) => s + r.total, 0) * 100) / 100,
      orderCount: segments.reduce((s, r) => s + r.orderCount, 0),
      snapshotDate: snapshot,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/customer-platform-unpaid/by-salesperson  按业务员汇总（参考图第二张表）
router.get('/customer-platform-unpaid/by-salesperson', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) return res.json({ rows: [], total: 0, orderCount: 0, snapshotDate: null })

    const { rows } = await query(
      `SELECT COALESCE(NULLIF(salesperson,''), '未分配') AS salesperson,
              ROUND(SUM(${CPU_AMOUNT_COL})::numeric, 2)::float8 AS total,
              COUNT(*)::int AS order_count
         FROM customer_platform_unpaid
        WHERE snapshot_date = $1
        GROUP BY 1
        ORDER BY SUM(${CPU_AMOUNT_COL}) DESC`,
      [snapshot]
    )
    const list = rows.map((r) => ({
      salesperson: r.salesperson,
      total: Number(r.total),
      orderCount: Number(r.order_count),
    }))
    res.json({
      rows: list,
      total: Math.round(list.reduce((s, r) => s + r.total, 0) * 100) / 100,
      orderCount: list.reduce((s, r) => s + r.orderCount, 0),
      snapshotDate: snapshot,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/customer-platform-unpaid/by-platform  按下单平台汇总（参考图第三张表）
router.get('/customer-platform-unpaid/by-platform', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) return res.json({ rows: [], total: 0, orderCount: 0, snapshotDate: null })

    const { rows } = await query(
      `SELECT COALESCE(NULLIF(platform,''), '未知平台') AS platform,
              ROUND(SUM(${CPU_AMOUNT_COL})::numeric, 2)::float8 AS total,
              COUNT(*)::int AS order_count
         FROM customer_platform_unpaid
        WHERE snapshot_date = $1
        GROUP BY 1
        ORDER BY SUM(${CPU_AMOUNT_COL}) DESC`,
      [snapshot]
    )
    const list = rows.map((r) => ({
      platform: r.platform,
      total: Number(r.total),
      orderCount: Number(r.order_count),
    }))
    res.json({
      rows: list,
      total: Math.round(list.reduce((s, r) => s + r.total, 0) * 100) / 100,
      orderCount: list.reduce((s, r) => s + r.orderCount, 0),
      snapshotDate: snapshot,
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
        GROUP BY platform ORDER BY SUM(${CPU_AMOUNT_COL}) DESC`,
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

// GET /api/customer-platform-unpaid/customers  客户列表（筛选用，可选按业务员过滤）
//
//   客户口径必须与明细、汇总**完全一致**：
//     COALESCE(NULLIF(account_customer,''), customer_name, '未知客户')
//   三处写法不一致的话，下拉里选出来的名字在明细里一行都过滤不到。
//   与「销售管理」线一样，传了 salesperson 就只列这个人的客户。
router.get('/customer-platform-unpaid/customers', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) return res.json({ customers: [], snapshotDate: null })

    const salesperson = String(req.query.salesperson || '').trim()
    const params = [snapshot]
    let where = 'snapshot_date = $1'
    if (salesperson) {
      params.push(salesperson)
      where += ` AND salesperson = $${params.length}`
    }

    const { rows } = await query(
      `SELECT DISTINCT COALESCE(NULLIF(account_customer,''), customer_name, '未知客户') AS name
         FROM customer_platform_unpaid
        WHERE ${where}
        ORDER BY name`,
      params
    )
    res.json({ customers: rows.map((r) => r.name), snapshotDate: snapshot })
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
         COUNT(*)::int AS order_count,
         SUM(${CPU_AMOUNT_COL})::float8 AS total
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
      snapshotDate: snapshot,
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// 客户平台明细的筛选条件（页面查询与 Excel 导出**共用**）
// ------------------------------------------------------------
function buildCpuDetailFilter(req, snapshot) {
  const { customer, platform, keyword, salesperson } = req.query
  const conditions = ['snapshot_date = $1']
  const params = [snapshot]

  if (salesperson) {
    params.push(String(salesperson).trim())
    conditions.push(`salesperson = $${params.length}`)
  }
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
  { key: 'agingCategory', label: '账龄' },
  { key: 'city', label: '地区' },
  { key: 'product', label: '商品' },
  { key: 'qty', label: '数量' },
  { key: 'amountTotal', label: '金额(元)', money: true },
  { key: 'salesperson', label: '业务员' },
  { key: 'paymentStatus', label: '回款状态' },
  { key: 'invoiceStatus', label: '开票状态' },
  { key: 'note', label: '进度反馈' },
]

/** 与 CPU_EXPORT_COLUMNS 对齐的导出查询列（列名全部带 c. 前缀，因为要 JOIN detail_note） */
const CPU_EXPORT_SELECT = `
  c.platform,
  to_char(c.order_date,'YYYY-MM-DD')                     AS "orderDate",
  c.customer_order_no                                     AS "orderNo",
  COALESCE(NULLIF(c.customer_name,''), c.account_customer, '—')  AS "customer",
  c.account_customer                                      AS "accountCustomer",
  ${cpuAgingCaseSql(
    `((date_trunc('month', c.snapshot_date::date) + INTERVAL '1 month - 1 day')::date - c.order_date)`
  )}                                                      AS "agingCategory",
  c.city,
  c.product_name                                          AS "product",
  c.qty::float8                                           AS "qty",
  ${CPU_AMOUNT_COL}::float8                               AS "amountTotal",
  c.salesperson,
  c.payment_status                                        AS "paymentStatus",
  c.invoice_status                                        AS "invoiceStatus",
  n.note                                                   AS "note"
`

// GET /api/customer-platform-unpaid/detail  订单级明细
router.get('/customer-platform-unpaid/detail', async (req, res, next) => {
  try {
    const snapshot = await getCpuLatestSnapshot()
    if (!snapshot) return res.json({ records: [], total: 0, snapshotDate: null })

    const { page = 1, pageSize = 20 } = req.query
    const { where, params } = buildCpuDetailFilter(req, snapshot)
    const countRes = await query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(${CPU_AMOUNT_COL}),0) AS total
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
         c.platform,
         to_char(c.order_date,'YYYY-MM-DD') AS "orderDate",
         c.company_name AS "company",
         c.customer_order_no AS "orderNo",
         c.customer_name AS "customerName",
         c.account_customer AS "accountCustomer",
         COALESCE(NULLIF(c.account_customer,''), c.customer_name, '') AS "customer",
         c.payment_status AS "paymentStatus",
         c.product_name AS "product",
         c.qty::float8 AS "qty",
         ${CPU_AMOUNT_COL}::float8 AS "amountTotal",
         c.salesperson,
         c.report_plan_no AS "planNo",
         c.invoice_status AS "invoiceStatus",
         c.city,
         -- 账龄（2026-10-19）：原来只有上方「我的账龄分布」卡才有账龄，明细里看不到某一单多久了。
         -- 使用者要求「把账龄放到下面的明细里」，于是每行现算一档，边界与 aging 接口共用同一个函数。
         ${cpuAgingCaseSql(
           `((date_trunc('month', c.snapshot_date::date) + INTERVAL '1 month - 1 day')::date - c.order_date)`
         )} AS "agingCategory",
         n.note AS "note"
       FROM customer_platform_unpaid c
       LEFT JOIN detail_note n
              ON n.biz_type = 'customer_platform' AND n.doc_no = c.customer_order_no
      WHERE ${where}
      ORDER BY ${CPU_AMOUNT_COL} DESC
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
      snapshotDate: snapshot,
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/export/customer-platform-detail  导出订单明细（当前筛选的全部行）
//   与 /export/detail 一致：管理员与成员都可导出
// ------------------------------------------------------------
router.get('/export/customer-platform-detail', requireRole(...CAN_EXPORT), async (req, res, next) => {
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
         FROM customer_platform_unpaid c
         LEFT JOIN detail_note n
                ON n.biz_type = 'customer_platform' AND n.doc_no = c.customer_order_no
        WHERE ${where}
        ORDER BY ${CPU_AMOUNT_COL} DESC`,
      params
    )

    const buffer = buildXlsx({
      columns: CPU_EXPORT_COLUMNS,
      rows,
      sheetName: '客户平台订单明细',
    })

    const snap = snapshot
    sendXlsx(res, buffer, safeFilename(`客户平台订单明细_${snap}_${count}行.xlsx`))
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// 系统配置（监控参数 + 各数据源快照）—— 供「系统管理」页
//   整页只给管理员，接口这一层也守住（前端隐藏菜单只是顺手的体验，不是防线）
// ------------------------------------------------------------
router.get('/system-config', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    const watcher = {
      enabled: process.env.IMPORT_WATCH_ENABLED !== 'false',
      folder: process.env.IMPORT_WATCH_FOLDER || '',
      intervalMs: Number(process.env.IMPORT_WATCH_INTERVAL) || 15000,
    }

    // 快照的来源逻辑与「同步状态」共用一份，避免两处各写一遍再跑偏
    // （曾经就因为 snapshot_date 走了 toISOString 而在东八区少一天）
    const sources = await collectSources()

    res.json({ watcher, sources })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// 数据同步（网页端「立即同步」按钮）
//   POST /api/sync          启动一次「抓云端 → 入库」（仅管理员）
//   GET  /api/sync/status   轮询进度（含滚动日志）
//   GET  /api/sync/runs     最近若干次同步记录（持久化，重启后仍在）
//
// 同步会覆盖当日快照（写库），且它的日志/记录属于运维信息，
// 因此这一组一并划给管理员。
// ------------------------------------------------------------
router.post('/sync', requireRole(ROLE_ADMIN), async (req, res, next) => {
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

router.get('/sync/status', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    const st = getSyncState()
    // 数据源快照**每次都以库为准**。
    //
    // 2026-09-29 修：原来是 `if (!st.running && st.ok && !st.sources)` 才去查库 ——
    // 也就是「只有从没查过」才刷新。一旦内存里存过一份，之后永远返回那份陈旧值。
    // 实测踩到：shipped_uninvoiced 库里是 11,379,059.66，同步面板却显示 11,422,249.15
    // （差 43,189.49），管理员会以为数据出问题。
    // 这里只查几张表的最新批次，开销很小，而这个接口是管理员低频调用的，
    // 用「实时准确」换掉「省几次查询」是划算的。
    if (!st.running) {
      try {
        st.sources = await collectSources()
      } catch {
        /* 查库失败就退回内存里的旧快照，总比没有强 */
      }
    }
    res.json(st)
  } catch (err) {
    next(err)
  }
})

/** 同步历史：持久化在 sync_run 表，后端重启也能看到 */
router.get('/sync/runs', requireRole(ROLE_ADMIN), async (req, res, next) => {
  try {
    const runs = await listSyncRuns({ limit: req.query.limit })
    res.json({ runs })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/freshness   数据新鲜度（所有角色可用）
//
// 为什么单独开一个接口，而不复用 /sync/status：
//   /sync/status 是 requireRole(ROLE_ADMIN) —— 成员本来就看不到同步详情
//   （日志、触发人、主机名等属于管理信息，不该下放）。
//   但「这份数据是不是新鲜的」是**每个看数的人都该知道**的，
//   尤其开了定时同步之后，万一定时任务挂了（凭证过期等），
//   成员在页面上必须能第一眼发现，而不是拿着旧数据做决策。
//
// 因此这里只暴露判断新鲜度所必需的三个字段，不含日志、不含触发人：
//   lastSyncAt  上次同步完成时间（ISO）
//   ok          上次是否成功
//   running     是否正在同步
// ------------------------------------------------------------
router.get('/freshness', async (req, res, next) => {
  try {
    const st = getSyncState({ withLog: false })
    res.json({
      lastSyncAt: st.finishedAt || null,
      ok: !!st.ok,
      running: !!st.running,
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/priority/actions  待处理优先级清单（只读，独立新接口）
//
// 目的：现有页面能回答「欠多少 / 压多久 / 谁的事」，但回答不了
// 「我今天先打哪个电话」。一笔 155 万和一笔 300 元的单在明细表里是平等的两行。
// 这里把「金额 × 账龄」合成一个可直接排序的风险分，输出可执行的 TOP 清单。
//
// 设计取舍：
//   - 纯只读，不改任何现有接口与表结构，不新增索引依赖。
//   - 只允许两条口径明确的数据线（已开票未回款 / 已发货未开票），
//     客户平台那条线结构不同（订单级、按周出数），本期不纳入，避免口径混用。
//   - 风险分 = 金额权重 × 账龄权重，两个权重都返回给前端，
//     便于界面上解释「为什么这条排前面」，而不是给一个黑盒数字。
// ------------------------------------------------------------
const PRIORITY_BIZ = {
  billed_unpaid: { label: '已开票未回款', table: 'receivable_detail' },
  shipped_uninvoiced: { label: '已发货未开票', table: 'receivable_detail' },
}

/** 账龄档 → 风险系数。越老越紧急；「当月」虽新但金额大也需关注 */
const AGING_WEIGHT = {
  '3个月以上': 1.0,
  '3个月': 0.75,
  '2个月': 0.55,
  '1个月': 0.35,
  '当月': 0.15,
}

/** 把库里的账龄全名（「三个月以上未回款」）归一到短档名 */
function normAging(cat) {
  const c = String(cat || '')
  if (c.includes('三个月以上')) return '3个月以上'
  if (c.includes('三个月')) return '3个月'
  if (c.includes('两个月')) return '2个月'
  if (c.includes('一个月')) return '1个月'
  return '当月'
}

router.get('/priority/actions', async (req, res, next) => {
  try {
    const bizType = PRIORITY_BIZ[req.query.bizType] ? req.query.bizType : 'billed_unpaid'
    const batch = await getLatestBatch(bizType)
    if (!batch) return res.json({ rows: [], summary: null, bizType, snapshotDate: null })

    // 筛选条件
    const filterAging = req.query.filterAging || null
    const filterSalesperson = req.query.filterSalesperson || null
    const filterKeyword = req.query.filterKeyword || null

    // 只取筛选需要的列；金额用 amount_total（该表口径，与 /summary 一致）
    let whereClause = `WHERE d.batch_id = $1`
    const params = [batch.id]
    let paramIdx = 2

    if (filterAging) {
      whereClause += ` AND d.aging_category ILIKE $${paramIdx++}`
      params.push(`%${filterAging}月%`)
    }
    if (filterSalesperson) {
      whereClause += ` AND d.salesperson = $${paramIdx++}`
      params.push(filterSalesperson)
    }
    if (filterKeyword) {
      whereClause += ` AND (d.customer_name ILIKE $${paramIdx++} OR d.doc_no ILIKE $${paramIdx++})`
      params.push(`%${filterKeyword}%`, `%${filterKeyword}%`)
    }

    const { rows } = await query(
      `SELECT d.doc_no                            AS "docNo",
              to_char(d.doc_date,'YYYY-MM-DD')    AS "docDate",
              COALESCE(d.aging_category,'未分类') AS "agingCategory",
              COALESCE(d.customer_name,'')        AS "customer",
              COALESCE(d.salesperson,'')          AS "salesperson",
              COALESCE(d.city,'')                 AS "city",
              COALESCE(d.row_system,'')           AS "rowSystem",
              COALESCE(n.note,'')                 AS "note",
              d.amount_total::float8              AS "amount"
         FROM receivable_detail d
         LEFT JOIN detail_note n
                ON n.biz_type = d.biz_type AND n.doc_no = d.doc_no
        ${whereClause}`,
      params
    )

    // 阈值：可配置，默认 1 万以下视为「小额长尾」（催收成本可能高于欠款本身）
    const smallThreshold = Number(req.query.smallThreshold) || 10000
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200)

    const enriched = rows.map((r) => {
      const aging = normAging(r.agingCategory)
      const amount = Number(r.amount) || 0
      const w = AGING_WEIGHT[aging] ?? 0.15
      // 风险分：金额(万) × 账龄系数。用「万」让数字量级更可读（155.61 × 1.0 = 155.61）
      const score = Math.round((amount / 10000) * w * 100) / 100
      return { ...r, aging, amount, agingWeight: w, score }
    })

    const all = enriched.filter((r) => r.amount > 0)
    const totalAmount = all.reduce((s, r) => s + r.amount, 0)

    // 按账龄优先排序：越老越优先（3个月以上 > 3个月 > ... > 当月）
    // 同账龄内按金额倒序，让催收优先级更清晰
    const agingOrder = { '3个月以上': 0, '3个月': 1, '2个月': 2, '1个月': 3, '当月': 4 }
    const top = [...all].sort((a, b) => {
      const diff = (agingOrder[a.aging] ?? 99) - (agingOrder[b.aging] ?? 99)
      if (diff !== 0) return diff
      return b.amount - a.amount  // 同账龄内金额大的优先
    }).slice(0, limit)

    // 大额集中度：前 N 笔占总额多少 —— 用来回答「是不是几笔就决定了全局」
    const top10 = [...all].sort((a, b) => b.amount - a.amount).slice(0, 10)
    const top10Sum = top10.reduce((s, r) => s + r.amount, 0)

    // 小额长尾：老账里那些「催了不划算」的单
    const smallOld = all.filter((r) => r.amount < smallThreshold && r.agingWeight >= 0.75)
    const smallOldSum = smallOld.reduce((s, r) => s + r.amount, 0)

    // 按业务员看「高风险集中在谁身上」
    const bySp = {}
    for (const r of all) {
      const k = r.salesperson || '未分配'
      bySp[k] = bySp[k] || { salesperson: k, amount: 0, count: 0, over3m: 0, score: 0 }
      bySp[k].amount += r.amount
      bySp[k].count += 1
      bySp[k].score += r.score
      if (r.agingWeight >= 1.0) bySp[k].over3m += r.amount
    }
    const salespersons = Object.values(bySp)
      .map((v) => ({ ...v, amount: Math.round(v.amount * 100) / 100, over3m: Math.round(v.over3m * 100) / 100, score: Math.round(v.score * 100) / 100 }))
      .sort((a, b) => b.over3m - a.over3m)

    res.json({
      bizType,
      bizLabel: PRIORITY_BIZ[bizType].label,
      snapshotDate: batch.snapshot_date,
      rows: top,
      salespersons,
      summary: {
        totalAmount: Math.round(totalAmount * 100) / 100,
        totalCount: all.length,
        top10Amount: Math.round(top10Sum * 100) / 100,
        top10Ratio: totalAmount > 0 ? Math.round((top10Sum / totalAmount) * 1000) / 10 : 0,
        smallThreshold,
        smallOldCount: smallOld.length,
        smallOldAmount: Math.round(smallOldSum * 100) / 100,
      },
    })
  } catch (err) {
    next(err)
  }
})

// ------------------------------------------------------------
// GET /api/trace  单号追溯（2026-10-12 新增，使用者要求）
//
//   为什么需要它：
//     明细页的搜索框只查**最新批**（`batch_id = 当前批`），
//     而「查一笔账」要查的往往正是**已经从源表消失**的单（结清 / 删单 / 改数 / 挪到另一条线）。
//     实测：`2026-550` 已消失 ⇒ 明细页两条线都搜不到（0 条），当时只能连数据库查。
//
//   行为：
//     · 两条业务线**都查**（使用者一般不知道单子在哪个线）
//     · 先精确匹配 doc_no；精确无结果再返回模糊候选（最多 20 个，点一下就查）
//     · 精确命中时，把该单在**全部历史批次**里的快照按日期连成时间线，
//       并标出「第一次出现 / 最后一次出现 / 当前最新批还在不在」
//   权限：只读，登录即可（与明细页同级）。
// ------------------------------------------------------------
const TRACE_MAX_CANDIDATES = 50

/** ILIKE 的通配符必须转义，否则用户输入一个 % 会把整库捞出来 */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m)
}

router.get('/trace', async (req, res, next) => {
  try {
    const raw = String(req.query.docNo ?? '').trim()
    if (!raw) return res.status(400).json({ error: '请输入单据编号' })
    if (raw.length > 60) return res.status(400).json({ error: '单据编号过长（最多 60 字）' })

    // 各业务线的当前最新批：用来判断「这单现在还在不在最新批里」
    const latest = {}
    for (const r of (await query(
      `SELECT biz_type, id, to_char(snapshot_date,'YYYY-MM-DD') AS d,
              ROW_NUMBER() OVER (PARTITION BY biz_type ORDER BY snapshot_date DESC, id DESC) AS rn
         FROM import_batch`
    )).rows) {
      if (Number(r.rn) === 1) latest[r.biz_type] = { id: r.id, date: r.d }
    }

    const { rows } = await query(
      `SELECT d.biz_type,
              d.doc_no,
              b.snapshot_date::text            AS snapshot_date,
              b.id                             AS batch_id,
              MAX(d.customer_name)             AS customer_name,
              MAX(d.salesperson)               AS salesperson,
              MAX(d.aging_category)            AS aging_category,
              MAX(d.city)                      AS city,
              MAX(d.doc_date)::text            AS doc_date,
              SUM(d.amount_total)::float8      AS amount,
              SUM(d.amount_over3m)::float8     AS over3m,
              SUM(d.amount_3m)::float8         AS m3,
              SUM(d.amount_2m)::float8         AS m2,
              SUM(d.amount_1m)::float8         AS m1,
              SUM(d.amount_current)::float8    AS cur,
              COUNT(*)::int                    AS dup_rows
         FROM receivable_detail d
         JOIN import_batch b ON b.id = d.batch_id
        WHERE (d.doc_no ILIKE $1 ESCAPE '\\' OR d.customer_name ILIKE $1 ESCAPE '\\')
        GROUP BY d.biz_type, d.doc_no, b.snapshot_date, b.id
        ORDER BY d.biz_type, b.snapshot_date, b.id
        LIMIT 2000`,
      [`%${escapeLike(raw)}%`]
    )

    const distinct = [...new Set(rows.map((r) => r.doc_no))]
    const exactDocs = distinct.filter((d) => d.toLowerCase() === raw.toLowerCase())

    // ---- 精确没中：给候选，让使用者点一下就能查 ----
    if (!exactDocs.length) {
      if (!rows.length) {
        return res.json({ query: raw, match: 'none', series: [], candidates: [], latest })
      }
      const byDoc = new Map()
      for (const r of rows) {
        const k = r.biz_type + '|' + r.doc_no
        const prev = byDoc.get(k)
        if (!prev || r.snapshot_date > prev.lastDate) {
          byDoc.set(k, {
            docNo: r.doc_no,
            bizType: r.biz_type,
            bizLabel: BIZ_TYPES[r.biz_type] || r.biz_type,
            customerName: r.customer_name,
            salesperson: r.salesperson,
            lastDate: r.snapshot_date,
            lastAmount: Number(r.amount || 0),
            inLatest: latest[r.biz_type]?.id === r.batch_id,
          })
        }
      }
      const candidates = [...byDoc.values()]
        .sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''))
        .slice(0, TRACE_MAX_CANDIDATES)
      return res.json({
        query: raw,
        match: 'fuzzy',
        series: [],
        candidates,
        candidatesTruncated: byDoc.size > candidates.length,
        candidatesTotal: byDoc.size,
        latest,
      })
    }

    // ---- 精确命中：连成时间线 ----
    const wanted = new Set(exactDocs.map((d) => d.toLowerCase()))
    const groups = new Map()
    for (const r of rows) {
      if (!wanted.has(r.doc_no.toLowerCase())) continue
      const k = r.biz_type + '|' + r.doc_no
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    }

    const series = [...groups.values()].map((pts) => {
      const first = pts[0]
      const last = pts[pts.length - 1]
      const cur = latest[first.biz_type]
      const points = pts.map((p, i) => {
        const amount = Number(p.amount || 0)
        const prevAmount = i > 0 ? Number(pts[i - 1].amount || 0) : null
        // 与上一次**出现过**的批次比 —— 同一单不会每批都出现，所以基准是「上一次出现」而不是「上一批」
        const delta = prevAmount === null ? null : Math.round((amount - prevAmount) * 100) / 100
        return {
          snapshotDate: p.snapshot_date,
          batchId: p.batch_id,
          amount: Math.round(amount * 100) / 100,
          delta,
          agingCategory: p.aging_category,
          salesperson: p.salesperson,
          customerName: p.customer_name,
          city: p.city,
          docDate: p.doc_date,
          buckets: {
            over3m: Number(p.over3m || 0), m3: Number(p.m3 || 0), m2: Number(p.m2 || 0),
            m1: Number(p.m1 || 0), cur: Number(p.cur || 0),
          },
          dupRows: p.dup_rows > 1 ? p.dup_rows : 0,
        }
      })
      return {
        bizType: first.biz_type,
        bizLabel: BIZ_TYPES[first.biz_type] || first.biz_type,
        docNo: first.doc_no,
        customerName: last.customer_name,
        salesperson: last.salesperson,
        city: last.city,
        docDate: last.doc_date,
        points,
        appearedBatches: points.length,
        firstDate: first.snapshot_date,
        lastDate: last.snapshot_date,
        inLatest: cur ? cur.id === last.batch_id : false,
        latestBatchDate: cur?.date || null,
        lastAgingCategory: last.aging_category,
      }
    })
    // 仍在最新批的排前面
    series.sort((a, b) => Number(b.inLatest) - Number(a.inLatest) || a.docNo.localeCompare(b.docNo))

    res.json({ query: raw, match: 'exact', series, candidates: [], latest })
  } catch (err) {
    next(err)
  }
})

export default router
