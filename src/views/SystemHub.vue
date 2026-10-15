<template>
  <div class="container" v-loading="loading">
    <PageHeader title="总系统" sub="管理系统 · 项目汇总与入口中心" />

    <!-- ====== 快捷入口卡片 ====== -->
    <el-row :gutter="16" class="entries">
      <el-col :span="8" v-for="mod in visibleModules" :key="mod.id">
        <el-card shadow="hover" class="module-card" @click="go(mod.path)">
          <div class="mod-icon" :style="{ background: mod.color }">
            <el-icon><component :is="mod.icon" /></el-icon>
          </div>
          <div class="mod-body">
            <div class="mod-name">{{ mod.name }}</div>
            <div class="mod-desc">{{ mod.desc }}</div>
          </div>
          <el-tag v-if="mod.badge" :type="mod.badgeType" size="small" class="mod-badge">{{ mod.badge }}</el-tag>
        </el-card>
      </el-col>
    </el-row>

    <!-- ====== 系统状态 ====== -->
    <el-row :gutter="16" class="stats">
      <el-col :span="8">
        <div class="stat-card">
          <div class="stat-label">已配置账号数</div>
          <div class="stat-value">{{ stats.userCount }}</div>
          <div class="stat-sub">LOGIN_USERS 中配置的用户（当前角色：{{ roleText }}）</div>
        </div>
      </el-col>
      <el-col :span="8">
        <div class="stat-card">
          <div class="stat-label">最近同步</div>
          <div class="stat-value stat-ok">{{ stats.lastSyncDate || '—' }}</div>
          <div class="stat-sub">{{ stats.lastSyncStatus || '待同步' }}</div>
        </div>
      </el-col>
      <el-col :span="8">
        <div class="stat-card">
          <div class="stat-label">服务状态</div>
          <div class="stat-value stat-ok">{{ stats.dbUp ? '正常' : '—' }}</div>
          <div class="stat-sub">数据库连通</div>
        </div>
      </el-col>
    </el-row>

    <!-- ====== 模块列表详情 ====== -->
    <el-card class="block" shadow="never">
      <template #header>
        <div class="card-head">
          <b>模块列表</b>
          <span class="head-sub">点击卡片或「进入」跳转到对应页面</span>
        </div>
      </template>
      <el-table
        :data="visibleModules"
        border
        :header-cell-style="{ background: '#2c3e50', color: '#fff' }"
        style="width: 100%"
      >
        <el-table-column prop="id" label="ID" width="80" align="center" />
        <el-table-column prop="name" label="模块名称" width="220" />
        <el-table-column prop="desc" label="说明" min-width="200" />
        <el-table-column prop="path" label="路由" width="280">
          <template #default="{ row }">
            <code>{{ row.path }}</code>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="go(row.path)">进入</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ====== 项目规划 ====== -->
    <el-card class="block" shadow="never">
      <template #header><b>项目规划</b></template>
      <div class="plan-text">
        <p>「总系统」是管理系统的中心入口层，所有子项目/子看板都在此注册并展示。</p>
        <p>当前已接入：</p>
        <ul>
          <li>📊 未回款 / 未开票管理看板（billed_unpaid / shipped_uninvoiced）</li>
          <li>🏪 客户平台未回款金额看板（customer_platform_unpaid）</li>
          <li>🎯 待处理优先级清单（priority_actions · 只读）</li>
          <li>⚙️ 系统管理（数据同步、导入、用户、登录日志）</li>
        </ul>
        <p class="muted">新增项目只需在此注册一个模块卡片即可接入总系统，实现隔离与统一管理。</p>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import request from '@/api/request'
import { loadAuth, useAuth } from '@/composables/useAuth'
import PageHeader from '@/components/PageHeader.vue'

const router = useRouter()
const loading = ref(true)
const { roleText, isAdmin } = useAuth()
const stats = ref({ userCount: 0, lastSyncDate: '', lastSyncStatus: '待同步', dbUp: false })

// 三个子项目与侧边栏「总系统」下的目录一一对应
const modules = ref([
  {
    id: 1,
    name: '未回款/未开票管理看板',
    desc: '已开票未回款 · 已发货未开票 · 数据总览 · 明细查询 · 按客户汇总 · 每日趋势',
    path: '/home',
    icon: 'DataAnalysis',
    color: '#2563eb',
    badge: '主看板',
    badgeType: 'primary',
  },
  {
    id: 2,
    name: '客户平台未回款金额看板',
    desc: '客户平台订单级未回款数据，支持金额看板与订单明细',
    path: '/customer-platform-unpaid',
    icon: 'Money',
    color: '#7c3aed',
    badge: '独立模块',
    badgeType: 'warning',
  },
  {
    id: 3,
    name: '待处理优先级清单',
    desc: '按「金额 × 账龄」排出催收顺序，回答「先打哪个电话」',
    path: '/priority-actions',
    icon: 'Flag',
    color: '#dc2626',
    badge: '新',
    badgeType: 'danger',
  },
  {
    id: 4,
    name: '系统管理',
    desc: '数据同步 · Excel导入 · 用户管理 · 登录日志 · 系统配置（仅管理员可见）',
    path: '/system',
    icon: 'Setting',
    color: '#059669',
    badge: 'admin',
    badgeType: 'success',
    adminOnly: true,
  },
])

// 系统管理整页限管理员，成员看不到这张卡（点了也只会被挡回来）
const visibleModules = computed(() => modules.value.filter((m) => !m.adminOnly || isAdmin.value))


async function loadStats() {
  try {
    await loadAuth()
  } catch {
    // 认证加载失败不影响展示
  }
  // 注意：这三个接口返回的都是**对象**（{accounts}/{runs}/{ok}），不是数组，
  // 之前直接取 .length 会得到 undefined → 页面上永远显示 0 和「待同步」
  const [userRes, syncRes, healthRes] = await Promise.allSettled([
    request.get('/login-users').catch(() => null),
    request.get('/sync/runs?limit=1').catch(() => null),
    request.get('/health').catch(() => null),
  ])

  if (userRes.status === 'fulfilled') {
    stats.value.userCount = userRes.value?.accounts?.length ?? 0
  }
  if (syncRes.status === 'fulfilled') {
    const runs = syncRes.value?.runs ?? []
    if (runs.length > 0) {
      const s = runs[0]
      stats.value.lastSyncDate = s.finishedAt ? new Date(s.finishedAt).toLocaleString('zh-CN') : ''
      // 字段名是 ok（不是 success）；active 表示还在跑
      stats.value.lastSyncStatus = s.active ? '进行中' : s.ok ? '成功' : '失败'
    }
  }
  if (healthRes.status === 'fulfilled' && healthRes.value?.ok) {
    stats.value.dbUp = true
  }
}

function go(path) {
  router.push(path)
}

onMounted(async () => {
  await loadStats()
  loading.value = false
})
</script>

<style scoped>
/* 头部已交给 PageHeader 组件统一（标题/副标题间距、字号口径都在那里） */
.entries {
  margin-bottom: 20px;
}
.module-card {
  cursor: pointer;
  border-radius: 16px;
  transition: transform 0.15s, box-shadow 0.15s;
  position: relative;
  overflow: hidden;
  padding: 20px;
}
.module-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
}
.mod-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 24px;
  margin-bottom: 12px;
}
.mod-body {
  margin-bottom: 12px;
}
.mod-name {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 6px;
}
.mod-desc {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.5;
}
.mod-badge {
  margin-top: 8px;
}
.stats {
  margin-bottom: 20px;
}
.stat-card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  padding: 20px;
  text-align: center;
}
.stat-label {
  font-size: 13px;
  color: #6b7280;
  margin-bottom: 8px;
}
.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: #1f2937;
}
.stat-ok {
  color: #059669;
}
.stat-sub {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 4px;
}
.plan-text {
  font-size: 14px;
  line-height: 1.8;
  color: #374151;
}
.plan-text ul {
  margin: 8px 0 8px 20px;
}
.plan-text li {
  margin: 4px 0;
}
.muted {
  color: #9ca3af;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .container { padding: 10px; }
  /* 头部字号/间距由 PageHeader 组件自己处理 */

  .modules { margin-bottom: 12px; }
  :deep(.modules .el-col) { margin-bottom: 8px; }
  .module-card { padding: 16px 12px; }
  .module-ico { font-size: 32px; }
  .module-name { font-size: 13px; }
  .module-desc { font-size: 11px; }
}
</style>
