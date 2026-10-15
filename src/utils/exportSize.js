/**
 * 导出图片时该用多大尺寸。
 *
 * ⚠️ 为什么不能只看根元素：
 *   `el-table` 的**横向滚动发生在内层**（`.el-table__body-wrapper`），
 *   根元素的 `scrollWidth` 反映不出这个溢出 ⇒ 算出的宽度不够
 *   ⇒ 导出图右边被裁。而且 html-to-image 对滚动容器**只在可视宽度渲染**，
 *   被裁的部分直接没了，不是"没显示全"而是"丢了"。
 *
 *   实际症状（2026-10-10 使用者笔记本上导出）：业务员×账龄段表的
 *   「合计」列只剩前半截 —— `2,938`（本应 2,938,520.98）、合计 `6,056`（本应 6,056,615.91）。
 *   台式机屏幕宽、容器够大，所以看不到，只有笔记本（小屏或 125% 缩放）才暴露。
 *
 * 做法：把「根元素 + 全部后代」的 scrollWidth / scrollHeight 取最大值，
 *       再与 offset 值和下限比较。给足宽度后 html-to-image 会**重新按该宽度排版**，
 *       表格不再横向滚动 ⇒ 就不会被裁。
 */
export function exportSize(el, { minWidth = 1200, minHeight = 800 } = {}) {
  if (!el) return { width: minWidth, height: minHeight }

  let w = Math.max(el.scrollWidth, el.offsetWidth, minWidth)
  let h = Math.max(el.scrollHeight, el.offsetHeight, minHeight)

  // 后代里最大的 scroll 尺寸 —— 主要是为了兜住 el-table 内层滚动容器的溢出
  const nodes = el.querySelectorAll('*')
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    // 读到的是只读属性，不会触发重排抖动；一次性循环完即可
    if (n.scrollWidth > w) w = n.scrollWidth
    if (n.scrollHeight > h) h = n.scrollHeight
  }

  // 加一点余量：避免表格最后一列贴着画布边缘（边距/滚动条 2px 的误差）
  return { width: Math.ceil(w) + 4, height: Math.ceil(h) + 4 }
}

/**
 * 默认导出倍率。
 *
 * 2026-10-13 使用者：「导出的图片能不能够清晰点」——
 *  原来 5 个页面都写死 `pixelRatio: 2`。实测输出（2 倍）：
 *  首页看板 2538×2470 / 趋势 2608×1608 / 发货块 2896×4180。
 *  提到 3 倍后线性分辨率 +50%（发货块 → 4344×6270），在看板被塞进文档或
 *  放大看数字时差距明显。**不要在调用处再写死倍率**，统一走这里算。
 */
export const EXPORT_PIXEL_RATIO = 3

/**
 * 按画布尺寸算实际倍率：优先 {@link EXPORT_PIXEL_RATIO}，但按**总像素封顶**。
 *
 * 为什么要封顶：html-to-image 是纯前端渲染，像素数直接等于内存里的 RGBA 画布。
 * 3 倍的发货块已经是 2720 万像素（约 109 MB），再大的页面（行数再多些）
 * 就可能卡死标签页甚至崩掉。宁可自动降一档，也不能让使用者点了导出之后白等一场。
 *
 * @param width  画布宽（CSS 像素）
 * @param height 画布高（CSS 像素）
 */
export function exportPixelRatio(width, height, { preferred = EXPORT_PIXEL_RATIO, maxPixels = 40e6 } = {}) {
  const area = Math.max(1, (Number(width) || 0) * (Number(height) || 0))
  const cap = Math.sqrt(maxPixels / area)
  // 保留一位小数，避免出现 2.7361 这种没意义的精度
  return Math.min(preferred, Math.max(1, Math.floor(cap * 10) / 10))
}

/**
 * 导出 PNG：**先把元素临时撑到目标宽度再截**，截完还原。
 *
 * 为什么要这么绕：只给 `toPng` 传 width/height 只决定**画布**大小，
 * 并不保证克隆出来的内容按那个宽度重新排版 —— 表格仍按原宽度渲染，
 * 内层滚动容器超出的部分**直接被丢掉**（不是没显示全，是没了）。
 *
 * 把**真实元素**临时撑宽 ⇒ 浏览器真的重新排版 ⇒ 表格不再横向滚动 ⇒ 不可能被裁。
 * 代价是导出瞬间页面会有一次轻微跳动（可接受，导出本来就是个动作）。
 */
export async function captureWithFullWidth(el, toPng, toPngOpts = {}, sizeOpts = {}) {
  if (!el) return null
  const { width, height } = exportSize(el, sizeOpts)

  const prevWidth = el.style.width
  const prevOverflow = el.style.overflow
  const prevMaxWidth = el.style.maxWidth
  el.style.width = `${width}px`
  el.style.maxWidth = 'none' // 有些页有 max-width（如客户平台 760px），不放开就撑不宽
  el.style.overflow = 'visible'

  try {
    // 等一次渲染，保证撑宽已经生效
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

    // 🔴 画布要用**外框宽**，不能直接用上面那个 width。
    //
    //   `exportSize` 算出来的是**内容宽**（它比的是 scrollWidth / offsetWidth…），
    //   而 `el.style.width` 对 `content-box` 元素设的是**内容宽** ——
    //   本项目的 `.container` 正是 content-box + `padding: 0 20px`：
    //   设 `width:1404px` 后外框实际是 **1444px**，若只给 1404 的画布，
    //   右侧 40px（右内边距及"右对齐"的那几个数字）会被**直接切掉**。
    //   实测（2026-10-13）：`/invoice-daily` 导出的分组小计
    //   `+142,775.87` 只剩 `+142,775.8`，`-40,005.00` 只剩 `-40,005.0`。
    //
    //   ⇒ 撑宽之后再量一次真实外框（offsetWidth/offsetHeight 已含 padding+border）。
    const boxW = Math.ceil(el.offsetWidth) + 4
    const boxH = Math.ceil(el.offsetHeight) + 4
    const finalW = Math.max(width, boxW)
    const finalH = Math.max(height, boxH)
    return await toPng(el, {
      ...toPngOpts,
      // 倍率由这里统一决定（调用处不再写死）—— 传了就尊重传的
      pixelRatio: toPngOpts.pixelRatio ?? exportPixelRatio(finalW, finalH),
      width: finalW,
      height: finalH,
    })
  } finally {
    el.style.width = prevWidth
    el.style.maxWidth = prevMaxWidth
    el.style.overflow = prevOverflow
  }
}
