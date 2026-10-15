<template>
  <!-- 中文 locale 由 ElConfigProvider 提供。
       2026-10-10 改成 Element Plus 按需注册后，不能再靠 app.use(ElementPlus, { locale }) —— 
       缺了它，分页「共 N 条 / 前往」、日期选择器等会变成英文。 -->
  <el-config-provider :locale="zhCn">
    <router-view />

    <!-- 「旧页面 + 新发布」的兜底提示。
         每次发版都会换掉构建文件名，浏览器里开着的旧页面再去加载懒加载路由就会 404，
         表现是「地址变了、内容还是上一页」甚至一直转圈。
         这里只提示、不自动刷新 —— 页面上可能有没保存的备注。 -->
    <div v-if="mustReload || hasNewVersion" class="ver-bar">
      <div class="ver-text">
        <b>{{ mustReload ? '页面已过期，需要刷新才能继续' : '系统已发布新版本' }}</b>
        <span>{{ mustReload ? '刚才那次跳转没加载成功，刷新一下即可。' : '刷新后可以看到最新数据与改动。' }}</span>
      </div>
      <el-button type="primary" size="small" @click="reloadPage">立即刷新</el-button>
    </div>
  </el-config-provider>
</template>

<script setup>
import { onMounted } from 'vue'
import { ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { hasNewVersion, mustReload, reloadPage, startVersionWatch } from '@/composables/useVersionCheck'

onMounted(startVersionWatch)
</script>

<style>
html, body, #app {
  height: 100%;
  margin: 0;
  padding: 0;
  background-color: #f0f2f5;
}

/* 右下角常驻提示条：不挡住内容，也不自动消失（刷新前它一直有用） */
.ver-bar {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 3000;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  color: #303133;
}
.ver-text { display: flex; flex-direction: column; gap: 2px; max-width: 300px; }
.ver-text span { color: #909399; font-size: 12px; }
</style>
