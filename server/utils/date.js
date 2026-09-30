/**
 * 日期工具：统一「只有日期、没有时间」的口径
 *
 * 背景：本项目大量使用 DATE 列做「每日快照」。这类值一旦经过
 * `new Date(x).toISOString()` 就会按 UTC 换算，在东八区（+08:00）整体退回一天：
 *
 *   snapshot_date = 2026-09-21（DATE 列，pg 返回本地零点）
 *   new Date('2026-09-21T00:00:00+08:00').toISOString()  → '2026-09-20T16:00:00.000Z'
 *   .slice(0,10)                                          → '2026-09-20'  ✗
 *
 * 这个 bug 本项目已经踩过一次。约定：
 *   1. 能从 SQL 拿字符串就优先 `to_char(col,'YYYY-MM-DD')`；
 *   2. 拿不到时用这里的 toDateOnly()，绝不再手写 toISOString().slice(0,10)。
 *
 * 单独成模块（而非放进 db/pool.js）是为了让 CLI 脚本也能引用，
 * 不会因为 import 而意外创建第二个数据库连接池。
 */

/** 某年某月的真实天数（含闰年判断） */
function daysInMonth(year, month) {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/**
 * 把 DATE 列（Date）或任意日期输入统一成 'YYYY-MM-DD'；非法返回 null。
 * 一律取「本地日历字段」，不做时区换算。
 */
export function toDateOnly(value) {
  if (!value) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const s = String(value).trim()
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) {
    const mo = Number(m[2])
    const d = Number(m[3])
    // 必须校验「这个日期真实存在」，不能只看格式对不对。
    // 源表里出现过 '1900/01/00'（Excel 把空日期存成序列号 0 时的样子）：
    // 若原样透传成 '1900-01-00'，PostgreSQL 的 DATE 列会报
    // `date/time field value out of range`，
    // 而导入是「一个文件一个事务」—— 结果不是丢这一行，是**整张表回滚**。
    // 返回 null 后走「日期无效」告警分支，该行照常入库（doc_date 为 NULL）。
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(Number(m[1]), mo)) return null
    return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  const parsed = new Date(s)
  return Number.isNaN(parsed.getTime()) ? null : toDateOnly(parsed)
}

/**
 * 今天的「本地」日期 'YYYY-MM-DD'，用于每日快照口径。
 *
 * ⚠️ 不要用 `new Date().toISOString().slice(0, 10)`：那是 UTC 日期，
 * 北京时间 00:00–08:00 之间会比本地日期少一天 —— 深夜同步会把快照记成昨天。
 */
export function todayDate() {
  return toDateOnly(new Date())
}
