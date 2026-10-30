/**
 * 「当日回款」自动标注（2026-10-27 使用者「你去添加，每天都是这样」）
 *
 * 背景：首页的「当日回款」取的是「上一批有、这一批没有」的单，**不等于今天收到的钱**。
 * 实际包含四类：
 *   1. 真回款      —— 源表回款日期 = 本批日期
 *   2. 补录旧回款  —— 源表回款日期早于本批日期（业务事后补录）
 *   3. 源表删行    —— 源表里彻底没有这单了（作废/红冲，不是回款）
 *   4. 部分回款    —— 源表回款金额 < 看板消失的金额
 * 这些只能从源表判断，所以取数时 kdocs_pull.py 会导出一份 pay-info.json
 * （doc_no → 回款日期/回款金额/未回款），本模块据此生成备注写进 ledger_note。
 *
 * 规则：
 *   · 只写「当日回款」卡（card_key='pay'）
 *   · **人工备注优先**：ledger_note.source='manual' 的行永不覆盖
 *   · 备注格式：`单号 金额 性质`，同客户多单用「；」连接
 */

import fs from 'node:fs'
import path from 'node:path'
import { query } from '../db/pool.js'

const PAY_INFO_PATH = path.join(process.cwd(), 'server', '.runtime', 'pay-info.json')

/** 把跑出来的 pay-info 落库（覆盖式：每次同步全量刷新） */
export async function refreshPayInfo() {
  if (!fs.existsSync(PAY_INFO_PATH)) return { skipped: true, reason: 'no pay-info.json' }
  let data
  try {
    data = JSON.parse(fs.readFileSync(PAY_INFO_PATH, 'utf8'))
  } catch (e) {
    return { skipped: true, reason: 'bad json: ' + e.message }
  }
  const entries = Object.entries(data)
  if (!entries.length) return { skipped: true, reason: 'empty' }

  // 一次性 upsert（分批 500 条，避免参数过多）
  let done = 0
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500)
    const vals = []
    const params = []
    chunk.forEach(([doc, v], idx) => {
      const b = idx * 4
      vals.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, now())`)
      params.push(doc, v.payDate || '', Number(v.payAmt || 0), Number(v.unpaid || 0))
    })
    await query(
      `INSERT INTO pay_info (doc_no, pay_date, pay_amt, unpaid, pulled_at)
       VALUES ${vals.join(',')}
       ON CONFLICT (doc_no) DO UPDATE SET
         pay_date = EXCLUDED.pay_date, pay_amt = EXCLUDED.pay_amt,
         unpaid = EXCLUDED.unpaid, pulled_at = now()`,
      params
    )
    done += chunk.length
  }
  return { skipped: false, count: done }
}

/** 把日期字符串归一成 YYYY-MM-DD 便于比较 */
function normDate(s) {
  const t = String(s || '').trim()
  const m = t.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (!m) return ''
  return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`
}

const fmt = (n) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

/**
 * 生成并写入自动备注。返回统计信息。
 * @param {string} bizType 业务线（目前只处理 billed_unpaid）
 */
export async function autoAnnotatePayments(bizType = 'billed_unpaid') {
  if (bizType !== 'billed_unpaid') return { skipped: true, reason: 'only billed_unpaid' }

  // 1) 最近两批
  const bs = (
    await query(
      `SELECT id, to_char(snapshot_date,'YYYY-MM-DD') d
         FROM import_batch WHERE biz_type=$1 ORDER BY snapshot_date DESC, id DESC LIMIT 2`,
      [bizType]
    )
  ).rows
  if (bs.length < 2) return { skipped: true, reason: 'need 2 batches' }
  const [cur, prev] = bs

  // 2) 本批消失的单（含客户/部门，用于定位备注键）
  const removed = (
    await query(
      `SELECT p.doc_no, p.customer_name, p.department, p.amount_total::float8 amt
         FROM receivable_detail p
        WHERE p.batch_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM receivable_detail c WHERE c.batch_id = $2 AND c.doc_no = p.doc_no
          )`,
      [prev.id, cur.id]
    )
  ).rows
  if (!removed.length) return { skipped: false, groups: 0, note: 'no removed' }

  // 3) 查 pay_info
  const docs = [...new Set(removed.map((r) => r.doc_no))]
  const infos = (
    await query(
      `SELECT doc_no, pay_date, pay_amt::float8 pay_amt, unpaid::float8 unpaid
         FROM pay_info WHERE doc_no = ANY($1)`,
      [docs]
    )
  ).rows
  const infoMap = new Map(infos.map((x) => [x.doc_no, x]))

  // 4) 分类 + 按「部门 + 客户」聚合
  //   2026-10-30 使用者「这里区分一下」：真回款不用逐单列（一个客户 6 笔全是真回款，
  //   备注里塞 6 行「真回款」根本没法看），只写「正常回款 N 笔」；
  //   异常的（补录 / 删行 / 无记录 / 部分）才列单号和金额。
  const groups = new Map()
  for (const r of removed) {
    const info = infoMap.get(r.doc_no)
    let kind = ''
    let abnormal = false
    if (!info) {
      kind = '源表删行'
      abnormal = true
    } else {
      const pd = normDate(info.pay_date)
      if (!pd) {
        kind = '无回款记录'
        abnormal = true
      } else if (pd === cur.d) {
        kind = ''                              // 真回款 → 不单独列
      } else if (pd < cur.d) {
        kind = `补录 ${pd.slice(5).replace('-', '/')}`
        abnormal = true
      } else {
        kind = '回款日期异常'
        abnormal = true
      }
      // 部分回款：源表回款金额明显小于本批消失的金额
      if (abnormal && kind !== '无回款记录') {
        const diff = Number(r.amt) - Number(info.pay_amt || 0)
        if (diff > 0.01 && Number(info.pay_amt || 0) > 0) {
          kind += `（只回 ${fmt(info.pay_amt)}，差 ${fmt(diff)}）`
        }
      }
    }
    const key = `${r.department || ''}\u0000${r.customer_name || ''}`
    if (!groups.has(key)) groups.set(key, { normal: 0, normalAmt: 0, bad: [] })
    const g = groups.get(key)
    if (abnormal) g.bad.push(`${r.doc_no} ${fmt(r.amt)} ${kind}`)
    else { g.normal++; g.normalAmt += Number(r.amt) }

  }

  // 5) 写库（只覆盖 source<>'manual' 的）
  //   2026-10-30：先把本线所有 **auto** 备注清掉再重写。
  //   不清的话，昨天那批的备注会残留（同一客户今天又出现时，看到的是昨天的判断），
  //   而「当日回款」卡只反映本批，备注也必须只反映本批。人工备注（manual）不受影响。
  await query(
    `DELETE FROM ledger_note WHERE biz_type=$1 AND card_key='pay' AND source='auto'`,
    [bizType]
  )
  let written = 0
  let kept = 0
  for (const [key, g] of groups) {
    const [department, customer] = key.split('\u0000')
    const parts = []
    if (g.bad.length) parts.push(...g.bad)
    if (g.normal) parts.push(`正常回款 ${g.normal} 笔 ${fmt(g.normalAmt)}`)
    const note = parts.join('；').slice(0, 500)
    const existing = (
      await query(
        `SELECT source FROM ledger_note
          WHERE biz_type=$1 AND card_key='pay' AND department=$2 AND customer=$3`,
        [bizType, department, customer]
      )
    ).rows[0]
    if (existing && existing.source === 'manual') {
      kept++
      continue
    }
    await query(
      `INSERT INTO ledger_note (biz_type, card_key, department, customer, note, source, updated_at)
       VALUES ($1,'pay',$2,$3,$4,'auto',now())
       ON CONFLICT (biz_type, card_key, department, customer)
       DO UPDATE SET note = EXCLUDED.note, source = 'auto', updated_at = now()`,
      [bizType, department, customer, note]
    )
    written++
  }

  return { skipped: false, groups: groups.size, written, keptManual: kept, removed: removed.length, curDate: cur.d }
}
