/**
 * 部门（销售战队）口径归一化 —— 2026-10-24
 *
 * 来源：使用者提供的「销售区域划分」表（每个战队一个客户经理负责人）。
 * ⚠️ 这份表与 `Desktop\看板模板\kdocs_pull.py` 里的 `DEPT_FALLBACK` **必须保持一致**，
 *    取数侧已经按它把部门写进 receivable_detail.department；
 *    这里再做一层，是为了兜住**历史批次**的旧口径（例如 10-20~10-23 的「大客户中心」）。
 *
 * 历史别名（实测）：10-23 标「大客户中心」的 80 单，有 76 单在 10-24 归到「大项目部」
 *（业务员字段也从「大客户中心」变成了「大项目部」），所以按同义处理。
 */

/** 客户经理（负责人） → 销售战队 */
export const DEPT_BY_MANAGER = {
  大项目部: '大项目部',
  唐良超: '销售一部',
  雷小慧: '销售二部',
  吴青: '销售三部',
  李国俊: '销售四部',
  刘晓欣: '销售五部',
  李总: '李总战队',
  项目组: '综合拓展战队',
}

/** 部门旧名 → 现名 */
export const DEPT_ALIASES = {
  大客户中心: '大项目部',
  大客户部: '大项目部',
}

/** 标准战队集合（其它值都算异常，需要人工确认） */
export const STD_DEPTS = new Set([
  '大项目部', '销售一部', '销售二部', '销售三部',
  '销售四部', '销售五部', '李总战队', '综合拓展战队',
])

/**
 * 归一化一个部门的显示值。
 * 优先级：负责人映射 > 旧名别名 > 原值
 */
export function normalizeDept(dept, salesperson) {
  const sp = String(salesperson || '').trim()
  const d = String(dept || '').trim()

  // 1) 人名在权威表里 ⇒ 以表为准（表里的人一律固定归属）
  if (DEPT_BY_MANAGER[sp]) return DEPT_BY_MANAGER[sp]
  // 2) 部门本身是旧名
  if (DEPT_ALIASES[d]) return DEPT_ALIASES[d]
  // 3) 部门值本身是负责人名（源表把业务员填进部门列的情况）
  if (DEPT_BY_MANAGER[d]) return DEPT_BY_MANAGER[d]
  return d
}
