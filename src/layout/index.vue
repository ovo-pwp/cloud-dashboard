<template>
  <el-container class="app-layout">
    <!-- 移动端汉堡菜单按钮 -->
    <div class="mobile-menu-btn" @click="toggleMobileMenu">
      <el-icon><Menu /></el-icon>
    </div>

    <el-aside
      :width="asideWidth"
      class="sidebar"
      :class="{ 'mobile-open': mobileMenuOpen, narrow: isNarrow }"
    >
      <div class="logo">{{ isNarrow ? '◆' : '◆ 应收账款' }}</div>
      <el-menu
        router
        :default-active="$route.path"
        :default-openeds="['system-group', 'dashboard']"
        background-color="#001529"
        text-color="#a6adb4"
        active-text-color="#fff"
        :collapse="isNarrow"
      >
        <el-menu-item index="/homepage">
          <el-icon><HomeFilled /></el-icon><span>首页</span>
        </el-menu-item>

        <!-- 总系统：中心入口层，三个子项目都挂在它下面 -->
        <el-sub-menu index="system-group">
          <template #title>
            <el-icon><Grid /></el-icon>
            <span>总系统</span>
          </template>

          <el-menu-item index="/system-hub">
            <el-icon><Grid /></el-icon><span>系统总览</span>
          </el-menu-item>
          <el-menu-item index="/my-performance">
            <el-icon><User /></el-icon><span>我的业绩</span>
          </el-menu-item>

          <!-- 子项目 1：未回款 / 未开票管理看板 -->
          <el-sub-menu index="dashboard">
            <template #title>
              <el-icon><DataAnalysis /></el-icon>
              <span>未回款/未开票管理看板</span>
            </template>
            <el-menu-item index="/home">
              <el-icon><DataAnalysis /></el-icon><span>数据总览</span>
            </el-menu-item>
            <el-menu-item index="/detail">
              <el-icon><Document /></el-icon><span>明细查询</span>
            </el-menu-item>
            <el-menu-item index="/trace">
              <el-icon><Search /></el-icon><span>单号追溯</span>
            </el-menu-item>
            <el-menu-item index="/trend">
              <el-icon><TrendCharts /></el-icon><span>每日趋势</span>
            </el-menu-item>
            <el-menu-item index="/priority-actions">
              <el-icon><Flag /></el-icon><span>待处理优先级</span>
            </el-menu-item>
            <el-menu-item index="/invoice-daily">
              <el-icon><Money /></el-icon><span>每日发货·回款</span>
            </el-menu-item>
          </el-sub-menu>

          <!-- 子项目 2：客户平台未回款金额看板 -->
          <el-sub-menu index="customerplatform">
            <template #title>
              <el-icon><Money /></el-icon>
              <span>客户平台未回款金额看板</span>
            </template>
            <el-menu-item index="/customer-platform-unpaid">
              <el-icon><Money /></el-icon><span>看板</span>
            </el-menu-item>
            <el-menu-item index="/customer-platform-detail">
              <el-icon><Document /></el-icon><span>订单明细</span>
            </el-menu-item>
          </el-sub-menu>

          <!-- 子项目 3：系统管理（只给管理员；路由守卫也会挡，这里隐藏只是别让人点进去再被弹回来） -->
          <el-menu-item v-if="isAdmin" index="/system">
            <el-icon><Setting /></el-icon><span>系统管理</span>
          </el-menu-item>
        </el-sub-menu>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="topbar">
        <div class="breadcrumb">
          <el-icon><HomeFilled /></el-icon>
          <span>{{ $route.meta.title }}</span>
        </div>

        <div class="topbar-right">
          <!-- 业务类型切换（仅在「未回款/未开票管理看板」下展示） -->
          <el-radio-group
            v-if="['/home', '/detail'].includes($route.path)"
            :model-value="biz.current"
            size="small"
            @change="onBizChange"
          >
            <el-radio-button value="billed_unpaid">已开票</el-radio-button>
            <el-radio-button value="shipped_uninvoiced">未开票</el-radio-button>
          </el-radio-group>

          <el-avatar :size="30" />
          <el-dropdown v-if="username" trigger="click" @command="onCommand">
            <span class="user-trigger">
              {{ username }}
              <el-tag
                v-if="roleText"
                :type="isAdmin ? 'warning' : 'info'"
                effect="plain"
                size="small"
                class="role-tag"
              >
                {{ roleText }}
              </el-tag>
              <el-icon class="caret"><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>
                  当前账号：{{ username }}（{{ roleText || '—' }}）
                </el-dropdown-item>
                <el-dropdown-item v-if="isMember" disabled>
                  成员账号：可查看看板、导出 Excel 并改备注，不能同步 / 进系统管理
                </el-dropdown-item>
                <!-- 本机登录过的其他账号：点一下就切过去（免密，但不能提权） -->
                <el-dropdown-item
                  v-for="acc in savedOthers"
                  :key="acc.u"
                  :command="'switch:' + acc.u"
                  divided
                >
                  切换为 {{ acc.u }}{{ roleLabel(acc.r) ? '（' + roleLabel(acc.r) + '）' : '' }}
                </el-dropdown-item>
                <el-dropdown-item command="switch-login" divided>其他账号登录…</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <span v-else class="user">未登录</span>
        </div>
      </el-header>

      <el-main class="content">
        <router-view :key="biz.current" />
      </el-main>
    </el-container>

    <!-- 移动端遮罩层 -->
    <div class="mobile-overlay" :class="{ 'mobile-overlay-active': mobileMenuOpen }" @click="closeMobileMenu"></div>
  </el-container>
</template>

<script setup>
import { ref, computed, onMounted, watch, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  DataAnalysis,
  Document,
  User,
  TrendCharts,
  Flag,
  Money,
  Setting,
  HomeFilled,
  ArrowDown,
  Grid,
  Menu,
  Search,
} from '@element-plus/icons-vue'
import { useBizStore } from '@/stores/biz'
import { logout, clearAuthToken, getAuthToken, setAuthToken } from '@/api'
import { loadAuth, useAuth, ROLE_LABEL } from '@/composables/useAuth'
import { listSaved, removeAccount } from '@/composables/savedAccounts'

// ------------------------------------------------------------
// 视口分三档，把「网页端」和「手机端」明确分开：
//   ≥1200      完整侧边栏（248px，文字 + 内联展开）
//   768–1199   图标模式（64px，鼠标悬停出子菜单）—— 平板 / 窄窗口仍算网页端
//   <768       手机：侧边栏离屏，汉堡按钮 + 抽屉
// 以前只有「768 以上一律完整、以下一律抽屉」两档，平板竖屏会被当成手机。
// ------------------------------------------------------------
const VIEW_WIDE = 1200
const VIEW_MOBILE = 768

const mobileMenuOpen = ref(false)
const isMobile = ref(false)
const isNarrow = ref(false)

function toggleMobileMenu() {
  mobileMenuOpen.value = !mobileMenuOpen.value
}

function closeMobileMenu() {
  mobileMenuOpen.value = false
}

function syncViewport() {
  const w = window.innerWidth
  isMobile.value = w < VIEW_MOBILE
  // 只有「窄，但不是手机」才收成图标模式
  isNarrow.value = !isMobile.value && w < VIEW_WIDE
  // 回到网页端就把手机抽屉关掉，免得它残留成打开状态
  if (!isMobile.value) mobileMenuOpen.value = false
}

window.addEventListener('resize', syncViewport)
onUnmounted(() => {
  window.removeEventListener('resize', syncViewport)
})

/** 侧边栏宽度：图标模式 64px，其余 248px（手机抽屉固定 248px，见样式） */
const asideWidth = computed(() => (isNarrow.value ? '64px' : '248px'))

// 上一次登录用的用户名（切换账号时给登录页预填用，避免同机换人再敲一遍）
const LAST_USER_KEY = 'cloud-dashboard:last-user'

// 角色权限比较：数字越大权限越高。免密切换只能「平级或降权」，不能提权
const ROLE_RANK = { member: 1, admin: 2 }
const roleRank = (r) => ROLE_RANK[r] || 0
const roleLabel = (r) => ROLE_LABEL[r] || ''

const biz = useBizStore()
const router = useRouter()
const route = useRoute()

const { username, role, roleText, isAdmin, isMember, resetAuth } = useAuth()

// 本机登录过的其他账号（下拉里「切换为 xxx」那些）
const savedOthers = ref([])

function onBizChange(val) {
  biz.setBizType(val)
}

async function onCommand(cmd) {
  // 免密切换：command 形如 switch:3905
  if (typeof cmd === 'string' && cmd.startsWith('switch:')) {
    const name = cmd.slice('switch:'.length)
    const target = listSaved().find((a) => a.u === name)
    // 正常情况能取到；万一列表被清了就退化成去登录页
    if (target) await switchTo(target)
    else await switchAccount()
    return
  }
  // 已没有独立的「退出登录」：它和下面这项功能完全重合（都会清掉登录态并落到登录页）
  if (cmd === 'switch-login') await switchAccount()
}

/**
 * 切换账号（重新登录）：点一下直接退出当前登录并回到登录页。
 *
 * 登录页会收到 /login?switch=1，据此预填上一个用户名、全选、光标落在用户名框：
 *   直接敲就是换人，不敲就 Tab 到密码给同一个人重登。
 */
async function switchAccount() {
  rememberLastUser(username.value || '')
  try {
    await logout()
  } catch {
    /* 后端不可达也要能切换 */
  }
  clearAuthToken()
  resetAuth()
  router.replace({ path: '/login', query: { switch: '1' } })
}

/** 记下用户名，登录页会读它做预填 */
function rememberLastUser(name) {
  try {
    localStorage.setItem(LAST_USER_KEY, name || '')
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 回登录页并预填某个用户名（免密切换不满足条件时的退路） */
function goLoginAs(name) {
  rememberLastUser(name)
  clearAuthToken()
  resetAuth()
  router.replace({ path: '/login', query: { switch: '1' } })
}

/** 刷新「本机登录过的其他账号」列表（排除当前账号自己） */
function refreshSaved() {
  savedOthers.value = listSaved().filter((a) => a.u && a.u !== username.value)
}

/**
 * 免密切换到另一个账号 —— 点一下就进，但**不允许提权**。
 *
 * 判定用的是「拿目标令牌问 /api/me 得到的结果」，而不是本地缓存的旧角色：
 *   1. 令牌失效（过期 / 改过密码 / 后端换密钥）→ 摘掉这条记录，回登录页
 *   2. 目标角色权限高于当前账号（成员→管理员）→ 回登录页输密码
 *   3. 平级或降权（管理员→成员）→ 直接切过去
 * 第 2 条是使用者 2026-09-23 明确要求的规则：能一键，但不能一键拿到管理员权限。
 */
async function switchTo(target) {
  const prevRole = role.value
  setAuthToken(target.t)
  resetAuth()
  await loadAuth()

  // loadAuth 之后 username / role 就是「这个令牌在后端眼里的真实身份」
  if (!username.value) {
    removeAccount(target.u)
    refreshSaved()
    goLoginAs(target.u)
    ElMessage.warning(`${target.u} 的登录已失效，请重新输入密码`)
    return
  }

  if (roleRank(role.value) > roleRank(prevRole)) {
    goLoginAs(target.u)
    ElMessage.info(`切换到${roleLabel(role.value) || '该'}账号需要输入密码`)
    return
  }

  refreshSaved()
  ElMessage.success(`已切换为 ${username.value}`)
  // 与登录页保持一致：成员落到「我的业绩」，其余回首页
  router.replace(role.value === 'member' ? '/my-performance' : '/')
}

// 路由守卫把「角色不够」的访问弹回首页时会带上 denied，这里给出明确原因，
// 否则用户只会看到自己莫名其妙回到了首页
watch(
  () => route.query.denied,
  (v) => {
    if (!v) return
    ElMessage.warning(`「${v}」仅管理员可访问，已返回首页`)
    router.replace({ path: route.path })
  },
  { immediate: true }
)

onMounted(async () => {
  // 首屏先按当前窗口宽度定档（宽 / 图标模式 / 手机抽屉）
  syncViewport()
  biz.loadBizTypes()
  // 拉一次 /api/me 填充账号与角色：顶栏显示、菜单显隐（系统管理）、
  // 导出 / 改备注的权限判断全靠它，少这一次调用整站的权限判断就全是空的
  await loadAuth()
  // 知道当前是谁之后，才能把「本机登录过的其他账号」里自己那条排除掉
  refreshSaved()
})

// 账号一变（登录 / 切换 / 退出）就刷新可切换列表
watch(username, refreshSaved)
</script>

<style scoped>
.app-layout { height: 100vh; position: relative; }
.sidebar { background-color: #001529; color: white; }
/* 菜单变成三层后按默认缩进会挤，这里把缩进收窄，长标题才放得下 248px 的侧边栏 */
.sidebar :deep(.el-menu) {
  --el-menu-base-level-padding: 18px;
  --el-menu-level-padding: 14px;
  border-right: none;
}
.logo {
  height: 60px;
  line-height: 60px;
  padding-left: 20px;
  font-weight: bold;
  background: #002140;
  color: #fff;
  font-size: 15px;
}
/* 图标模式（768–1199）：logo 只留符号并居中 */
.sidebar.narrow .logo {
  padding-left: 0;
  text-align: center;
}
.topbar {
  background: #fff;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #eee;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #606266;
  font-size: 14px;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  color: #606266;
}
.user { color: #606266; }
.user-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: #606266;
  outline: none;
}
.user-trigger:hover { color: #409eff; }
.role-tag { transform: scale(0.92); }
.caret { font-size: 12px; }
.content { background: #f0f2f5; padding: 20px; }

/* 移动端汉堡按钮 */
.mobile-menu-btn {
  display: none;
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 1000;
  width: 40px;
  height: 40px;
  background: #001529;
  border-radius: 4px;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
.mobile-menu-btn .el-icon {
  color: #fff;
  font-size: 20px;
}

/* 移动端遮罩层 */
.mobile-overlay {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 999;
}
.mobile-overlay-active {
  display: block;
}

/* 移动端响应式 */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }

  .sidebar {
    position: fixed;
    top: 0;
    left: -248px;
    width: 248px;
    height: 100vh;
    z-index: 1001;
    transition: left 0.3s ease;
  }

  .sidebar.mobile-open {
    left: 0;
  }

  .topbar {
    padding-left: 50px; /* 为汉堡按钮留出空间 */
  }

  /* 移动端隐藏不必要的元素 */
  .role-tag {
    display: none;
  }

  /* 移动端调整内容区域 */
  .content {
    padding: 10px;
  }

  /* 移动端调整表格 */
  :deep(.el-table) {
    font-size: 12px;
  }

  :deep(.el-table th),
  :deep(.el-table td) {
    padding: 8px 4px !important;
  }
}
</style>
