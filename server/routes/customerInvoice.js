/**
 * 「每天开的票 / 回的款」接口
 *
 *   GET /api/customer-invoice/daily?from=&to=&salesperson=
 *       → 按天分组，每天带「开的票」和「回的款」逐笔明细
 *
 * 口径见 services/customerInvoice.js（不含财务部、退票不剔除、开票按开票日期/回款按回款日期）。
 * 鉴权由 index.js 里 /api 的中间件统一负责。
 */
import { Router } from 'express'
import { getInvoiceDaily, getLineDelta, tableReady } from '../services/customerInvoice.js'

const router = Router()

router.get('/customer-invoice/daily', async (req, res) => {
  try {
    if (!(await tableReady())) {
      return res.json({
        ready: false,
        days: [],
        summary: { days: 0, invoiceCount: 0, invoiceAmount: 0, payCount: 0, payAmount: 0 },
        salespersons: [],
        dataRange: { a: null, b: null },
      })
    }
    const { from, to, salesperson, latest } = req.query
    const data = await getInvoiceDaily({
      from: from || null,
      to: to || null,
      salesperson: salesperson || null,
      latest: latest === '1' || latest === 'true',
    })
    res.json({ ...data, ready: true })
  } catch (err) {
    console.error('[customer-invoice] 查询失败:', err.message)
    res.status(500).json({ error: '查询失败：' + err.message })
  }
})

// 本条线本批 vs 上批的差异明细（页面下面那块要与卡片环比一致）
router.get('/customer-invoice/line-delta', async (req, res) => {
  try {
    const bizType = req.query.bizType
    if (!['billed_unpaid', 'shipped_uninvoiced'].includes(bizType)) {
      return res.status(400).json({ error: 'bizType 必须是 billed_unpaid 或 shipped_uninvoiced' })
    }
    res.json(await getLineDelta({ bizType, salesperson: req.query.salesperson }))
  } catch (err) {
    console.error('[customer-invoice] 差异查询失败:', err.message)
    res.status(500).json({ error: '查询失败：' + err.message })
  }
})

export default router
