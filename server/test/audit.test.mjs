/**
 * 全量体检：接口逐个调用 + 数据交叉核对
 *
 *   npm run test:audit          （需要后端已在 3000 端口运行）
 *
 * 只读：不写任何业务数据。所有断言都拿「接口返回」与「库内真值」互相对齐，
 * 因此上游金山文档的数据变动不会让它误报，只有真正的口径漂移才会失败。
 */
import 'dotenv/config'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { query, pool } from '../db/pool.js'
import { issueLoginToken, listUsernames, listAccounts } from '../services/syncAuth.js'
import { checkExposureGuard } from '../services/exposureGuard.js'

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`
const H = { 'X-Auth-Token': issueLoginToken('4111', false) }

let ok = 0
let bad = 0
let skipped = 0

/**
 * 某些断言只在特定环境才有意义（例如「前端 dist 产物」在只跑后端的 api 容器里
 * 本来就不存在）。这类情况用 Skip 明确跳过并说明原因，而不是报成失败 ——
 * 否则部署后想在服务器上做一次体检，会看到一堆与部署无关的红叉。
 */
class Skip extends Error {}
const skip = (why) => {
  throw new Skip(why)
}

async function t(name, fn) {
  try {
    await fn()
    ok++
    console.log(`  ✔ ${name}`)
  } catch (err) {
    if (err instanceof Skip) {
      skipped++
      console.log(`  ⤼ ${name}（已跳过）\n      ${err.message}`)
      return
    }
    bad++
    console.log(`  ✖ ${name}\n      ${err.message}`)
  }
}
const req = async (p, init = {}) => {
  const r = await fetch(BASE + p, { headers: H, ...init })
  const ct = r.headers.get('content-type') || ''
  let body
  if (ct.includes('json')) {
    try { body = await r.json() } catch { body = null }
  } else if (ct.includes('spreadsheet') || ct.includes('octet-stream')) {
    body = Buffer.from(await r.arrayBuffer())
  } else body = await r.text()
  return { status: r.status, body, ct, headers: r.headers }
}
/** 按业务类型把所有分页取回来（pageSize 上限 500） */
async function detailAll(bizType) {
  const out = []
  let page = 1
  let total = 0
  for (;;) {
    const { body } = await req(`/api/detail?bizType=${bizType}&page=${page}&pageSize=500`)
    total = Number(body.total)
    out.push(...(body.records || []))
    if (out.length >= total || !(body.records || []).length) break
    page++
  }
  return { rows: out, total }
}

// ------------------------------------------------------------ A. 未登录拦截
console.log('\n=== A. 未登录一律 401（白名单除外）===')
const PRIVATE = [
  '/api/biz-types', '/api/summary', '/api/aging-by-salesperson', '/api/aging-summary',
  '/api/detail', '/api/export/detail', '/api/by-customer', '/api/filters', '/api/trend',
  '/api/warnings', '/api/login-log', '/api/login-users', '/api/system-config',
  '/api/sync/status', '/api/sync/runs',
  '/api/customer-platform-unpaid/summary', '/api/customer-platform-unpaid/platforms',
  '/api/customer-platform-unpaid/salespersons', '/api/customer-platform-unpaid/breakdown',
  '/api/customer-platform-unpaid/detail', '/api/export/customer-platform-detail',
]
await t(`${PRIVATE.length} 个业务接口无令牌 → 401`, async () => {
  const wrong = []
  for (const p of PRIVATE) {
    const r = await fetch(BASE + p)
    if (r.status !== 401) wrong.push(`${p}=${r.status}`)
  }
  assert.equal(wrong.length, 0, `未正确拦截：${wrong.join(', ')}`)
})
await t('白名单无令牌可达；未知路径未登录 401 / 登录后 404', async () => {
  assert.equal((await fetch(BASE + '/api/health')).status, 200, '/api/health 应可达')
  // /api/me 未登录时返回 401 + loggedIn:false —— 这是设计（它本身就是「我是否已登录」查询）
  const me = await fetch(BASE + '/api/me')
  assert.equal(me.status, 401, `/api/me 未登录应 401，实际 ${me.status}`)
  const meBody = await me.json()
  assert.equal(meBody.loggedIn, false)
  assert.equal(meBody.loginEnabled, true)

  assert.equal((await fetch(BASE + '/api/nope')).status, 401)
  assert.equal((await req('/api/nope')).status, 404)
})
await t('坏令牌 → 401', async () => {
  const r = await fetch(BASE + '/api/summary', { headers: { 'X-Auth-Token': 'garbage' } })
  assert.equal(r.status, 401)
})

// ------------------------------------------------------------ B. 基础与登录相关
console.log('\n=== B. 基础与登录相关 ===')
await t('GET /api/health → ok + dbTime', async () => {
  const { status, body } = await req('/api/health')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.dbTime)
})
await t('GET /api/me → 登录状态、角色与有效期', async () => {
  const { status, body } = await req('/api/me')
  assert.equal(status, 200)
  assert.equal(body.loginEnabled, true)
  assert.equal(body.loggedIn, true)
  assert.equal(body.username, '4111')
  assert.equal(body.role, 'admin', '本测试用的是管理员令牌')
  assert.equal(body.roleLabel, '管理员')
  assert.ok(body.ttlHours > 0 && body.expireAt)
})
await t('GET /api/login-users → 与配置一致（含角色、不含密码）', async () => {
  const { status, body } = await req('/api/login-users')
  assert.equal(status, 200)
  assert.deepEqual(body.accounts, listAccounts())
  for (const a of body.accounts) {
    assert.ok(['admin', 'member'].includes(a.role), `账号 ${a.username} 角色异常：${a.role}`)
  }
  // 从当前配置里把明文口令抽出来逐个搜，而不是写死某个口令 ——
  // 写死的话，换一次账号密码这条断言就自动失效了（还会一直「通过」）
  const dump = JSON.stringify(body)
  const leaks = (process.env.LOGIN_USERS || '')
    .split(',')
    .map((p) => p.trim().split('=')[1]?.split(':')[0])
    .filter(Boolean)
  for (const pw of leaks) {
    assert.ok(!dump.includes(pw), `响应里出现了明文密码（${pw.slice(0, 2)}***）`)
  }
})
await t('GET /api/login-log → 分页 + stats + accounts', async () => {
  const { status, body } = await req('/api/login-log?page=1&pageSize=5')
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.rows) && body.rows.length <= 5)
  assert.ok(body.total >= body.rows.length)
  const s = body.stats
  assert.ok(s && typeof s.ok_total === 'number' && typeof s.fail_total === 'number')
  assert.ok(s.ok_total + s.fail_total <= body.total, 'stats 与总数矛盾')
  assert.deepEqual(body.accounts, listAccounts())
  console.log(`      （累计成功 ${s.ok_total} / 失败 ${s.fail_total} / 今日成功 ${s.ok_today} / 共 ${body.total} 条）`)
})
await t('login-log 过滤生效（仅失败）', async () => {
  const { body } = await req('/api/login-log?success=0&pageSize=50')
  assert.ok(body.rows.every((r) => r.success === false), '过滤后仍有成功记录')
  const { body: b2 } = await req('/api/login-log?success=1&pageSize=50')
  assert.ok(b2.rows.every((r) => r.success === true))
})

// ------------------------------------------------------------ C. 业务接口
console.log('\n=== C. 业务接口 ===')
let bizTypes = []
await t('GET /api/biz-types → 两类型、快照日期正确', async () => {
  const { status, body } = await req('/api/biz-types')
  assert.equal(status, 200)
  bizTypes = body
  assert.equal(body.length, 2)
  // 不要硬编码快照日期：数据每天推进，写死会必然过期（这里原先是 '2026-09-21'）。
  // 改为向库要「真实的最新快照日」再比对，测试才有长期价值。
  const { rows: exp } = await query(
    `SELECT biz_type, to_char(MAX(snapshot_date),'YYYY-MM-DD') AS d
       FROM import_batch
      WHERE biz_type IN ('billed_unpaid','shipped_uninvoiced')
      GROUP BY biz_type`
  )
  const expMap = Object.fromEntries(exp.map((r) => [r.biz_type, r.d]))
  for (const b of body) {
    assert.equal(b.snapshotDate, expMap[b.bizType], `${b.bizType} 快照日期 ${b.snapshotDate}`)
    assert.ok(b.rowCount > 0 && b.totalAmount > 0)
  }
})

for (const bt of ['billed_unpaid', 'shipped_uninvoiced']) {
  let sum
  await t(`[${bt}] /summary 与批次记录一致`, async () => {
    const { status, body } = await req(`/api/summary?bizType=${bt}`)
    assert.equal(status, 200)
    sum = body
    const b = bizTypes.find((x) => x.bizType === bt)
    assert.equal(Number(body.total), Number(b.totalAmount), '汇总金额 ≠ 批次记录')
    assert.equal(Number(body.invoiceCount), Number(b.rowCount), '单据数 ≠ 批次记录')
    console.log(`      （${body.invoiceCount} 单 / ${Number(body.total).toFixed(2)}）`)
  })

  await t(`[${bt}] /aging-summary 各档合计 == 汇总`, async () => {
    const { status, body } = await req(`/api/aging-summary?bizType=${bt}`)
    assert.equal(status, 200)
    const recs = body.records
    assert.ok(Array.isArray(recs) && recs.length, '缺分档')
    const s = recs.reduce((a, r) => a + Number(r.total), 0)
    assert.ok(Math.abs(s - Number(sum.total)) < 0.05, `分档合计 ${s.toFixed(2)} ≠ 汇总 ${Number(sum.total).toFixed(2)}`)
    const docs = recs.reduce((a, r) => a + Number(r.docCount), 0)
    assert.equal(docs, Number(sum.invoiceCount), `分档单据数 ${docs} ≠ ${sum.invoiceCount}`)
    console.log(`      （${recs.length} 档：${recs.map((r) => r.category).join(' / ')}）`)
  })

  await t(`[${bt}] /aging-by-salesperson 合计 == 汇总，差额仅来自已标记的异常行`, async () => {
    const { status, body } = await req(`/api/aging-by-salesperson?bizType=${bt}`)
    assert.equal(status, 200)
    const recs = body.records
    assert.ok(Array.isArray(recs) && recs.length, '缺业务员数据')
    const s = recs.reduce((a, r) => a + Number(r.total), 0)
    assert.ok(Math.abs(s - Number(sum.total)) < 0.05, `业务员合计 ${s.toFixed(2)} ≠ 汇总 ${Number(sum.total).toFixed(2)}`)

    // 行内账龄加总与 total 的差额，必须正好等于「源表分类缺失行」的金额
    const gap = recs.reduce((a, r) => {
      const parts = ['over3m', 'm3', 'm2', 'm1', 'currentMonth'].reduce((x, k) => x + Number(r[k] || 0), 0)
      return a + (Number(r.total) - parts)
    }, 0)
    const { rows: ab } = await query(
      `SELECT COALESCE(SUM(amount_total), 0)::numeric(20,2) s, COUNT(*)::int c
         FROM receivable_detail d
        WHERE d.batch_id = (SELECT MAX(id) FROM import_batch WHERE biz_type = $1)
          AND (COALESCE(amount_over3m,0)+COALESCE(amount_3m,0)+COALESCE(amount_2m,0)
              +COALESCE(amount_1m,0)+COALESCE(amount_current,0)) <> amount_total`,
      [bt]
    )
    assert.ok(
      Math.abs(gap - Number(ab[0].s)) < 0.05,
      `差额合计 ${gap.toFixed(2)} ≠ 源表分类缺失金额 ${ab[0].s}（本应对得上）`
    )
    if (ab[0].c) console.log(`      （${recs.length} 个业务员；差额 ${gap.toFixed(2)} 全部来自 ${ab[0].c} 行分类缺失）`)
    else console.log(`      （${recs.length} 个业务员，账龄分档完全自洽）`)
  })

  await t(`[${bt}] /by-customer 合计 == 汇总，且逐户 over3m 与明细一致`, async () => {
    const { status, body } = await req(`/api/by-customer?bizType=${bt}`)
    assert.equal(status, 200)
    const recs = body.records
    assert.ok(Array.isArray(recs) && recs.length, '缺客户数据')
    const s = recs.reduce((a, r) => a + Number(r.total), 0)
    assert.ok(Math.abs(s - Number(sum.total)) < 0.05, `客户合计 ${s.toFixed(2)} ≠ 汇总 ${Number(sum.total).toFixed(2)}`)

    // 字段必须都是可解析的有限数
    const notFinite = recs.find(
      (r) => !Number.isFinite(Number(r.total)) || !Number.isFinite(Number(r.over3m))
    )
    assert.ok(!notFinite, `字段异常：${JSON.stringify(notFinite)}`)

    // ⚠️ 这里刻意**不再**断言「单档 ≤ 总额」。
    // 源表存在负数红冲行：例 个金部-孙惠琳 有 ZX-26-990 整行 -8696.27 全落在「3 个月以上」档，
    // 另有正数行 633.83 落在「2 个月」档 —— 于是 |over3m| 8696.27 > |total| 8062.44，
    // 但每行的「5 档之和 == 总额」依旧成立，聚合本身是对的。
    // 按 |单档| ≤ |总额| 去判会在这种正负混合的客户上误报（2026-09-21 在容器里误报过一次）。
    // 真正该核的是「接口按客户聚合的 over3m == 该客户明细逐行 over3m 之和」。
    const { rows } = await detailAll(bt)
    const expect = new Map()
    for (const r of rows) {
      expect.set(r.customer, (expect.get(r.customer) || 0) + Number(r.over3m || 0))
    }
    const drift = recs.find(
      (r) => Math.abs((expect.get(r.customer) || 0) - Number(r.over3m)) > 0.05
    )
    assert.ok(
      !drift,
      `客户 over3m 与明细不符：${JSON.stringify(drift)}；明细合计应为 ${expect.get(drift?.customer)}`
    )

    const neg = recs.filter((r) => Number(r.total) < 0).length
    console.log(
      `      （${recs.length} 个客户，字段：${Object.keys(recs[0]).join(',')}；其中 ${neg} 个负数净额；逐户 over3m 与明细一致）`
    )
  })

  await t(`[${bt}] /detail 全量求和 == 汇总（循环所有分页）`, async () => {
    const { rows, total } = await detailAll(bt)
    assert.equal(rows.length, total, `取回 ${rows.length} 行 ≠ total ${total}`)
    assert.equal(total, Number(sum.invoiceCount), 'total 与汇总不一致')
    const s = rows.reduce((a, r) => a + Number(r.amountTotal ?? r.total ?? 0), 0)
    assert.ok(Math.abs(s - Number(sum.total)) < 0.05, `明细合计 ${s.toFixed(2)} ≠ 汇总 ${Number(sum.total).toFixed(2)}`)

    // 分档对不上的行必须带 warning（系统要如实暴露，不能悄悄藏起来）
    const mismatch = rows.filter((r) => {
      const parts = ['over3m', 'm3', 'm2', 'm1', 'currentMonth'].reduce((a, k) => a + Number(r[k] || 0), 0)
      return Math.abs(parts - Number(r.amountTotal ?? r.total ?? 0)) > 0.05
    })
    const silent = mismatch.filter((r) => !r.warning)
    assert.equal(silent.length, 0, `有 ${silent.length} 行分档对不上却没给 warning`)
    console.log(
      `      （${rows.length} 行逐条求和 = ${s.toFixed(2)}；${mismatch.length} 行分档异常且均已标记 warning）`
    )
  })

  await t(`[${bt}] /detail 分页与排序参数可用`, async () => {
    const { body } = await req(`/api/detail?bizType=${bt}&page=2&pageSize=10&sortBy=amountTotal&sortOrder=desc`)
    assert.equal(body.records.length, 10)
    const amts = body.records.map((r) => Number(r.amountTotal ?? r.total ?? 0))
    for (let i = 1; i < amts.length; i++) {
      assert.ok(amts[i - 1] >= amts[i], '降序排序未生效')
    }
  })

  await t(`[${bt}] /trend 有快照序列且数值可解析`, async () => {
    const { status, body } = await req(`/api/trend?bizType=${bt}`)
    assert.equal(status, 200)
    const arr = Array.isArray(body) ? body : body.points || body.rows || body.records
    assert.ok(Array.isArray(arr) && arr.length, '缺趋势点')
    console.log(`      （${arr.length} 个快照日）`)
  })

  await t(`[${bt}] /warnings 条数 == 库里打标行数（异常必须被暴露）`, async () => {
    const { status, body } = await req(`/api/warnings?bizType=${bt}`)
    assert.equal(status, 200)
    assert.ok(Array.isArray(body.records), '缺 records')
    const { rows } = await query(
      `SELECT count(*)::int c FROM receivable_detail
        WHERE batch_id = (SELECT MAX(id) FROM import_batch WHERE biz_type = $1)
          AND data_warning IS NOT NULL`,
      [bt]
    )
    assert.equal(body.records.length, rows[0].c, `接口报 ${body.records.length} 条，库里 ${rows[0].c} 条`)
    for (const r of body.records) assert.ok(r.warning, '告警记录缺 warning 文案')
    console.log(`      （${body.records.length} 条告警，跳过 ${body.skippedCount} 行）`)
  })

  await t(`[${bt}] /export/detail 返回可用的 xlsx`, async () => {
    const { status, ct, headers, body } = await req(`/api/export/detail?bizType=${bt}`)
    assert.equal(status, 200)
    assert.match(ct, /spreadsheetml/)
    assert.match(headers.get('content-disposition') || '', /attachment/)
    assert.equal(body[0], 0x50, '不是 xlsx（zip）')
    assert.equal(body[1], 0x4b)
    console.log(`      （${(body.length / 1024).toFixed(0)} KB）`)
  })
}

await t('GET /api/filters → 筛选项齐全', async () => {
  const { status, body } = await req('/api/filters?bizType=billed_unpaid')
  assert.equal(status, 200)
  for (const k of ['salespeople', 'customers', 'agingCategories']) {
    assert.ok(Array.isArray(body[k]) && body[k].length, `缺少 ${k}`)
  }
  console.log(`      （业务员 ${body.salespeople.length} / 客户 ${body.customers.length} / 账龄档 ${body.agingCategories.length}）`)
})

// ------------------------------------------------------------ D. 客户平台
console.log('\n=== D. 客户平台未回款 ===')
let cpSum
let cpRows
await t('GET .../summary 合计与表内最新快照一致', async () => {
  const { status, body } = await req('/api/customer-platform-unpaid/summary')
  assert.equal(status, 200)
  cpSum = body
  const { rows } = await query(
    // 口径必须与接口一致：看板用的是「销售金额」(sales_amount = 单价×数量)，
    // 不是「销售金额合计」(sales_amount_total，约大 3 倍)。这里原先把两者搞混，
    // 断言永远失败（实测 5747757.83 vs 1909564.13 = 3.01 倍），属于测试自身口径错误。
    `SELECT count(*)::int c, sum(sales_amount)::numeric(20,2) s
       FROM customer_platform_unpaid
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM customer_platform_unpaid)`
  )
  cpRows = rows[0]
  assert.ok(Math.abs(Number(body.total) - Number(rows[0].s)) < 0.05, `接口 ${body.total} ≠ 表 ${rows[0].s}`)
  console.log(`      （${rows[0].c} 行 / ${Number(rows[0].s).toFixed(2)}）`)
})
await t('GET .../platforms 与 /salespersons 非空数组', async () => {
  const p = await req('/api/customer-platform-unpaid/platforms')
  assert.equal(p.status, 200)
  assert.ok(Array.isArray(p.body.platforms) && p.body.platforms.length, '平台列表为空')
  const s = await req('/api/customer-platform-unpaid/salespersons')
  assert.equal(s.status, 200)
  assert.ok(Array.isArray(s.body.salespersons) && s.body.salespersons.length, '业务员列表为空')
  console.log(`      （平台 ${p.body.platforms.length} 个 / 业务员 ${s.body.salespersons.length} 个）`)
})
await t('GET .../breakdown 客户合计 == 汇总，且每组平台合计自洽', async () => {
  const { status, body } = await req('/api/customer-platform-unpaid/breakdown')
  assert.equal(status, 200)
  const recs = body.records
  assert.ok(Array.isArray(recs) && recs.length, '缺 breakdown')
  const s = recs.reduce((a, r) => a + Number(r.total), 0)
  assert.ok(Math.abs(s - Number(cpSum.total)) < 0.05, `客户合计 ${s.toFixed(2)} ≠ 汇总 ${Number(cpSum.total).toFixed(2)}`)
  const badRow = recs.find((r) => {
    const parts = (r.platforms || []).reduce((a, p) => a + Number(p.total), 0)
    return Math.abs(parts - Number(r.total)) > 0.05
  })
  assert.ok(!badRow, `组内平台合计不符：${JSON.stringify(badRow)}`)
  console.log(`      （${recs.length} 组）`)
})
await t('GET .../detail 全量 238 行，求和 == 汇总', async () => {
  const all = []
  for (let page = 1; ; page++) {
    const { body } = await req(`/api/customer-platform-unpaid/detail?page=${page}&pageSize=200`)
    all.push(...(body.records || []))
    if (all.length >= Number(body.total) || !(body.records || []).length) break
  }
  assert.equal(all.length, Number(cpRows.c), `取回 ${all.length} 行 ≠ 表 ${cpRows.c}`)
  const s = all.reduce((a, r) => a + Number(r.salesAmountTotal ?? r.amountTotal ?? 0), 0)
  assert.ok(Math.abs(s - Number(cpSum.total)) < 0.05, `明细合计 ${s.toFixed(2)} ≠ 汇总 ${Number(cpSum.total).toFixed(2)}`)
  console.log(`      （${all.length} 行逐条求和 = ${s.toFixed(2)}）`)
})
await t('GET /api/export/customer-platform-detail 返回 xlsx', async () => {
  const { status, ct, body } = await req('/api/export/customer-platform-detail')
  assert.equal(status, 200)
  assert.match(ct, /spreadsheetml/)
  assert.equal(body[0], 0x50)
  console.log(`      （${(body.length / 1024).toFixed(0)} KB）`)
})

// ------------------------------------------------------------ E. 系统与同步
console.log('\n=== E. 系统与同步 ===')
await t('GET /api/system-config → watcher + 3 个数据源，日期正确', async () => {
  const { status, body } = await req('/api/system-config')
  assert.equal(status, 200)
  assert.ok(body.watcher && typeof body.watcher.enabled === 'boolean')
  assert.equal(body.sources.length, 3)
  // 同 C 段：快照日期不硬编码，向库要真实值比对
  const { rows: exp } = await query(
    `SELECT biz_type, to_char(MAX(snapshot_date),'YYYY-MM-DD') AS d
       FROM import_batch GROUP BY biz_type`
  )
  const expMap = Object.fromEntries(exp.map((r) => [r.biz_type, r.d]))
  for (const s of body.sources) {
    const want = expMap[s.key] ?? expMap[s.bizType]
    if (want) assert.equal(s.snapshotDate, want, `${s.key} 快照日期 ${s.snapshotDate}`)
    assert.ok(s.rows > 0, `${s.key} 行数为 0`)
  }
})
await t('GET /api/sync/status 字段齐全，且与 system-config 快照一致', async () => {
  const { status, body } = await req('/api/sync/status')
  assert.equal(status, 200)
  for (const k of ['running', 'step', 'log', 'sources', 'interrupted', 'runId', 'trigger', 'persistedAtBoot']) {
    assert.ok(k in body, `缺 ${k}`)
  }
  assert.equal(body.running, false)
  const cfg = (await req('/api/system-config')).body
  // 全新部署上「还没有一次成功同步」时，status.sources 是空的，
  // 此时两边没法比对，跳过而不是误报口径漂移。
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    skip('本实例尚无成功的同步记录，status.sources 为空，跳过与 system-config 的交叉比对')
  }
  assert.deepEqual(
    body.sources.map((s) => [s.key, s.snapshotDate, s.rows, Number(s.totalAmount)]),
    cfg.sources.map((s) => [s.key, s.snapshotDate, s.rows, Number(s.totalAmount)]),
    '两处快照口径不一致'
  )
})
await t('GET /api/sync/runs → 结构可解析', async () => {
  const { status, body } = await req('/api/sync/runs?limit=10')
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.runs))
  for (const r of body.runs) {
    for (const k of ['id', 'trigger', 'startedAt', 'ok', 'step', 'elapsedMs']) assert.ok(k in r, `缺 ${k}`)
  }
  console.log(`      （${body.runs.length} 条历史）`)
})

// 回归：DATE 列曾被 toISOString() 按 UTC 换算，东八区整体少一天。
// 这里把「接口暴露的快照日期」与「库里的真实 MAX(snapshot_date)」逐一对齐。
await t('快照日期全面对齐（防东八区回退一天）', async () => {
  const cpu = await query(
    `SELECT to_char(MAX(snapshot_date),'YYYY-MM-DD') d,
            COUNT(*)::int c
       FROM customer_platform_unpaid
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM customer_platform_unpaid)`
  )
  const cpuTruth = cpu.rows[0].d
  const cpuRows = cpu.rows[0].c

  const batches = await query(
    `SELECT biz_type, to_char(snapshot_date,'YYYY-MM-DD') d
       FROM import_batch b
      WHERE id = (SELECT MAX(id) FROM import_batch WHERE biz_type = b.biz_type)`
  )
  const truth = Object.fromEntries(batches.rows.map((r) => [r.biz_type, r.d]))

  const cfg = (await req('/api/system-config')).body
  const cfgMap = Object.fromEntries(cfg.sources.map((s) => [s.key, s.snapshotDate]))

  const seen = []
  const check = (label, got, want) => {
    assert.equal(got, want, `${label} 快照日期 ${got}，库内真值 ${want}`)
    seen.push(`${label}=${got}`)
  }

  // 客户平台：summary / breakdown / detail 三处必须一致
  for (const p of [
    '/api/customer-platform-unpaid/summary',
    '/api/customer-platform-unpaid/breakdown',
    '/api/customer-platform-unpaid/detail?pageSize=5',
  ]) {
    const { status, body } = await req(p)
    assert.equal(status, 200, `${p} 状态 ${status}`)
    check(p.replace('/api/customer-platform-unpaid/', 'cpu/'), body.snapshotDate, cpuTruth)
  }

  // 两个业务类型：凡暴露 snapshotDate 的接口都必须等于最新批次
  // （/by-customer 不返回该字段，前端也不需要，故不在其中）
  const DATE_ENDPOINTS = ['/api/summary', '/api/aging-summary', '/api/aging-by-salesperson', '/api/detail?pageSize=5']
  for (const bt of ['billed_unpaid', 'shipped_uninvoiced']) {
    for (const p of DATE_ENDPOINTS) {
      const { status, body } = await req(`${p}${p.includes('?') ? '&' : '?'}bizType=${bt}`)
      assert.equal(status, 200, `${bt}${p} 状态 ${status}`)
      check(`${bt}${p.split('?')[0]}`, body.snapshotDate, truth[bt])
    }
    check(`system-config/${bt}`, cfgMap[bt], truth[bt])
  }
  check('system-config/customer_platform_unpaid', cfgMap.customer_platform_unpaid, cpuTruth)

  // 最新快照的行数也要对得上，避免「取到旧快照但日期对」的反向情况
  assert.equal(cfgMap.customer_platform_unpaid, cpuTruth)
  console.log(`      （客户平台最新快照 ${cpuTruth}，${cpuRows} 行；已核对 ${seen.length} 处日期）`)
})

// 回归：Excel 里的斜杠日期（2026/9/21，月份不补零）不能少一天
await t('日期工具对 DATE / 斜杠 / 补零三种输入都稳定', async () => {
  const { toDateOnly, todayDate } = await import('../utils/date.js')
  assert.equal(toDateOnly('2026-09-21'), '2026-09-21', 'ISO 字符串')
  assert.equal(toDateOnly('2026/9/21'), '2026-09-21', '斜杠+不补零')
  assert.equal(toDateOnly('2026/09/21'), '2026-09-21', '斜杠+补零')
  assert.equal(toDateOnly('2026.9.21'), '2026-09-21', '点号分隔')
  // pg 读 DATE 列得到的是本地零点，必须还原成同一个日历日
  assert.equal(toDateOnly(new Date(2026, 8, 21)), '2026-09-21', 'DATE 列（本地零点）')
  assert.equal(toDateOnly(new Date(Date.UTC(2026, 8, 21))), '2026-09-21', 'UTC 零点')
  assert.equal(toDateOnly(''), null)
  assert.equal(toDateOnly('不是日期'), null)
  // 回归：源表出现 '1900/01/00' 这种「Excel 空日期」时必须判为无效。
  // 若原样透传成 '1900-01-00'，PostgreSQL 的 DATE 列会报 out of range，
  // 而导入是「一个文件一个事务」→ 整张表回滚（不是丢一行）。
  assert.equal(toDateOnly('1900/01/00'), null, 'Excel 空日期（日=0）')
  assert.equal(toDateOnly('1900-01-00'), null, 'Excel 空日期（短横线）')
  assert.equal(toDateOnly('2026/02/30'), null, '不存在的 2 月 30 日')
  assert.equal(toDateOnly('2026/13/01'), null, '月份越界')
  // 闰年要判对，别把合法的 2 月 29 日误杀
  assert.equal(toDateOnly('2024/02/29'), '2024-02-29', '闰年 2 月 29 日')
  assert.equal(toDateOnly('2026/02/28'), '2026-02-28', '平年 2 月 28 日')
  // 「今天」必须是本地日期：用本地字段拼，而不是 toISOString（UTC）
  const now = new Date()
  const lokal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
  assert.equal(todayDate(), lokal, 'todayDate 取的是本地日期')
})

// 回归：pg 把 BIGINT（COUNT(*)）读成**字符串**，若 SQL 里忘了 ::int，
// 接口就会回 "3" 而不是 3。前端在 el-table 上给这类列加了 sortable，
// 字符串排序会得出 "105" < "20" < "3" 的错误顺序（用户点表头就看见）。
// 约定：数值字段要么 SQL 里 ::int/::float8，要么过 nums()。
await t('数值字段类型契约：计数类字段必须是 number，不是字符串', async () => {
  // 平坦接口：records[0][key] 必须是 number
  const flat = [
    ['/api/aging-by-salesperson', 'docCount'],
    ['/api/aging-summary', 'docCount'],
    ['/api/by-customer', 'docCount'],
  ]
  const bad = []
  for (const [path, key] of flat) {
    const { status, body } = await req(path)
    assert.equal(status, 200, `${path} 状态 ${status}`)
    const recs = body.records || []
    if (!recs.length) continue
    if (typeof recs[0][key] !== 'number') {
      bad.push(`${path} 的 ${key} = ${JSON.stringify(recs[0][key])}（${typeof recs[0][key]}）`)
    }
  }

  // 嵌套接口：客户层与 platforms[] 层的 orderCount 都要是 number
  const bd = (await req('/api/customer-platform-unpaid/breakdown')).body
  const b0 = (bd.records || [])[0]
  if (b0) {
    if (typeof b0.orderCount !== 'number') {
      bad.push(`breakdown 的 records[0].orderCount = ${JSON.stringify(b0.orderCount)}`)
    }
    const p0 = (b0.platforms || [])[0]
    if (p0 && typeof p0.orderCount !== 'number') {
      bad.push(`breakdown 的 records[0].platforms[0].orderCount = ${JSON.stringify(p0.orderCount)}`)
    }
  }

  assert.equal(bad.length, 0, `应回 number 却回了字符串/undefined：\n      ${bad.join('\n      ')}`)

  // 汇总类接口的计数字段同样不许是字符串
  const s = (await req('/api/summary')).body
  for (const k of ['invoiceCount', 'customerCount', 'salespersonCount', 'warnCount', 'skippedCount']) {
    assert.equal(typeof s[k], 'number', `/api/summary 的 ${k} 是 ${typeof s[k]}`)
  }
  const cps = (await req('/api/customer-platform-unpaid/summary')).body
  for (const k of ['orderCount', 'customerCount', 'platformCount']) {
    assert.equal(typeof cps[k], 'number', `客户平台 /summary 的 ${k} 是 ${typeof cps[k]}`)
  }
  console.log('      （4 个分组接口 + 2 个汇总接口的计数字段均为 number）')
})

// ------------------------------------------------------------ F. 数据库层
console.log('\n=== F. 数据库层一致性 ===')
await t('无残留活跃同步记录（锁是干净的）', async () => {
  const { rows } = await query(`SELECT count(*)::int c FROM sync_run WHERE active`)
  assert.equal(rows[0].c, 0)
})
await t('最新批次与明细行逐一对得上', async () => {
  for (const bt of ['billed_unpaid', 'shipped_uninvoiced']) {
    const { rows } = await query(
      `SELECT b.row_count, b.total_amount,
              (SELECT count(*)::int FROM receivable_detail d WHERE d.batch_id = b.id) dc,
              (SELECT sum(amount_total)::numeric(20,2) FROM receivable_detail d WHERE d.batch_id = b.id) ds
         FROM import_batch b
        WHERE b.id = (SELECT MAX(id) FROM import_batch WHERE biz_type = $1)`,
      [bt]
    )
    const r = rows[0]
    assert.equal(Number(r.row_count), r.dc, `${bt} 批次行数 ${r.row_count} ≠ 明细 ${r.dc}`)
    assert.ok(Math.abs(Number(r.total_amount) - Number(r.ds)) < 0.05, `${bt} 金额不符`)
  }
})
await t('5 张关键表齐全', async () => {
  const { rows } = await query(
    `SELECT to_regclass('public.import_batch') a, to_regclass('public.receivable_detail') b,
            to_regclass('public.customer_platform_unpaid') c, to_regclass('public.login_log') d,
            to_regclass('public.sync_run') e`
  )
  for (const k of ['a', 'b', 'c', 'd', 'e']) assert.ok(rows[0][k], `缺表 ${k}`)
})
await t('login_log 三个索引齐全（限流依赖 ip+time）', async () => {
  const { rows } = await query(`SELECT indexname FROM pg_indexes WHERE tablename='login_log'`)
  const names = rows.map((r) => r.indexname)
  for (const n of ['idx_login_log_time', 'idx_login_log_user', 'idx_login_log_ip_time']) {
    assert.ok(names.includes(n), `缺索引 ${n}`)
  }
})
await t('sync_run 唯一部分索引还在', async () => {
  const { rows } = await query(`SELECT indexdef FROM pg_indexes WHERE indexname='uniq_sync_run_active'`)
  assert.equal(rows.length, 1)
  assert.match(rows[0].indexdef, /UNIQUE/)
})
await t('源表数据异常行已全部打标（上游问题不静默）', async () => {
  const { rows } = await query(
    `SELECT biz_type, count(*)::int c, sum(amount_total)::numeric(20,2) s
       FROM receivable_detail d
      WHERE d.batch_id IN (SELECT MAX(id) FROM import_batch GROUP BY biz_type)
        AND (COALESCE(amount_over3m,0)+COALESCE(amount_3m,0)+COALESCE(amount_2m,0)
            +COALESCE(amount_1m,0)+COALESCE(amount_current,0)) <> amount_total
      GROUP BY biz_type ORDER BY biz_type`
  )
  for (const r of rows) {
    const { rows: w } = await query(
      `SELECT count(*)::int c FROM receivable_detail
        WHERE batch_id = (SELECT MAX(id) FROM import_batch WHERE biz_type = $1)
          AND data_warning IS NOT NULL`,
      [r.biz_type]
    )
    assert.equal(r.c, w[0].c, `${r.biz_type} 有 ${r.c} 行异常但打标 ${w[0].c} 行`)
    console.log(`      （${r.biz_type}: ${r.c} 行账龄/日期异常，金额 ${Number(r.s).toFixed(2)}，已打标）`)
  }
  if (!rows.length) console.log('      （无异常行）')
})

// ------------------------------------------------------------ G. 前端产物
console.log('\n=== G. 前端产物 ===')
await t('dist 构建产物存在且包含各页面', async () => {
  // 前端产物只存在于 web 镜像（Caddy 托管 /srv）；在只跑后端的 api 容器里
  // 本来就没有 dist/，这不是缺陷。本机在项目根跑时该断言依旧严格生效。
  if (!fs.existsSync('dist/index.html')) {
    skip(`当前工作目录（${process.cwd()}）下没有 dist/ —— 前端产物由 web 镜像托管，此处不适用`)
  }
  const files = fs.readdirSync('dist/assets')
  for (const p of ['System-', 'Login-', 'Detail-', 'Home-']) {
    assert.ok(files.some((f) => f.startsWith(p)), `dist 缺 ${p} 产物`)
  }
  console.log(`      （dist/assets ${files.length} 个文件）`)
})

// ------------------------------------------------------------ H. 上公网安全闸
console.log('\n=== H. 上公网安全闸（未配账号不得对外服务）===')

await t('生产环境未配账号 → 拒绝启动', async () => {
  // 鉴权在「没有账号」时是放行的（syncAuth.js），所以漏填 LOGIN_USERS
  // 等于把真实经营数据零认证挂到公网。这里守住「必须起不来」。
  const r = checkExposureGuard({ nodeEnv: 'production', loginEnabled: false, allowAnonymous: '' })
  assert.equal(r.level, 'fatal')
  assert.match(r.message, /LOGIN_USERS/, '拒绝启动的提示里要给出具体修复动作')
})

await t('生产环境已配账号 → 放行', async () => {
  const r = checkExposureGuard({ nodeEnv: 'production', loginEnabled: true, allowAnonymous: '' })
  assert.equal(r.level, 'ok')
})

await t('逃生舱只认 true（大小写/空格宽容，但不接受 yes/1/on）', async () => {
  // 危险方向是「漏写」——那已经被默认挡死。至于写成 TRUE / True，
  // 那是明确意图，宽容处理反而更好：否则用户改了却起不来，还找不到原因。
  for (const v of ['true', 'TRUE', 'True', ' true ', 'TrUe']) {
    const r = checkExposureGuard({ nodeEnv: 'production', loginEnabled: false, allowAnonymous: v })
    assert.equal(r.level, 'warn', `ALLOW_ANONYMOUS_ACCESS=${JSON.stringify(v)} 应视为已开启`)
  }
  // 但这些都不能算「开启」——它们更像是随手写的值，不该打开闸门
  for (const v of ['false', '0', '1', 'yes', 'on', 'no', '', '  ', undefined]) {
    const r = checkExposureGuard({ nodeEnv: 'production', loginEnabled: false, allowAnonymous: v })
    assert.equal(r.level, 'fatal', `ALLOW_ANONYMOUS_ACCESS=${JSON.stringify(v)} 不该被当成已开启`)
  }
})

await t('本机非生产环境未配账号 → 仅告警不阻断', async () => {
  const r = checkExposureGuard({ nodeEnv: 'development', loginEnabled: false, allowAnonymous: '' })
  assert.equal(r.level, 'warn')
})

await t('数据库密码是 URL 安全字符（防 DATABASE_URL 被破坏）', async () => {
  // 守一个真实踩过的坑：openssl rand -base64 会产出 '/' 和 '#'，
  // 密码被拼进 postgresql://user:pass@host/db 后 pg 抛 ERR_INVALID_URL，
  // api 容器直接起不来；'%' 则会被 URL 解码，密码静默变成另一个值报认证失败。
  const raw = process.env.DATABASE_URL || ''
  if (!raw) skip('未设置 DATABASE_URL（本机直连时不经过连接串），该断言只在容器环境生效')
  const m = raw.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]*)@/)
  assert.ok(m, `DATABASE_URL 结构异常：${raw.replace(/:[^:@]*@/, ':***@')}`)
  const pw = m[2]

  // 字符集：任何环境都强制。这几个字符会破坏连接串解析，属于「一定出错」。
  for (const ch of ['/', '#', '%', '?']) {
    assert.ok(!pw.includes(ch), `数据库密码含 "${ch}"，会破坏 DATABASE_URL —— 请用 deploy/gen-env.sh 生成`)
  }

  // 长度：只在生产环境强制。本机开发库只监听 localhost，拿弱密码报红
  // 是「与部署无关的红叉」，会稀释这套体检的可信度。
  if (process.env.NODE_ENV === 'production') {
    assert.ok(pw.length >= 16, `生产环境数据库密码仅 ${pw.length} 位，不足以对抗暴力破解`)
  } else {
    console.log(`      （本机环境 ${pw.length} 位；生产环境将强制 ≥16 位）`)
  }
})

// ------------------------------------------------------------ I. 账号权限（管理员 / 成员）
console.log('\n=== I. 账号权限（管理员 / 成员）===')

const svc = await import('../services/syncAuth.js')

/**
 * 临时替换账号配置跑一段断言，无论成败都还原。
 * getUsers() 每次调用都重新读 env，所以改 process.env 就能模拟另一份配置 ——
 * 这样不必为了测「角色写错会怎样」去动真实的 .env。
 */
async function withUsers(value, fn) {
  const keys = ['LOGIN_USERS', 'LOGIN_USER', 'LOGIN_PASSWORD']
  const saved = keys.map((k) => [k, process.env[k]])
  try {
    process.env.LOGIN_USER = ''
    process.env.LOGIN_PASSWORD = ''
    process.env.LOGIN_USERS = value
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

await t('角色解析：不写角色 = 管理员（老配置升级后行为不变）', async () => {
  await withUsers('a=Aa123456:admin,b=Bb123456:member,c=Cc123456', async () => {
    assert.deepEqual(svc.listAccounts(), [
      { username: 'a', role: 'admin' },
      { username: 'b', role: 'member' },
      { username: 'c', role: 'admin' },
    ])
    assert.deepEqual(svc.listUsernames(), ['a', 'b', 'c'])
  })
})

await t('角色解析：旧名 viewer 当作 member（老 .env 不会「登不上」）', async () => {
  await withUsers('a=Aa123456:viewer', async () => {
    assert.deepEqual(svc.listAccounts(), [{ username: 'a', role: 'member' }])
    assert.deepEqual(svc.verifyLogin('a', 'Aa123456'), { ok: true, role: 'member' })
  })
})

await t('角色解析：密码含冒号不误切、角色名写错不会悄悄换角色', async () => {
  await withUsers('d=pa:ss:member,e=ef:viewerr,f=gg:', async () => {
    assert.deepEqual(svc.listAccounts(), [
      { username: 'd', role: 'member' }, // 从末尾切，密码是 pa:ss
      { username: 'e', role: 'admin' }, // viewerr 不是已知角色 → 整串都算密码
      { username: 'f', role: 'admin' }, // 尾部多打一个冒号，忽略即可
    ])
    assert.equal(svc.verifyLogin('d', 'pa:ss').ok, true, '密码含冒号时应能正常登录')
    assert.equal(svc.verifyLogin('e', 'ef:viewerr').ok, true, '角色名写错时整串都是密码')
    assert.equal(svc.verifyLogin('e', 'ef').ok, false, '不能只认冒号前那半截（否则记的密码不是真密码）')
  })
})

await t('verifyLogin 带回角色；查不到的账号按最小权限兜底', async () => {
  await withUsers('a=Aa123456:member', async () => {
    assert.deepEqual(svc.verifyLogin('a', 'Aa123456'), { ok: true, role: 'member' })
    assert.equal(svc.verifyLogin('a', 'wrong').ok, false)
    assert.equal(svc.getUserRole('a'), 'member')
    assert.equal(svc.getUserRole('查无此人'), 'member', '查不到就按最小权限兜底，不能默认给管理员')
  })
  // 一个账号都没配时整站开放，角色没有意义，按管理员对待
  await withUsers('', async () => {
    assert.equal(svc.isLoginEnabled(), false)
    assert.equal(svc.getUserRole('任何人'), 'admin')
  })
})

await t('角色以「当前配置」为准：降权立即生效，不必等令牌过期', async () => {
  await withUsers('x=Xx123456:admin', async () => {
    const token = svc.issueLoginToken('x', false)
    assert.equal(svc.verifyLoginToken(token).role, 'admin')
    // 同一个人被降成成员：**不重新签发**，他手里的旧令牌应当当场变成 member
    process.env.LOGIN_USERS = 'x=Xx123456:member'
    assert.equal(
      svc.verifyLoginToken(token).role,
      'member',
      '旧令牌还带着 admin —— 那样改配置后要等 12 小时（记住我 7 天）才生效，等于改不动'
    )
  })
})

await t('账号被删后旧令牌当场失效（签名密钥绑定了密码）', async () => {
  await withUsers('y=Yy123456:admin', async () => {
    const token = svc.issueLoginToken('y', false)
    assert.ok(svc.verifyLoginToken(token))
    process.env.LOGIN_USERS = 'z=Zz123456:admin'
    assert.equal(svc.verifyLoginToken(token), null)
  })
})

await t('requireRole：管理员放行、成员 403、坏令牌 401、未配账号一律放行', async () => {
  await withUsers('a=Aa123456:admin,v=Vv123456:member', async () => {
    const guard = svc.requireRole(svc.ROLE_ADMIN)
    const call = (token) => {
      const res = {
        statusCode: 0,
        body: null,
        status(c) {
          this.statusCode = c
          return this
        },
        json(b) {
          this.body = b
          return this
        },
      }
      let passed = false
      guard({ get: (n) => (n === 'X-Auth-Token' ? token : ''), query: {} }, res, () => {
        passed = true
      })
      return { passed, res }
    }

    const adminCall = call(svc.issueLoginToken('a', false))
    assert.equal(adminCall.passed, true)
    assert.equal(adminCall.res.statusCode, 0, '放行时不该写任何响应')

    const memberCall = call(svc.issueLoginToken('v', false))
    assert.equal(memberCall.passed, false)
    assert.equal(memberCall.res.statusCode, 403)
    assert.equal(
      memberCall.res.body.code,
      'FORBIDDEN',
      '必须是 403：401 会被前端当成登录过期，把人踢回登录页'
    )
    assert.ok(memberCall.res.body.error.includes('成员'), `提示要说清原因：${memberCall.res.body.error}`)

    const bad = call('garbage')
    assert.equal(bad.passed, false)
    assert.equal(bad.res.statusCode, 401)
  })

  // 未配置登录账号：整站本来就对所有人开放，角色限制再把人挡住只会像「功能坏了」
  await withUsers('', async () => {
    let passed = false
    svc.requireRole(svc.ROLE_ADMIN)({ get: () => '', query: {} }, {}, () => {
      passed = true
    })
    assert.equal(passed, true)
  })
})

await t('权限分组：导出 / 改明细含成员，同步与系统管理仍只有管理员', async () => {
  assert.deepEqual(svc.CAN_EXPORT, ['admin', 'member'])
  assert.deepEqual(svc.CAN_EDIT_DETAIL, ['admin', 'member'])
  assert.deepEqual(svc.CAN_ADMIN, ['admin'])
  assert.ok(svc.CAN_EXPORT.includes(svc.ROLE_MEMBER), '成员应当能导出')
  assert.ok(svc.CAN_EDIT_DETAIL.includes(svc.ROLE_MEMBER), '成员应当能改备注 / 人工提醒')
  assert.ok(!svc.CAN_ADMIN.includes(svc.ROLE_MEMBER), '成员不该能同步 / 进系统管理')
  // 两组目前内容相同，但**是分开的常量**：收紧其中一个不该连带影响另一个
  assert.notEqual(svc.CAN_EXPORT, svc.CAN_EDIT_DETAIL, '必须是两个独立数组，不能是同一个引用')
  assert.equal(svc.normalizeRole('member'), 'member')
  assert.equal(svc.normalizeRole('viewer'), 'member', '旧名仍映射到成员')
  assert.equal(svc.normalizeRole('ADMIN'), 'admin', '大小写不敏感')
  assert.equal(svc.normalizeRole('viewerr'), null, '写错的名字不能被猜成某个角色')
})

// 以下几条打的是真实 HTTP（用真实 .env 里的账号签发令牌），
// 守的是「界面藏了按钮，但接口其实没拦」这类最危险的假安全。
const memberAccount = listAccounts().find((a) => a.role === 'member')

await t('真实请求：成员账号打管理类接口 → 全部 403（而不是 401）', async () => {
  if (!memberAccount) skip('本实例未配置 member 账号 —— 部署时用 ./gen-env.sh -u 管理员名 -v 成员名 建一个')
  const headers = { 'X-Auth-Token': issueLoginToken(memberAccount.username, false) }
  const ADMIN_ONLY = [
    '/api/system-config',
    '/api/login-log?pageSize=1',
    '/api/login-users',
    '/api/sync/status',
    '/api/sync/runs?limit=1',
  ]
  const wrong = []
  for (const p of ADMIN_ONLY) {
    const r = await fetch(BASE + p, { headers })
    if (r.status !== 403) {
      wrong.push(`${p}=${r.status}`)
      continue
    }
    const b = await r.json().catch(() => ({}))
    if (b.code !== 'FORBIDDEN') wrong.push(`${p} code=${b.code}`)
  }
  // 同步是写操作：成员必须被挡在「启动任务」之前
  const sync = await fetch(BASE + '/api/sync', { method: 'POST', headers })
  if (sync.status !== 403) wrong.push(`POST /api/sync=${sync.status}`)

  assert.equal(wrong.length, 0, `未正确拦截：${wrong.join(', ')}`)
  console.log(`      （已拦下 ${ADMIN_ONLY.length + 1} 个管理类接口）`)
})

await t('真实请求：成员账号能改备注 / 人工提醒 → 不是 403（且不写任何数据）', async () => {
  if (!memberAccount) skip('本实例未配置 member 账号')
  const headers = {
    'X-Auth-Token': issueLoginToken(memberAccount.username, false),
    'Content-Type': 'application/json',
  }

  // 用 id=0 探路：**故意给一个不存在的 id**，让请求在参数校验处就返回 400，
  // 从而只验证「权限闸放行了」，不会真的 UPDATE 任何一行。
  // （体检脚本的底线是「不写业务数据」，随手拿真实 id 去改会把人家填的内容覆盖掉）
  for (const [path, field] of [
    ['/api/detail/note', 'note'],
    ['/api/detail/reminder', 'reminder'],
  ]) {
    const r = await fetch(BASE + path, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ id: 0, [field]: '权限探测，不应落库' }),
    })
    const body = await r.json().catch(() => ({}))
    assert.notEqual(r.status, 403, `${path}：成员被拒了（403）—— 本该放行`)
    assert.notEqual(body.code, 'FORBIDDEN', `${path}：不能是 FORBIDDEN`)
    assert.equal(r.status, 400, `${path}：期望 400（id 非法），实际 ${r.status} —— 若为 200 说明真的写库了`)
  }
  console.log('      （成员可达 /api/detail/note 与 /api/detail/reminder，且都未落库）')
})

await t('明细接口带 reminder 字段，且它与系统告警 warning 是两回事', async () => {
  // 注意：H 用的是管理员令牌（见文件顶部），而「未配账号」时整站开放同样放行
  const { status, body } = await req('/api/detail?bizType=billed_unpaid&pageSize=1')
  assert.equal(status, 200)
  const row = (body.records || [])[0]
  assert.ok(row, '至少有一条明细')
  assert.ok('reminder' in row, '明细里必须带 reminder（前端提醒列要读它）')
  assert.ok('warning' in row, '明细里仍要带 warning（系统自动的数据质量提示）')
  // 字段能为空，但不能是 undefined —— undefined 会让前端 {{ row.reminder || '—' }} 也显示 '—'，
  // 于是「接口没返回」和「确实为空」看起来一样，出问题很难查
  assert.ok(
    row.reminder === null || typeof row.reminder === 'string',
    `reminder 应为 null 或字符串，实际 ${JSON.stringify(row.reminder)}`
  )
})

await t('真实请求：成员账号导出 Excel → 可达（200/404，不能是 403）', async () => {
  if (!memberAccount) skip('本实例未配置 member 账号')
  const headers = { 'X-Auth-Token': issueLoginToken(memberAccount.username, false) }
  for (const p of [
    '/api/export/detail?bizType=billed_unpaid',
    '/api/export/customer-platform-detail',
  ]) {
    const r = await fetch(BASE + p, { headers })
    assert.notEqual(r.status, 403, `${p} 返回 403 —— 成员本该能导出`)
    assert.ok(
      r.status === 200 || r.status === 404,
      `${p} 状态 ${r.status}（200=有数据可导，404=暂无可导数据，都不该是 403）`
    )
  }
  console.log('      （导出的两个接口成员可达）')
})

await t('真实请求：成员账号看数据一切正常', async () => {
  if (!memberAccount) skip('本实例未配置 member 账号')
  const headers = { 'X-Auth-Token': issueLoginToken(memberAccount.username, false) }

  const me = await fetch(`${BASE}/api/me`, { headers })
  const meBody = await me.json()
  assert.equal(meBody.role, 'member')
  assert.equal(meBody.roleLabel, '成员')

  const READABLE = [
    '/api/biz-types',
    '/api/summary?bizType=billed_unpaid',
    '/api/detail?bizType=billed_unpaid&pageSize=1',
    '/api/aging-summary?bizType=billed_unpaid',
    '/api/by-customer?bizType=billed_unpaid',
    '/api/customer-platform-unpaid/summary',
    '/api/customer-platform-unpaid/detail?pageSize=1',
  ]
  for (const p of READABLE) {
    const r = await fetch(BASE + p, { headers })
    assert.equal(r.status, 200, `${p} 状态 ${r.status} —— 成员账号应当能看数据`)
  }
  console.log(`      （${READABLE.length} 个普通接口全部 200）`)
})

await t('真实请求：管理员账号管理类接口可达（403 只针对成员）', async () => {
  const adminAcc = listAccounts().find((a) => a.role === 'admin')
  if (!adminAcc) skip('本实例未配置 admin 账号')
  const headers = { 'X-Auth-Token': issueLoginToken(adminAcc.username, false) }
  for (const p of [
    '/api/system-config',
    '/api/login-log?pageSize=1',
    '/api/login-users',
    '/api/sync/status',
  ]) {
    const r = await fetch(BASE + p, { headers })
    assert.equal(r.status, 200, `${p} 状态 ${r.status}`)
  }
})

console.log(`\n通过 ${ok} 项，失败 ${bad} 项${skipped ? `，跳过 ${skipped} 项` : ''}\n`)
await pool.end()
process.exit(bad ? 1 : 0)
