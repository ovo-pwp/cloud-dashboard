<template>
  <el-container class="app-layout">
    <el-aside width="220px" class="sidebar">
      <div class="logo">◆ 管理系统</div>
      <el-menu
        router
        :default-active="$route.path"
        :default-openeds="['dashboard']"
        background-color="#001529"
        text-color="#a6adb4"
        active-text-color="#fff"
      >
        <el-menu-item index="/homepage">
          <el-icon><HomeFilled /></el-icon>首页
        </el-menu-item>
        <el-sub-menu index="dashboard">
          <template #title>
            <el-icon><DataAnalysis /></el-icon>
            <span>未回款/未开票管理看板</span>
          </template>
          <el-menu-item index="/home">
            <el-icon><DataAnalysis /></el-icon>数据概览
          </el-menu-item>
          <el-menu-item index="/detail">
            <el-icon><Document /></el-icon>明细查询
          </el-menu-item>
          <el-menu-item index="/by-customer">
            <el-icon><User /></el-icon>按客户汇总
          </el-menu-item>
          <el-menu-item index="/trend">
            <el-icon><TrendCharts /></el-icon>每日趋势
          </el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="customerplatform">
          <template #title>
            <el-icon><Money /></el-icon>
            <span>客户平台未回款金额看板</span>
          </template>
          <el-menu-item index="/customer-platform-unpaid">
            <el-icon><Money /></el-icon>看板
          </el-menu-item>
          <el-menu-item index="/customer-platform-detail">
            <el-icon><Document /></el-icon>订单明细
          </el-menu-item>
        </el-sub-menu>
        <el-menu-item index="/system">
          <el-icon><Setting /></el-icon>系统管理
        </el-menu-item>
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
            v-if="['/home', '/detail', '/by-customer'].includes($route.path)"
            :model-value="biz.current"
            size="default"
            @change="onBizChange"
          >
            <el-radio-button value="billed_unpaid">已开票未回款</el-radio-button>
            <el-radio-button value="shipped_uninvoiced">已发货未开票</el-radio-button>
          </el-radio-group>

          <el-avatar :size="30" />
          <el-dropdown v-if="username" trigger="click" @command="onCommand">
            <span class="user-trigger">
              {{ username }}
              <el-icon class="caret"><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
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
  </el-container>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  DataAnalysis,
  Document,
  User,
  TrendCharts,
  Money,
  Setting,
  HomeFilled,
  ArrowDown,
} from '@element-plus/icons-vue'
import { useBizStore } from '@/stores/biz'
import { getMe, logout, clearAuthToken } from '@/api'

const biz = useBizStore()
const router = useRouter()
const username = ref('')

function onBizChange(val) {
  biz.setBizType(val)
}

async function onCommand(cmd) {
  if (cmd !== 'logout') return
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await logout()
  } catch {
    /* 后端不可达也要能退出 */
  }
  clearAuthToken()
  ElMessage.success('已退出登录')
  router.replace('/login')
}

onMounted(async () => {
  biz.loadBizTypes()
  try {
    const me = await getMe()
    username.value = me.loggedIn ? me.username || '' : ''
  } catch {
    username.value = ''
  }
})
</script>

<style scoped>
.app-layout { height: 100vh; }
.sidebar { background-color: #001529; color: white; }
.logo {
  height: 60px;
  line-height: 60px;
  padding-left: 20px;
  font-weight: bold;
  background: #002140;
  color: #fff;
  font-size: 15px;
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
  gap: 4px;
  cursor: pointer;
  color: #606266;
  outline: none;
}
.user-trigger:hover { color: #409eff; }
.caret { font-size: 12px; }
.content { background: #f0f2f5; padding: 20px; }
</style>
