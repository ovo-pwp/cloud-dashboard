/**
 * 生成客户名归一化词典（server/db/customer-name-dict.json）
 *
 * 三份数据：
 *   names —— 人名（「机构-姓名」的最后一段 / 可识别的「姓+称呼」）
 *   orgs  —— 机构名（规范名里「-姓名」之前的部分，拆无分隔符名字时按最长前缀匹配）
 *   depts —— 部门后缀（个金、个贷、卡部…，可跟在机构后面）
 *
 * 数据来源：库里**所有历史批次** + 两张报表表 ⇒ 早期批次出现过的销售也能覆盖到。
 *
 * 用法：node server/scripts/build-customer-name-dict.mjs [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from '../db/pool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../db/customer-name-dict.json')

const DASH = /[-—–－﹣﹘―]/
/** 姓 + 称呼：「潘姐」「秦总」「阿兴行长」 */
// 只取「1 字姓 + 称呼」：取 2 字会贪心把机构字吃进来（「中行邕城霞姐」→「城霞姐」）
const TITLE_RE = /([一-龥](经理|总监|主管|行长|主任|专员|助理|老师|师傅|博士|总裁|总经理|董事长|副行长|姐|哥|叔))$/
/** 明显是机构后缀的词（不能当人名） */
const ORG_TAIL = /[部行室店司组社台中心厅队厅房院苑]$/

const r = await pool.query(`
  SELECT customer_name AS n FROM receivable_detail
  UNION SELECT customer FROM customer_recon
  UNION SELECT customer FROM customer_invoice
`)
const all = r.rows.map((x) => x.n).filter(Boolean)

const names = new Set()
const orgs = new Set()

for (const n of all) {
  const s = n.replace(/\s+/g, '').replace(/[—–－﹣﹘―]/g, '-')
  if (DASH.test(s)) {
    const segs = s.split('-').filter(Boolean)
    const last = segs.pop() || ''
    // 人名候选：最后一段
    if (last && last.length <= 6 && /^[一-龥·]+$/.test(last) && !ORG_TAIL.test(last)) names.add(last)
    // 机构候选：最后一段之前的**每一段前缀**
    const orgParts = []
    for (const seg of segs) {
      orgParts.push(seg)
      const o = orgParts.join('-')
      if (o && o.length <= 24) {
        orgs.add(o)
        const flat = orgParts.join('')
        if (flat && flat.length <= 24) orgs.add(flat)   // 去分隔符版本（源表常把分隔符省掉）
      }
    }
  } else {
    const m = s.match(TITLE_RE)
    if (m) names.add(m[1])
  }
}

// 常见部门后缀（源表里机构后面常跟一个部门，粘着人名）
const DEPTS = [
  '个金部', '个贷部', '个数部', '个人金融部', '三农金融部', '三农部', '私银部', '私人银行部',
  '财富管理部', '财富部', '零售部', '零售客户部', '卡部', '信用卡部', '公司部', '公司金融部',
  '营业部', '渠道管理部', '机构部', '办公室', '消费者部', '交易部', '电子银行部', '网银部',
  '网金部', '战略部', '特殊资产部', '团队', '战队', '网点', '个金', '个贷', '三农', '网金', '卡',
  '分行', '支行', '营业部网点',
]

const payload = {
  updatedAt: new Date().toISOString(),
  names: [...names].sort(),
  orgs: [...orgs].sort(),
  depts: DEPTS,
}
payload.count = payload.names.length

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8')
console.log(`扫描 ${all.length} 条客户名 → 人名 ${payload.names.length}、机构 ${payload.orgs.length}、部门后缀 ${DEPTS.length}`)
console.log(`✓ 已写入 ${OUT}`)
await pool.end()
process.exit(0)
