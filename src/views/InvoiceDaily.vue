<template>
  <div class="container" ref="pageRef">
    <PageHeader title="发货 · 回款明细" :sub="subText">
      <!-- 使用者 2026-10-12 要求：发货 / 回款**分开导出两张图** -->
      <el-button
        class="no-export"
        type="primary"
        plain
        size="small"
        :loading="exporting === 'shipped'"
        @click="exportImage('shipped')"
      >
        导出发货图
      </el-button>
      <el-button
        class="no-export"
        type="success"
        plain
        size="small"
        :loading="exporting === 'payments'"
        @click="exportImage('payments')"
      >
        导出回款图
      </el-button>
    </PageHeader>

    <!-- 主体与「数据总览」页里嵌的是同一个组件，逻辑只有一份 -->
    <DailyShipPay ref="dsp" />
  </div>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { toPng } from 'html-to-image'
import { captureWithFullWidth } from '@/utils/exportSize'
import PageHeader from '@/components/PageHeader.vue'
import DailyShipPay from '@/components/DailyShipPay.vue'

const pageRef = ref(null)
const exporting = ref('')   // '' | 'shipped' | 'payments'
const dsp = ref(null)

/**
 * 副标题跟着「导出哪一侧」走。
 * 单侧导出时图里只有一块，还写「上：发货｜下：回款」会与图内容自相矛盾 ——
 * 这张图是要直接发出去的，说明必须和图对得上。
 */
const subText = computed(() => {
  const tail = '· 均为「本批 vs 上一批」的变动明细 · 不含财务部'
  if (exporting.value === 'shipped') return `已发货未开票线 ${tail}`
  if (exporting.value === 'payments') return `已开票未回款线 ${tail}`
  return `上：发货（已发货未开票线）｜下：回款（已开票未回款线）${tail}`
})

/** 拿不到快照日期时退回今天（只在接口失败时用得到） */
function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function exportImage(side) {
  if (!pageRef.value) return
  exporting.value = side
  // 只显示当前这一侧，导出的图里就只有它（传的 side 就是「要保留」的那一侧）
  dsp.value?.showOnlySide(side)
  // 导出前收起三组明细（2026-10-14 使用者：「太长了」）—— 明细留着屏幕上，只是不进图
  dsp.value?.setExportMode(true)
  await nextTick()
  // 等两帧，保证收起已经生效（captureWithFullWidth 里会先量尺寸，量早了就白收）
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  try {
    const dataUrl = await captureWithFullWidth(
      pageRef.value,
      toPng,
      {
        backgroundColor: '#ffffff',
        cacheBust: true,
        filter: (node) =>
          !(node instanceof Element && node.classList && node.classList.contains('no-export')),
      },
      // minHeight 给 0：这一页导出的是**单块**（发货约 480 / 回款约 420 逻辑像素），
      // 沿用「看板整页」那套 minHeight:800 会在图底部留近 400px 空白。宽度下限保留，
      // 那是为了兜住 el-table 内层横向滚动被裁的老问题。
      { minWidth: 1400, minHeight: 0 }
    )
    const a = document.createElement('a')
    // 文件名用**数据快照日期**，不是「今天」—— 数据是快照，写今天会让人误读成当日流水
    const key = side === 'shipped' ? 'shipped' : 'payments'
    const cur = dsp.value?.dates?.()?.[key]?.curDate
    const prev = dsp.value?.dates?.()?.[key]?.prevDate
    const range = cur ? (prev ? `较${prev}_至${cur}` : cur) : today()
    a.href = dataUrl
    a.download = `${side === 'shipped' ? '发货' : '回款'}_${range}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    console.error('[导出图片] 失败:', err)
    ElMessage.error('导出图片失败，请重试')
  } finally {
    dsp.value?.setExportMode(false)
    dsp.value?.showOnlySide('')
    exporting.value = ''
  }
}
</script>

<style scoped>
.container { padding: 20px; background: #fff; border-radius: 8px; }
</style>
