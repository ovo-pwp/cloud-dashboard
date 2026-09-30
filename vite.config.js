import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    // 不加 host 时 Vite 绑的是 localhost，在 Node 17+ 上只会监听 IPv6 回环 [::1]，
    // 于是 http://127.0.0.1:5173 直连不通（server/test/browser-*.test.mjs 用的就是这个地址）。
    // 显式绑 127.0.0.1 后 127.0.0.1 与 localhost 都能访问，且不对外暴露 dev server。
    // 需要局域网同事直接开 dev server 时改成 host: true（绑 0.0.0.0）。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true, // 端口被占用时直接报错，避免静默漂移到 5174/5175 造成多实例
    open: false,
    proxy: {
      // 前端请求 /api/* 转发到后端，解决跨域
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
