<template>
  <!--
    「发货 / 回款」两块 —— 各显示**本条线「本期变动」**（2026-10-12）

    使用者口径：下面这块必须**和上面卡片的环比一一对应** ——
      列出「新增 / 回款 / 金额改动」三种单，三条小计之和 = 上面卡片的环比数值。

      发货块 ← 已发货未开票线（shipped_uninvoiced）
      回款块 ← 已开票未回款线（billed_unpaid）—— 它的「消失」= 余额减少的构成
                （回款 / 退票红冲 / 清账 / 删单改数…）

    ⚠️ 标题一律**不带「每日」**（使用者 2026-10-12）。
    数据来自 GET /api/customer-invoice/line-delta?bizType=...
  -->
  <div class="dsp" ref="boxRef" :class="{ 'is-exporting': exportMode }">
    <!-- ===================== 发货 ===================== -->
    <section v-if="onlySide !== 'payments'" class="dsp-block dsp-block-ship" data-side="shipped">
      <div class="dsp-head no-export">
        <div>
          <div class="dsp-title">发货<span class="dsp-tag">本期变动 · 已发货未开票线</span></div>
          <div class="dsp-sub">
            相比上一批（{{ ship.prevDate || '—' }} → {{ ship.curDate || '—' }}）· 不含财务部<br />
            本期合计＝<b>全量总额（含当月）</b>｜变动＝与上一批的环比（新增 + 补录 − 已开票 + 金额改动）｜张数卡四个数依次对应下面四组
          </div>
        </div>
        <div class="dsp-actions">
          <el-select v-model="salesperson" placeholder="全部业务员" clearable size="small"
                     style="width: 140px" @change="load">
            <el-option label="全部业务员" value="" />
            <el-option v-for="s in salespersons" :key="s" :label="s" :value="s" />
          </el-select>
        </div>
      </div>

      <div class="dsp-sum">
        <div class="dsp-card">
          <div class="dsp-label">本期合计</div>
          <div class="dsp-value">{{ fmt(ship.curTotal) }}</div>
          <div class="dsp-note">上期 {{ fmt(ship.prevTotal) }}</div>
        </div>
        <div class="dsp-card">
          <div class="dsp-label">变动{{ salesperson ? `（${salesperson}）` : '（＝上面卡片的环比）' }}</div>
          <div class="dsp-value" :class="cls(ship.summary.delta)">{{ fmtSigned(ship.summary.delta) }}</div>
          <div class="dsp-note">
            ＝ 新增 {{ fmtSigned(ship.summary.addedRealAmount) }} + 补录 {{ fmtSigned(ship.summary.backfilledAmount) }}<br />
            − 已开票 {{ fmt(ship.summary.removedAmount) }}<br />
            + 金额改动 {{ fmtSigned(ship.summary.changedAmount) }}
          </div>
        </div>
        <div class="dsp-card">
          <div class="dsp-label">张数（新增 / 补录 / 已开票 / 金额改动）</div>
          <div class="dsp-value sm">
            <span class="red">+{{ ship.added.length }}</span> /
            <span class="orange">{{ ship.backfilled.length }}</span> /
            <span class="green">{{ ship.removed.length }}</span> /
            <span>{{ ship.changed.length }}</span>
          </div>
          <div class="dsp-note">与下面四组表一一对应</div>
        </div>
      </div>

      <el-empty v-if="!hasDelta(ship)" description="本期没有变动" :image-size="60" />

      <div v-if="ship.added.length" class="dsp-group">
        <div class="dsp-group-head add">
          今日新增的已发货未开票 <b>{{ ship.added.length }}</b> 张<span class="dsp-group-hint">上一批没有的单 · 只算账龄「当月」的</span>
          <span class="dsp-group-amt">+{{ fmt(ship.summary.addedRealAmount) }}</span>
        </div>
        <el-table :data="ship.added" border size="small"
                  :header-cell-style="HEAD_STYLE">
          <el-table-column prop="doc_no" label="合同执行编号" width="118" fixed="left" show-overflow-tooltip />
          <el-table-column prop="customer_name" label="挂账客户" min-width="150" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="90" show-overflow-tooltip />
          <el-table-column prop="aging_category" label="账龄" width="150" show-overflow-tooltip />
          <el-table-column prop="amount_total" label="金额" width="120" align="right">
            <template #default="{ row }"><span class="red">{{ fmt(row.amt) }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 补录（老单补登记）—— 2026-10-14 新增。默认折叠：这些不是今天发生的业务，
           摆出来会让人误以为今天发了这么多货。但也不能不显示，否则「变动」对不上。
           判断依据是源表的账龄不是「当月」档（实测 10-13 那批 30 张新增里 23 张是这类，占金额 92.7%）。 -->
      <div v-if="ship.backfilled.length" class="dsp-group">
        <div class="dsp-group-head chg is-toggle" @click="backfillOpen.ship = !backfillOpen.ship">
          <span class="dsp-caret">{{ backfillOpen.ship ? '▾' : '▸' }}</span>
          补录（老单补登记） <b>{{ ship.backfilled.length }}</b> 张<span class="dsp-group-hint">货早发了、源表这批才补登记，不是今天的新业务 · {{ tip(backfillOpen.ship) }}</span>
          <span class="dsp-group-amt">+{{ fmt(ship.summary.backfilledAmount) }}</span>
        </div>
        <el-table v-if="backfillOpen.ship" :data="ship.backfilled" border size="small"
                  :header-cell-style="HEAD_STYLE">
          <el-table-column prop="doc_no" label="合同执行编号" width="118" fixed="left" show-overflow-tooltip />
          <el-table-column prop="customer_name" label="挂账客户" min-width="150" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="90" show-overflow-tooltip />
          <el-table-column prop="aging_category" label="账龄" width="150" show-overflow-tooltip />
          <el-table-column prop="amount_total" label="金额" width="120" align="right">
            <template #default="{ row }"><span class="red">{{ fmt(row.amt) }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <div v-if="ship.removed.length" class="dsp-group">
        <div class="dsp-group-head del">
          今日已开票 <b>{{ ship.removed.length }}</b> 张<span class="dsp-group-hint">上一批有、这一批不在了</span>
          <span class="dsp-group-amt">-{{ fmt(ship.summary.removedAmount) }}</span>
        </div>
        <el-table :data="ship.removed" border size="small"
                  :header-cell-style="HEAD_STYLE">
          <el-table-column prop="doc_no" label="合同执行编号" width="118" fixed="left" show-overflow-tooltip />
          <el-table-column prop="customer_name" label="挂账客户" min-width="150" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="90" show-overflow-tooltip />
          <el-table-column prop="aging_category" label="账龄" width="150" show-overflow-tooltip />
          <el-table-column prop="amount_total" label="上批金额" width="120" align="right">
            <template #default="{ row }"><span class="green">{{ fmt(row.amt) }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <div v-if="ship.changed.length" class="dsp-group">
        <!-- 「金额改动」默认折叠（2026-10-13 使用者要求）：这一组张数最多（今天 68 张，
             占变动 88%），全铺开会拖出一整屏。标题条保留（张数 + 金额都在），点一下展开明细。
             ⚠️ 折叠状态会带进导出的图（导出是所见即所得），图因此也短很多。 -->
        <div class="dsp-group-head chg is-toggle" @click="changedOpen.ship = !changedOpen.ship">
          <span class="dsp-caret">{{ changedOpen.ship ? '▾' : '▸' }}</span>
          今日金额改动 <b>{{ ship.changed.length }}</b> 张<span class="dsp-group-hint">同一张单，两批金额不一样 · {{ tip(changedOpen.ship) }}</span>
          <span class="dsp-group-amt">{{ fmtSigned(ship.summary.changedAmount) }}</span>
        </div>
        <el-table v-if="changedOpen.ship" :data="ship.changed" border size="small"
                  :header-cell-style="HEAD_STYLE">
          <el-table-column prop="doc_no" label="合同执行编号" width="118" fixed="left" show-overflow-tooltip />
          <el-table-column prop="customer_name" label="挂账客户" min-width="150" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="90" show-overflow-tooltip />
          <el-table-column prop="aging_category" label="账龄" width="150" show-overflow-tooltip />
          <el-table-column prop="oldAmount" label="上批金额" width="120" align="right">
            <template #default="{ row }">{{ fmt(row.oldAmount) }}</template>
          </el-table-column>
          <el-table-column prop="amt" label="本批金额" width="120" align="right">
            <template #default="{ row }">{{ fmt(row.amt) }}</template>
          </el-table-column>
          <el-table-column prop="diff" label="差额" width="120" align="right">
            <template #default="{ row }"><span :class="cls(row.diff)">{{ fmtSigned(row.diff) }}</span></template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <!-- ===================== 回款 ===================== -->
    <section v-if="onlySide !== 'shipped'" class="dsp-block dsp-block-pay" data-side="payments">
      <div class="dsp-head no-export">
        <div>
          <div class="dsp-title">回款<span class="dsp-tag">本期变动 · 已开票未回款线</span></div>
          <div class="dsp-sub">
            相比上一批（{{ pay.prevDate || '—' }} → {{ pay.curDate || '—' }}）· 不含财务部<br />
            本期合计＝<b>全量总额（含当月）</b>｜变动＝与上一批的环比（新增 + 补录 − 回款 + 金额改动）｜张数卡四个数依次对应下面四组
          </div>
        </div>
      </div>

      <div class="dsp-sum">
        <div class="dsp-card">
          <div class="dsp-label">本期合计</div>
          <div class="dsp-value">{{ fmt(pay.curTotal) }}</div>
          <div class="dsp-note">上期 {{ fmt(pay.prevTotal) }}</div>
        </div>
        <div class="dsp-card">
          <div class="dsp-label">变动{{ salesperson ? `（${salesperson}）` : '（＝上面卡片的环比）' }}</div>
          <div class="dsp-value" :class="cls(pay.summary.delta)">{{ fmtSigned(pay.summary.delta) }}</div>
          <div class="dsp-note">
            ＝ 新增 {{ fmtSigned(pay.summary.addedRealAmount) }} + 补录 {{ fmtSigned(pay.summary.backfilledAmount) }}<br />
            − 回款 {{ fmt(pay.summary.removedAmount) }}<br />
            + 金额改动 {{ fmtSigned(pay.summary.changedAmount) }}
          </div>
        </div>
        <div class="dsp-card">
          <div class="dsp-label">张数（新增 / 补录 / 回款 / 金额改动）</div>
          <div class="dsp-value sm">
            <span class="red">+{{ pay.added.length }}</span> /
            <span class="orange">{{ pay.backfilled.length }}</span> /
            <span class="green">{{ pay.removed.length }}</span> /
            <span>{{ pay.changed.length }}</span>
          </div>
          <div class="dsp-note">与下面四组表一一对应</div>
        </div>
      </div>

      <el-empty v-if="!hasDelta(pay)" description="本期没有变动" :image-size="60" />

      <div v-if="pay.added.length" class="dsp-group">
        <div class="dsp-group-head add">
          今日新增的已开票未回款 <b>{{ pay.added.length }}</b> 张<span class="dsp-group-hint">上一批没有的单 · 只算账龄「当月」的</span>
          <span class="dsp-group-amt">+{{ fmt(pay.summary.addedRealAmount) }}</span>
        </div>
        <el-table :data="pay.added" border size="small"
                  :header-cell-style="HEAD_STYLE">
          <el-table-column prop="doc_no" label="开票方案编号" width="118" fixed="left" show-overflow-tooltip />
          <el-table-column prop="customer_name" label="挂账客户" min-width="160" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="90" show-overflow-tooltip />
          <el-table-column prop="aging_category" label="账龄" width="150" show-overflow-tooltip />
          <el-table-column prop="amount_total" label="金额" width="120" align="right">
            <template #default="{ row }"><span class="red">{{ fmt(row.amt) }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 补录（老单补登记）—— 同发货块，默认折叠 -->
      <div v-if="pay.backfilled.length" class="dsp-group">
        <div class="dsp-group-head chg is-toggle" @click="backfillOpen.pay = !backfillOpen.pay">
          <span class="dsp-caret">{{ backfillOpen.pay ? '▾' : '▸' }}</span>
          补录（老单补登记） <b>{{ pay.backfilled.length }}</b> 张<span class="dsp-group-hint">早该在表里的老单、源表这批才补登记 · {{ tip(backfillOpen.pay) }}</span>
          <span class="dsp-group-amt">+{{ fmt(pay.summary.backfilledAmount) }}</span>
        </div>
        <el-table v-if="backfillOpen.pay" :data="pay.backfilled" border size="small"
                  :header-cell-style="HEAD_STYLE">
          <el-table-column prop="doc_no" label="开票方案编号" width="118" fixed="left" show-overflow-tooltip />
          <el-table-column prop="customer_name" label="挂账客户" min-width="160" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="90" show-overflow-tooltip />
          <el-table-column prop="aging_category" label="账龄" width="150" show-overflow-tooltip />
          <el-table-column prop="amount_total" label="金额" width="120" align="right">
            <template #default="{ row }"><span class="red">{{ fmt(row.amt) }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <div v-if="pay.removed.length" class="dsp-group">
        <div class="dsp-group-head del">
          今日回款 <b>{{ pay.removed.length }}</b> 张<span class="dsp-group-hint">上一批有、这一批不在了（也可能是退票红冲 / 清账 / 删单改数）</span>
          <span class="dsp-group-amt">-{{ fmt(pay.summary.removedAmount) }}</span>
        </div>
        <el-table :data="pay.removed" border size="small"
                  :header-cell-style="HEAD_STYLE">
          <el-table-column prop="doc_no" label="开票方案编号" width="118" fixed="left" show-overflow-tooltip />
          <el-table-column prop="customer_name" label="挂账客户" min-width="160" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="90" show-overflow-tooltip />
          <el-table-column prop="aging_category" label="账龄" width="150" show-overflow-tooltip />
          <el-table-column prop="amount_total" label="上批金额" width="120" align="right">
            <template #default="{ row }"><span class="green">{{ fmt(row.amt) }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <div v-if="pay.changed.length" class="dsp-group">
        <!-- 同发货块：默认折叠（2026-10-13） -->
        <div class="dsp-group-head chg is-toggle" @click="changedOpen.pay = !changedOpen.pay">
          <span class="dsp-caret">{{ changedOpen.pay ? '▾' : '▸' }}</span>
          今日金额改动 <b>{{ pay.changed.length }}</b> 张<span class="dsp-group-hint">同一张单，两批金额不一样 · {{ tip(changedOpen.pay) }}</span>
          <span class="dsp-group-amt">{{ fmtSigned(pay.summary.changedAmount) }}</span>
        </div>
        <el-table v-if="changedOpen.pay" :data="pay.changed" border size="small"
                  :header-cell-style="HEAD_STYLE">
          <el-table-column prop="doc_no" label="开票方案编号" width="118" fixed="left" show-overflow-tooltip />
          <el-table-column prop="customer_name" label="挂账客户" min-width="160" show-overflow-tooltip />
          <el-table-column prop="salesperson" label="业务员" width="90" show-overflow-tooltip />
          <el-table-column prop="aging_category" label="账龄" width="150" show-overflow-tooltip />
          <el-table-column prop="oldAmount" label="上批金额" width="120" align="right">
            <template #default="{ row }">{{ fmt(row.oldAmount) }}</template>
          </el-table-column>
          <el-table-column prop="amt" label="本批金额" width="120" align="right">
            <template #default="{ row }">{{ fmt(row.amt) }}</template>
          </el-table-column>
          <el-table-column prop="diff" label="差额" width="120" align="right">
            <template #default="{ row }"><span :class="cls(row.diff)">{{ fmtSigned(row.diff) }}</span></template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <!-- 口径备注放最下面（使用者 2026-10-12） -->
    <div v-if="onlySide !== 'shipped'" class="dsp-caveat no-export">
      注：这里说的<b>回款 / 已开票</b>＝「上一批有、这一批没有的单」—— 它<b>包含真正收到钱或已经开票，也包含退票红冲、清账、删单、改数</b>；
      只是单号层面的减少，<b>不等于已收到的现金</b>。差额部分建议回源表核对。
      （「退票红冲不重开」的废票源表已把余额归零，不会计入；「红冲重开」的新票是有效票。）
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/api/request'

const props = defineProps({
  // 数据总览按顶栏页签只显示一块：'shipped' 只发货 / 'payments' 只回款 / '' 两块都要
  onlySide: { type: String, default: '' },
})

const salesperson = ref('')
const salespersons = ref([])

/**
 * 三张表共用表头样式。
 *
 * ⚠️ 2026-10-13 修正：昨天（10-12）我把它改成浅色 `#f5f7fa`，理由是「与站内其它表格一致」——
 *    这个前提是**错的**。核对过：全站 5 个页面（Detail / MyPerformance / CustomerPlatformDetail /
 *    ByCustomer / 以及本页上面的「业务员 × 账龄段」矩阵）用的**都是深藏蓝 `#2c3e50`**。
 *    改成浅色反而让 /home 一屏之内「矩阵深、下面三张浅」，看着像出了 bug。故改回深藏蓝。
 *    若哪天真要统一成浅色，得**全站一起改**，不能只改这一处。
 */
const HEAD_STYLE = { background: '#2c3e50', color: '#fff' }

const blank = () => ({ prevDate: null, curDate: null, prevTotal: 0, curTotal: 0,
                       added: [], backfilled: [], removed: [], changed: [], summary: {}, salespersons: [] })
const ship = reactive(blank())
const pay = reactive(blank())

/**
 * 折叠状态（默认收起），两个块各自独立。
 *  · changedOpen —— 「今日金额改动」（10-13 使用者要求：68 张太占地方）
 *  · backfillOpen —— 「补录（老单补登记）」（10-14 新增；这些是源表漏登记的老单，
 *     不该摆在首页抢眼，但也不能不显示，否则「变动」对不上）
 */
const changedOpen = reactive({ ship: false, pay: false })
const backfillOpen = reactive({ ship: false, pay: false })

/**
 * 导出模式：为 true 时**所有分组的明细表都不进图**，只留各组标题条（张数 + 小计）。
 *
 * 为什么（2026-10-14 使用者：「这样的格式不是很好，太长了」）：
 *   整页导出会把 47~115 行明细一起截进去，图变成 4770×7951（高是宽的 1.67 倍），
 *   发领导的图不该是这种竖条。收起后约 2600 高（0.55 倍，横版）。
 * 实现是**加个类 + CSS 隐藏**（不是逐表 v-if）：一张表都不用改，html-to-image 克隆时类会一起带过去。
 * 屏幕上完全不受影响 —— 导出前后由父组件调 setExportMode() 开关。
 */
const exportMode = ref(false)

const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtSigned = (n) => {
  const v = Number(n || 0)
  if (Math.abs(v) < 0.005) return '0.00'
  return (v > 0 ? '+' : '-') + fmt(Math.abs(v))
}
/** 沿用国内口径：增加=红、减少=绿 */
const cls = (n) => (Number(n || 0) > 0 ? 'red' : Number(n || 0) < 0 ? 'green' : '')
const hasDelta = (s) => !!(s.added.length || s.backfilled.length || s.removed.length || s.changed.length)

/** 可折叠标题条右侧那句提示 —— 导出时明细不在图里，就别再写「点这里展开」了 */
const tip = (open) => (exportMode.value ? '明细不随图导出' : open ? '点这里收起' : '点这里展开明细')

/** 父组件（Home / InvoiceDaily）在截图前后调用 —— 挂在下面那个 defineExpose 上 */
function setExportMode(on) {
  exportMode.value = !!on
}

async function loadOne(target, bizType) {
  try {
    const params = { bizType }
    if (salesperson.value) params.salesperson = salesperson.value
    const d = await request.get('/customer-invoice/line-delta', { params })
    target.prevDate = d.prevDate
    target.curDate = d.curDate
    target.prevTotal = d.prevTotal || 0
    target.curTotal = d.curTotal || 0
    target.added = d.added || []
    target.backfilled = d.backfilled || []
    target.removed = d.removed || []
    target.changed = d.changed || []
    target.summary = d.summary || {}
    // 业务员候选由后端取「两批全量」给出 —— 不能只看本期有变动的人，
    // 否则「本期没动」的业务员会从下拉里凭空消失
    if (Array.isArray(d.salespersons) && d.salespersons.length) {
      target.salespersons = d.salespersons
    }
  } catch (err) {
    console.error('[本期变动] 加载失败:', err)
    ElMessage.error('本期变动 加载失败')
  }
}

async function load() {
  await Promise.all([loadOne(ship, 'shipped_uninvoiced'), loadOne(pay, 'billed_unpaid')])
  const set = new Set([...ship.salespersons, ...pay.salespersons])
  salespersons.value = [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

defineExpose({
  /**
   * 导出用：只显示指定的一侧。
   *   v = 'shipped' 只留发货块 / 'payments' 只留回款块 / '' 两块都显示
   *
   * 🔴 语义就是「**保留** v」（名字已从 setHideSide 改掉）。
   *   2026-10-13 修 bug：老的 `setHideSide` 实现是「保留 v」，而调用方按
   *   「隐藏 v」来传（导出 shipped 时传 'payments'）⇒ **导出的发货图里其实是回款**，
   *   且当时只验了「有没有出图」没验「出的是哪一侧」，一直没暴露。
   *   现在改成按 `data-side` 属性匹配，不依赖块的出现顺序（onlySide 会让某块不渲染）。
   */
  showOnlySide: (v) => {
    document.querySelectorAll('.dsp-block').forEach((b) => {
      b.style.display = !v || b.dataset.side === v ? '' : 'none'
    })
  },
  /** 导出文件名用：返回两块各自的「本批 / 上批」快照日期，别拿「今天」当数据日期 */
  dates: () => ({
    shipped: { prevDate: ship.prevDate, curDate: ship.curDate },
    payments: { prevDate: pay.prevDate, curDate: pay.curDate },
  }),
  /**
   * 导出模式开关：为 true 时所有分组的明细表都不进图（只留标题条 + 张数 + 小计）。
   * ⚠️ 必须挂在**这一个** defineExpose 上 —— Vue 的 defineExpose 只能调一次，
   *    另起一个会整体覆盖，`showOnlySide` / `dates` 会一起消失（InvoiceDaily 的导出会静默坏掉）。
   */
  setExportMode,
  load,
})

onMounted(load)
</script>

<style scoped>
.dsp { margin-top: 22px; }
.dsp-block { border-top: 1px solid #ebeef5; padding-top: 14px; }
.dsp-block-pay { margin-top: 20px; }
.dsp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsp-title { font-size: 16px; font-weight: 600; color: #303133; display: flex; align-items: center; gap: 8px; }
.dsp-tag { font-size: 12px; font-weight: 400; color: #606266; background: #f0f2f5; border-radius: 4px; padding: 1px 8px; }
/* 「相比上一批…」+ 口径说明（2026-10-13 使用者要求「也得详细」）—— 两行，第二行讲清三张卡各是什么口径 */
.dsp-sub { font-size: 12px; color: #909399; margin-top: 3px; line-height: 1.75; }
.dsp-sub b { color: #606266; }
.dsp-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.dsp-sum { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 12px 0 14px; }
.dsp-card { background: #f5f7fa; border-radius: 8px; padding: 10px 12px; }
.dsp-label { font-size: 13px; color: #606266; }
.dsp-value { font-size: 20px; font-weight: 600; margin-top: 3px; }
.dsp-value.sm { font-size: 16px; }
.dsp-note { font-size: 12px; color: #909399; margin-top: 2px; }

.red { color: #f56c6c; }
.green { color: #67c23a; }
/* 补录组用的橙（与「金额改动」同一个色，都是「要留意但不是今天发生的」） */
.orange { color: #e6a23c; }

.dsp-group { margin-bottom: 12px; }
/* 分组标题条：浅底 + 左侧 4px 分组色竖线（2026-10-12 改）。
   原来是整条饱和色（粉/绿/橙）铺满宽度，三连在一起显得又花又闷；
   现在只留一条竖线点明分组颜色，文字该深的深、该灰的灰。 */
.dsp-group-head {
  font-size: 13px; font-weight: 600; padding: 7px 12px;
  background: #fafbfc; border-left: 4px solid currentColor; border-radius: 0 4px 4px 0;
}
.dsp-group-head.add { color: #f56c6c; }
.dsp-group-head.del { color: #67c23a; }
.dsp-group-head.chg { color: #e6a23c; }
.dsp-group-head b { font-weight: 600; }
/* 分组标题后面那句「人话」解释（2026-10-12 使用者：术语看不明白，要能让人一眼懂）：
   固定用灰色，不跟着分组色一起花 —— 三种颜色叠一句长解释太杂乱 */
.dsp-group-hint { font-size: 12px; font-weight: 400; color: #909399; margin-left: 8px; }
/* 金额改动那组默认折叠：标题条整条可点，给个箭头 + hover 反馈 */
.dsp-group-head.is-toggle { cursor: pointer; user-select: none; transition: background 0.2s ease; }
.dsp-group-head.is-toggle:hover { background: #f0f2f5; }
/* 导出时：所有分组的明细表都不进图，只留标题条（张数 + 小计）——
   使用者 2026-10-14「这样的格式不是很好，太长了」：47~115 行明细会把图拉成 1.67 倍高的竖条。
   用类 + CSS 隐藏，而不是逐表 v-if：一张表都不用改，html-to-image 克隆时类会一起带过去。 */
.dsp.is-exporting .dsp-group .el-table { display: none !important; }
.dsp-caret { display: inline-block; width: 14px; font-size: 11px; opacity: 0.75; }
/* 金额用深色：正负号已经说明增减方向，不再叠一层颜色 */
.dsp-group-amt { float: right; font-weight: 600; color: #303133; }

.dsp-caveat {
  font-size: 12px; color: #909399; line-height: 1.6;
  background: #fdf6ec; border-left: 3px solid #e6a23c;
  border-radius: 4px; padding: 8px 12px; margin: 6px 0 12px;
}
.dsp-caveat b { color: #606266; font-weight: 600; }

:deep(.el-table .cell) { white-space: nowrap; }

@media (max-width: 1200px) {
  .dsp-sum { grid-template-columns: minmax(0, 1fr); }
}
</style>
