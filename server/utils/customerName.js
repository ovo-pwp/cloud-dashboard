/**
 * 客户名规范化（2026-11-19）
 *
 * 源表客户名写法五花八门：
 *   「个金部—陶俊元」                破折号混用
 *   「中行南宁分行李源」             机构和人名连写
 *   「中行-防城港分行-个金部卢玉莲」  分隔符只写了一半
 *   「一个金部-沈洋」                部门名写错（一个 → 个）
 *   「杭州平安 施总」                 中间多个空格
 *
 * 归一目标：统一成「机构-部门-姓名」，半角减号分隔。
 *
 * ⚠️ 原则：**宁可少改也不串客户**——拆出来的「人名」必须通过校验才落刀。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DICT_FILE = path.resolve(__dirname, '../db/customer-name-dict.json')

let _dict = null

export function loadNameDict() {
  if (_dict) return _dict
  try {
    const raw = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'))
    _dict = {
      names: new Set(raw.names || []),
      orgs: (raw.orgs || []).slice().sort((a, b) => b.length - a.length),
      depts: (raw.depts || []).slice().sort((a, b) => b.length - a.length),
    }
  } catch (e) {
    console.warn('[customerName] 词典读取失败（只做基础清洗）:', e.message)
    _dict = { names: new Set(), orgs: [], depts: [] }
  }
  return _dict
}

export function setNameDict(d) {
  _dict = {
    names: new Set(d.names || []),
    orgs: (d.orgs || []).slice().sort((a, b) => b.length - a.length),
    depts: (d.depts || []).slice().sort((a, b) => b.length - a.length),
  }
  return _dict
}

const DASHES = /[—–－﹣﹘―]/g

const TYPO_FIX = [
  [/一个金部/g, '个金部'],
  [/一个公司部/g, '个公司部'],
  [/一个数部/g, '个数部'],
]

/** 机构/部门用字：这些字结尾的词组不可能是人名 */
const ORG_CHAR = /[行部室处司店组社网点城郊县区乡所大院客业财]/

/** 称呼（人名可包含的前缀/后缀） */
const TITLES = [
  '副行长', '总经理', '董事长', '副经理', '经理助理', '总监助理',
  '经理', '总监', '主管', '行长', '主任', '专员', '助理', '老师', '师傅', '博士', '总裁',
  '姐', '哥', '叔', '总',
]

/** 常见姓氏：用于「姓 + 2~3 字」的弱校验 */
const SURNAMES = new Set(
  ('李王张刘陈杨黄赵吴周徐孙马朱胡林郭何高罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤').split('')
)

/** 机构后缀：用来定位「机构」在哪里结束 */
const ORG_SUFFIXES = [
  '分行营业部', '营业部网点', '支行营业部',
  '分行', '支行', '区分行', '总行', '营业部', '公司部', '个金部', '个贷部', '个数部',
  '个人金融部', '三农金融部', '三农部', '私银部', '私人银行部', '财富管理部', '财富部',
  '零售部', '零售客户部', '信用卡部', '卡部', '渠道管理部', '机构部', '办公室', '消费者部',
  '交易部', '电子银行部', '网银部', '网金部', '战略部', '特殊资产部', '网点', '团队', '战队',
  '部', '室', '处', '科',
].sort((a, b) => b.length - a.length)

/** 部门简称（可跟在机构后面，源表里常常省了「部」） */
const DEPT_SHORT = ['个金', '个贷', '个数', '三农', '私银', '财富', '零售', '卡', '网金']

/**
 * 人名校验：够不够像一个人名
 * @param strict true=必须整段就是人名（用于「机构切完剩下的」这种已定边界的场合）；
 *               false=允许「以称呼结尾」（如「阿兴行长」「陈经理」）
 */
function looksLikePerson(name, dict, strict = false) {
  if (!name || name.length < 2 || name.length > 5) return false
  if (!/^[一-龥·]+$/.test(name)) return false
  if (dict.names.has(name)) return true
  if (!strict && TITLES.some((t) => name.endsWith(t))) return true
  if (name.length >= 2 && name.length <= 3 && SURNAMES.has(name[0])) return true
  return false
}

/** 机构是否「像机构」：以机构后缀结尾，或能在机构词表里找到 */
function orgLooksValid(org, dict) {
  if (!org) return false
  if (ORG_SUFFIXES.some((s) => org.endsWith(s))) return true
  return dict.orgs.includes(org) || dict.orgs.some((o) => o.startsWith(org))
}

/** 从右往左找机构后缀的边界 */
function findOrgBoundary(text) {
  for (let i = text.length - 1; i >= 0; i--) {
    const tail = text.slice(i)
    for (const s of ORG_SUFFIXES) {
      if (tail.startsWith(s)) {
        return { org: text.slice(0, i + s.length), rest: text.slice(i + s.length) }
      }
    }
  }
  return null
}

/** 用「称呼」切分：阿兴行长 / 霞姐 / 陈经理 */
function splitByTitle(text, dict) {
  for (const t of TITLES) {
    if (!text.endsWith(t) || text.length <= t.length) continue
    const rest = text.slice(0, text.length - t.length)
    // 先试 2 字名（「阿兴行长」），机构不合法再退到 1 字（「杭州平安施总」→「杭州平安-施总」）
    for (const n of [2, 1]) {
      if (rest.length < n) continue
      const person = rest.slice(rest.length - n)
      if (ORG_CHAR.test(person[0])) continue             // 首字是机构字（「城霞姐」的「城」、「行娟姐」的「行」）
      const org = rest.slice(0, rest.length - n)
      if (!org) continue
      if (!orgLooksValid(org, dict)) continue
      return { person: person + t, org }
    }
  }
  return null
}

/** 人名词典尾部唯一匹配 */
function splitByDict(text, dict) {
  const cands = []
  for (const n of dict.names) {
    if (n.length >= 2 && n.length <= 5 && text.endsWith(n)) cands.push(n)
  }
  if (!cands.length) return null
  cands.sort((a, b) => b.length - a.length)
  if (cands.length > 1 && cands[0].length === cands[1].length) return null
  const person = cands[0]
  const org = text.slice(0, text.length - person.length)
  return org ? { person, org } : null
}

/**
 * 尝试把一段文字拆成「机构 + 人名」。
 * 顺序：机构后缀定位 → 机构词表 → 称呼切分 → 词典尾部
 */
function trySplit(text, dict) {
  if (!text) return null

  // 1) 机构后缀定位（最可靠：分行/部/室 这些是硬边界）
  const b = findOrgBoundary(text)
  if (b && b.rest) {
    // 先剥部门简称：「中行南宁分行个金潘姐」→ 机构带个金、人名潘姐
    for (const dep of DEPT_SHORT) {
      if (b.rest.startsWith(dep)) {
        const p = b.rest.slice(dep.length)
        if (looksLikePerson(p, dict)) return { org: b.org + dep, person: p, how: 'suffix+dept' }
      }
    }
    if (looksLikePerson(b.rest, dict)) return { org: b.org, person: b.rest, how: 'suffix' }
  }

  // 2) 称呼切分（「…霞姐」「…陈经理」）
  const t = splitByTitle(text, dict)
  if (t) return { org: t.org, person: t.person, how: 'title' }

  // 3) 机构词表最长前缀（rest 必须是**整段人名**，否则宁可不动）
  for (const o of dict.orgs) {
    if (!text.startsWith(o)) continue
    const rest = text.slice(o.length)
    if (!rest) continue
    for (const dep of DEPT_SHORT) {
      if (rest.startsWith(dep)) {
        const p = rest.slice(dep.length)
        if (looksLikePerson(p, dict, true)) return { org: o + dep, person: p, how: 'org-dict+dept' }
      }
    }
    if (looksLikePerson(rest, dict, true)) return { org: o, person: rest, how: 'org-dict' }
  }

  // 4) 词典尾部唯一匹配（org 也必须像机构，否则整段当作「机构+人名」不安全）
  const d = splitByDict(text, dict)
  if (d && orgLooksValid(d.org, dict)) return { org: d.org, person: d.person, how: 'name-dict' }

  return null
}

const _cache = new Map()

/**
 * 规范化一个客户名。
 * @returns {{name:string, changed:boolean, rule:string|null}}
 */
export function normalizeCustomerName(raw, dict = null) {
  if (raw === null || raw === undefined) return { name: raw, changed: false, rule: null }
  const orig = String(raw)
  // 同名反复出现（一次导入几千行），缓存一下省掉重复的正则开销
  if (!dict && _cache.has(orig)) return _cache.get(orig)

  let s = orig.trim()
  if (!s) return { name: orig, changed: false, rule: null }

  // ── 1. 清洗 ───────────────────────────────────────────
  s = s.replace(/[\u3000]/g, ' ').replace(/\s+/g, '')
  s = s.replace(DASHES, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')

  // ── 2. 明显错别字 ─────────────────────────────────────
  for (const [re, to] of TYPO_FIX) s = s.replace(re, to)

  // ── 3. 补分隔符 ───────────────────────────────────────
  const d = dict || loadNameDict()
  let rule = null
  const parts = s.split('-').filter(Boolean)

  if (parts.length) {
    const last = parts[parts.length - 1]
    const hit = trySplit(last, d)
    if (hit && hit.person !== last) {
      parts[parts.length - 1] = hit.org
      parts.push(hit.person)
      rule = hit.how
    }
    s = parts.filter(Boolean).join('-')
  } else {
    const hit = trySplit(s, d)
    if (hit) {
      s = hit.org + '-' + hit.person
      rule = hit.how
    }
  }

  // ── 4. 收尾 ───────────────────────────────────────────
  s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')

  const out = { name: s, changed: s !== orig, rule: s !== orig ? rule || 'clean' : null }
  if (!dict) _cache.set(orig, out)
  return out
}

export function normalizeCustomerNames(list, dict = null) {
  return list.map((n) => normalizeCustomerName(n, dict))
}
