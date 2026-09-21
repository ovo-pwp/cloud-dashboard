/**
 * Excel 导出
 *
 * 说明：这里用的是项目已有的 SheetJS 社区版（xlsx 0.18.5）。
 *   社区版**支持**：数字格式（千分位/两位小数）、列宽、自动筛选。
 *   社区版**不支持**：字体加粗、底色等单元格样式（那是 Pro 功能）。
 * 因此导出的表格靠「列宽 + 金额格式 + 自动筛选」保证可读性，
 * 不追求视觉花哨 —— 反正同事拿到多半是再做透视或二次加工。
 */
import XLSX from 'xlsx'

const MONEY_FMT = '#,##0.00'
const MAX_COL_WIDTH = 50

/** 估算显示宽度：中日韩字符按 2 个宽度计 */
function visualLen(s) {
  let n = 0
  for (const ch of String(s)) {
    n += /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1
  }
  return n
}

/**
 * 生成 xlsx Buffer。
 *
 * @param {object} opts
 * @param {Array<{key:string,label:string,money?:boolean,width?:number}>} opts.columns
 *        列定义。money=true 的列会写成数字并套千分位格式，且参与合计。
 * @param {Array<object>} opts.rows 数据行
 * @param {string} [opts.sheetName] 工作表名
 * @returns {Buffer}
 */
export function buildXlsx({ columns, rows, sheetName = '明细' }) {
  const header = columns.map((c) => c.label)

  const body = rows.map((r) =>
    columns.map((c) => {
      const v = r[c.key]
      if (c.money) {
        const n = Number(v)
        return Number.isFinite(n) ? n : 0
      }
      return v === null || v === undefined ? '' : v
    })
  )

  // 合计行：首列写「合计」，金额列求和，其余留空
  const totalRow = columns.map((c, i) => {
    if (i === 0) return '合计'
    if (!c.money) return ''
    let sum = 0
    for (const r of rows) {
      const n = Number(r[c.key])
      if (Number.isFinite(n)) sum += n
    }
    return Math.round(sum * 100) / 100
  })

  const aoa = [header, ...body, totalRow]
  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // 金额列套千分位两位小数
  // 注意：SheetJS 读回文件时只还原格式化后的文本（cell.w），不会重建 cell.z，
  //      所以校验格式是否正确要看 w（如 "1,234.50"），而不是 z。
  const moneyCols = []
  columns.forEach((c, i) => {
    if (c.money) moneyCols.push(i)
  })
  for (let r = 1; r <= rows.length + 1; r++) {
    for (const ci of moneyCols) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: ci })]
      if (cell && cell.t === 'n') cell.z = MONEY_FMT
    }
  }

  // 列宽：取「表头 vs 数据」的较大视觉宽度
  ws['!cols'] = columns.map((c) => {
    let w = visualLen(c.label)
    for (let i = 0; i < Math.min(rows.length, 200); i++) {
      const v = rows[i][c.key]
      const len = c.money ? 14 : visualLen(v ?? '')
      if (len > w) w = len
    }
    return { wch: c.width || Math.min(MAX_COL_WIDTH, Math.max(8, w + 2)) }
  })

  // 表头开启自动筛选；范围**不含合计行**，否则合计会被一起筛掉
  if (rows.length > 0) {
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: rows.length, c: columns.length - 1 },
      }),
    }
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/**
 * 把 xlsx 作为附件发给前端。
 * 同时给出 ASCII 兜底名与 RFC 5987 的 UTF-8 名，兼容各浏览器。
 */
export function sendXlsx(res, buffer, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_')
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  )
  res.setHeader('Content-Length', buffer.length)
  res.setHeader('Cache-Control', 'no-store')
  res.end(buffer)
}

/** 导出文件名里不能出现的字符统一替换掉 */
export function safeFilename(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
}
