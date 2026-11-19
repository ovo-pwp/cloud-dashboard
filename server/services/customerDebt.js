/**
 * 客户欠款 · 按产品线（2026-11-19 新增）
 *
 * 数据源：云文档里的**普通表格文件**（xlsx），不是多维表格
 *   「客户欠款-按产品线拆分.xlsx」分享链接 → https://365.kdocs.cn/l/csrYpy9APASO
 *   取数走 kdocs_pull.py 的 read_file 通道，落到
 *   桌面\应收看板-数据导出\(客户欠款-按产品线)客户欠款.xlsx
 *
 * 表结构（22 列）：左半边客户应收总表 + 右半边 9 个产品线欠款 + 业务员/备注/沟通回款进度
 *
 * 设计取舍：
 *   · 每次导入按 snapshot_date **全量替换**（这份表是手工维护的当前态，不是流水）
 *   · 保留历史快照日期 ⇒ 可回溯对比（跟 receivable_detail 一样的思路）
 *   · 「产品线合计核对」列原样入库，用于人工核对产品线拆分是否平
 */

import XLSX from 'xlsx'

const TABLE = 'customer_debt_product'

/** 业务线标识（scheduler 按它分派导入） */
export const CUSTOMER_DEBT_BIZ_TYPE = 'customer_debt'

/** 9 个产品线：源表列名 → 入库列名（前端按这套 key 展示） */
export const PRODUCT_LINES = [
  { key: 'pl_lijianjin', label: '立减金', col: '立减金' },
  { key: 'pl_marketing_gift', label: '营销礼品', col: '营销礼品' },
  { key: 'pl_activity', label: '活动策划', col: '活动策划' },
  { key: 'pl_modern_service', label: '现代服务', col: '现代服务' },
  { key: 'pl_channel', label: '渠道营销产品', col: '渠道营销产品' },
  { key: 'pl_outbound', label: '自营场外引流订单', col: '自营场外引流订单' },
  { key: 'pl_software', label: '软件', col: '软件' },
  { key: 'pl_scene', label: '场景获客', col: '场景获客' },
]

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id              serial PRIMARY KEY,
  snapshot_date   date NOT NULL,
  customer_name   text,
  contract_count  numeric(18,2),
  shipped_amount  numeric(18,2),
  uninvoiced_amount numeric(18,2),
  invoice_count   numeric(18,2),
  invoiced_amount numeric(18,2),
  paid_amount     numeric(18,2),
  unpaid_amount   numeric(18,2),
  total_receivable numeric(18,2),
  pl_lijianjin    numeric(18,2),
  pl_marketing_gift numeric(18,2),
  pl_activity     numeric(18,2),
  pl_modern_service numeric(18,2),
  pl_channel      numeric(18,2),
  pl_outbound     numeric(18,2),
  pl_software     numeric(18,2),
  pl_scene        numeric(18,2),
  pl_check        numeric(18,2),
  salesperson     text,
  dept            text,
  remark          text,
  progress_note   text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_debt_product_date ON ${TABLE} (snapshot_date);
`

/** 数字转换：空 / '-' / 非数字 → null（不要当 0，会掩盖缺失） */
function num(v) {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/[,，\s¥￥]/g, '')
  if (s === '' || s === '-' || s === '—') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function str(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * 导入客户欠款表。
 * @returns {{inserted:number, totalReceivable:number, skippedCount:number, snapshotDate:string}}
 */
export async function importCustomerDebt(pool, { xlsxPath, snapshotDate }) {
  const snapshot = snapshotDate || new Date().toISOString().slice(0, 10)

  await pool.query(CREATE_SQL)

  const wb = XLSX.readFile(xlsxPath, { cellDates: false })
  const sheetName = wb.SheetNames[0]
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null })

  const header = (rows[0] || []).map((h) => (h == null ? '' : String(h).trim()))
  const colIdx = {}
  header.forEach((h, i) => { if (h && colIdx[h] === undefined) colIdx[h] = i })
  const at = (r, name) => (colIdx[name] === undefined ? null : r[colIdx[name]])

  const dataRows = rows.slice(1).filter((r) => r && r[0] !== null && String(r[0]).trim() !== '')
  const records = []
  const skipped = []
  let totalReceivable = 0

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const lineNo = i + 2
    const customerName = str(at(r, '挂账客户'))
    if (!customerName) {
      skipped.push({ lineNo, reason: '挂账客户为空' })
      continue
    }
    const rec = {
      snapshot_date: snapshot,
      customer_name: customerName,
      contract_count: num(at(r, '合同数')),
      shipped_amount: num(at(r, '实际出库金额')),
      uninvoiced_amount: num(at(r, '已发货未开票')),
      invoice_count: num(at(r, '开票方案数')),
      invoiced_amount: num(at(r, '开票金额')),
      paid_amount: num(at(r, '回款金额')),
      unpaid_amount: num(at(r, '已开票未回款')),
      total_receivable: num(at(r, '合计应收')),
      pl_lijianjin: num(at(r, '立减金')),
      pl_marketing_gift: num(at(r, '营销礼品')),
      pl_activity: num(at(r, '活动策划')),
      pl_modern_service: num(at(r, '现代服务')),
      pl_channel: num(at(r, '渠道营销产品')),
      pl_outbound: num(at(r, '自营场外引流订单')),
      pl_software: num(at(r, '软件')),
      pl_scene: num(at(r, '场景获客')),
      pl_check: num(at(r, '产品线合计核对')),
      salesperson: str(at(r, '业务员')),
      dept: str(at(r, '部门')),
      remark: str(at(r, '备注')),
      progress_note: str(at(r, '沟通回款进度')),
    }
    totalReceivable += rec.total_receivable || 0
    records.push(rec)
  }

  if (!records.length) {
    return { inserted: 0, totalReceivable: 0, skippedCount: skipped.length, snapshotDate: snapshot }
  }

  const cols = Object.keys(records[0]).filter((c) => c !== 'snapshot_date')
  const tuples = records.map((rec, ri) => {
    const off = ri * cols.length
    const vals = cols.map((_, ci) => `$${off + ci + 2}`).join(', ')
    // 每行第一个值固定用 $1（同一批的 snapshot_date）
    return `($1, ${vals})`
  }).join(',')

  // 全量替换同一快照日期（这份表是当前态；重复导入不会堆积）
  await pool.query(`DELETE FROM ${TABLE} WHERE snapshot_date = $1`, [snapshot])
  await pool.query(
    `INSERT INTO ${TABLE} (snapshot_date, ${cols.join(', ')}) VALUES ${tuples}`,
    [snapshot, ...records.flatMap((rec) => cols.map((c) => rec[c]))]
  )

  return {
    inserted: records.length,
    totalReceivable,
    skippedCount: skipped.length,
    snapshotDate: snapshot,
  }
}
