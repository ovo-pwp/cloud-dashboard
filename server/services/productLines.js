/**
 * 产品线清单（2026-11-19）
 *
 * 8 个产品线来自「利润管控系统」客户对账明细表(123) 的 `product_line` 字段，
 * 源表本来就有 ⇒ 系统直接按客户汇总，不用任何人工维护的中间表。
 *
 * key = 数据库列名（customer_recon 汇总时按 label 匹配后写入）
 * label = 源表里的原始取值
 */
export const PRODUCT_LINES = [
  { key: 'pl_lijianjin', label: '立减金' },
  { key: 'pl_marketing_gift', label: '营销礼品' },
  { key: 'pl_activity', label: '活动策划' },
  { key: 'pl_modern_service', label: '现代服务' },
  { key: 'pl_channel', label: '渠道营销产品' },
  { key: 'pl_outbound', label: '自营场外引流订单' },
  { key: 'pl_software', label: '软件' },
  { key: 'pl_scene', label: '场景获客' },
]
