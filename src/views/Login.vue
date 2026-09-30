<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="brand">
        <div class="logo">云</div>
        <h1 class="title">云端看板</h1>
        <p class="subtitle">应收 / 开票管理</p>
      </div>

      <el-alert
        v-if="switching"
        type="info"
        :closable="false"
        show-icon
        class="switch-tip"
      >
        已退出当前账号，请用另一个账号登录
      </el-alert>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        @submit.prevent="onSubmit"
      >
        <el-form-item label="用户名" prop="username">
          <el-input
            ref="userRef"
            v-model="form.username"
            placeholder="请输入用户名"
            size="large"
            autocomplete="username"
            :prefix-icon="User"
          />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            size="large"
            show-password
            autocomplete="current-password"
            :prefix-icon="Lock"
            @keyup.enter="onSubmit"
          />
        </el-form-item>

        <div class="row-between">
          <el-checkbox v-model="form.remember" size="default">记住我</el-checkbox>
          <span class="remember-hint">保持登录 {{ REMEMBER_DAYS }} 天</span>
        </div>

        <el-alert
          v-if="lockedUntil > 0"
          type="error"
          :closable="false"
          show-icon
          class="lock-tip"
        >
          尝试次数过多，登录已暂时锁定，请约 {{ lockedUntil }} 分钟后再试。
        </el-alert>

        <el-button
          type="primary"
          size="large"
          class="submit"
          :loading="loading"
          @click="onSubmit"
        >
          {{ loading ? '登录中…' : '登 录' }}
        </el-button>
      </el-form>

      <p class="tip">
        本系统仅供内部使用，登录信息在 <code>.env</code> 中配置。
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import { login, setAuthToken, getMe, clearAuthToken } from '@/api'
import { saveAccount } from '@/composables/savedAccounts'

const router = useRouter()
const route = useRoute()

const formRef = ref(null)
const userRef = ref(null)
const loading = ref(false)
// 被限流时剩余的锁定分钟数；0 表示未被锁定
const lockedUntil = ref(0)

// 顶栏「切换账号」跳过来时带 ?switch=1：预填上一个用户名、光标落在密码框
const switching = route.query.switch === '1'
const LAST_USER_KEY = 'cloud-dashboard:last-user'

function readLastUser() {
  try {
    return localStorage.getItem(LAST_USER_KEY) || ''
  } catch {
    return ''
  }
}

function saveLastUser(name) {
  try {
    localStorage.setItem(LAST_USER_KEY, name || '')
  } catch {
    /* 隐私模式忽略 */
  }
}

// 记住登录状态：开启时写入 localStorage，否则只在本次会话内有效
const REMEMBER_KEY = 'cloud-dashboard:remember'
const REMEMBER_DAYS = 7

const savedRemember = (() => {
  try {
    return localStorage.getItem(REMEMBER_KEY) === '1'
  } catch {
    return false
  }
})()

const form = reactive({ username: switching ? readLastUser() : '', password: '', remember: savedRemember })

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

onMounted(async () => {
  // 已登录则直接进入目标页，无需重复登录
  try {
    const me = await getMe()
    if (me.loggedIn) {
      router.replace(route.query.redirect || '/')
      return
    }
  } catch {
    /* 未登录，留在本页 */
  }
  // 切换账号过来：用户名已预填并**全选**、光标落在用户名框 ——
  // 直接敲就是换人（覆盖掉预填的），不敲就 Tab 到密码给同一个人重登，两种都顺手
  if (switching) {
    nextTick(() => {
      userRef.value?.focus()
      userRef.value?.select()
    })
  }
})

async function onSubmit() {
  if (loading.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }

  loading.value = true
  // 每次尝试都重新以服务端返回为准（服务端才是限流的唯一权威）
  lockedUntil.value = 0
  try {
    // 记住登录状态的偏好存下来，下次打开登录页自动勾选
    try {
      localStorage.setItem(REMEMBER_KEY, form.remember ? '1' : '0')
    } catch {
      /* 隐私模式忽略 */
    }

    const r = await login(form.username, form.password, form.remember)
    if (!r.token) {
      // 后端未启用登录保护
      clearAuthToken()
      router.replace(route.query.redirect || '/')
      return
    }
    setAuthToken(r.token)
    // 记下这次用的用户名，下次「切换账号」时预填
    saveLastUser(form.username.trim())
    // 并存一份令牌到「本机账号」列表，供顶栏一键切换（只存令牌，不存密码）
    saveAccount({ username: r.username || form.username.trim(), role: r.role, token: r.token })
    ElMessage.success(
      form.remember ? `登录成功，${REMEMBER_DAYS} 天内免登录` : '登录成功'
    )
    // 成员账号直接进「我的业绩」，管理员进首页
    const role = r.role || ''
    const target = role === 'member' ? '/my-performance' : (route.query.redirect || '/')
    router.replace(target)
  } catch (err) {
    const data = err?.response?.data
    const status = err?.response?.status

    // 被限流：明确告知还要等多久
    if (status === 429 || data?.code === 'TOO_MANY_ATTEMPTS') {
      const mins = Math.max(1, Math.ceil((data?.retryAfterSec || 0) / 60))
      lockedUntil.value = mins
      ElMessage.error(data?.error || `尝试次数过多，请 ${mins} 分钟后再试`)
      return
    }

    // 密码错：提示还剩几次机会，快用完时标红
    if (status === 401) {
      const left = data?.remaining
      if (typeof left === 'number' && left > 0 && left <= 2) {
        ElMessage.error(`用户名或密码不正确，还可以尝试 ${left} 次`)
      } else {
        ElMessage.error('用户名或密码不正确')
      }
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #2c3e50 0%, #34495e 55%, #3d566e 100%);
  padding: 20px;
  box-sizing: border-box;
}

.login-card {
  width: 100%;
  max-width: 400px;
  background: #fff;
  border-radius: 10px;
  padding: 40px 36px 28px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
}

.brand { text-align: center; margin-bottom: 28px; }

.logo {
  width: 56px;
  height: 56px;
  margin: 0 auto 14px;
  border-radius: 14px;
  background: #2c3e50;
  color: #fff;
  font-size: 26px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.title { font-size: 22px; margin: 0 0 6px; color: #2c3e50; letter-spacing: 2px; }
.subtitle { font-size: 13px; color: #909399; margin: 0; letter-spacing: 1px; }

.submit { width: 100%; margin-top: 4px; letter-spacing: 4px; }

.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -6px 0 18px;
}

.remember-hint { font-size: 12px; color: #c0c4cc; }

.lock-tip { margin-bottom: 14px; }
.lock-tip :deep(.el-alert__content) { font-size: 12px; line-height: 1.6; }

/* 从顶栏「切换账号」过来时的提示 */
.switch-tip { margin-bottom: 18px; }
.switch-tip :deep(.el-alert__content) { font-size: 13px; line-height: 1.6; }

:deep(.el-checkbox__label) { font-size: 13px; }

.tip {
  color: #c0c4cc;
  font-size: 12px;
  text-align: center;
  margin: 22px 0 0;
  line-height: 1.6;
}
.tip code { background: #f5f7fa; padding: 1px 5px; border-radius: 3px; color: #909399; }

:deep(.el-form-item__label) { font-weight: 500; }
</style>
