/**
 * 启动 Cloudflare Tunnel（内网穿透）
 *
 * 用法：
 *   node deploy/tunnel/start-tunnel.cjs          # 前台运行（终端开着才有隧道）
 *   npm run tunnel                               # 同等于上面
 *
 * 隧道建立后访问：https://YOUR_HOSTNAME
 * 按 Ctrl+C 停止隧道。
 *
 * 架构说明：
 *   只需把 YOUR_HOSTNAME 指向本机 Vite dev server（localhost:5173），
 *   前端静态资源 + /api/* 反代都由 Vite dev server 的 proxy 配置完成，
 *   一个 tunnel 端口同时覆盖前后端，无混合协议问题。
 *
 * 前置条件：
 *   1. 先跑完 setup-tunnel.cjs 完成 OAuth 授权
 *   2. 另一个终端跑 npm run dev（起 Vite + Node 后端）
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const PROJECT_ROOT = resolve(__dirname, '../..')
const CF_BIN = resolve(PROJECT_ROOT, 'cloudflared.exe')
const TUNNEL_YML = resolve(__dirname, 'tunnel.yml')
const CREDENTIALS_FILE = resolve(__dirname, '.credentials.json')

// 简单解析 .env
function loadEnv() {
  const envPath = resolve(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) {
    console.error('✖ 找不到 .env 文件')
    process.exit(1)
  }
  const lines = require('node:fs').readFileSync(envPath, 'utf8').split('\n')
  const env = {}
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx <= 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    env[key] = val
  }
  return env
}

const env = loadEnv()
const enabled = env.TUNNEL_ENABLED === 'true'
const tunnelUuid = env.TUNNEL_UUID?.trim()
const hostname = env.YOUR_HOSTNAME?.trim()

if (!enabled) {
  console.log('ℹ  TUNNEL_ENABLED 未开启，如需启动隧道请编辑 .env：')
  console.log('   TUNNEL_ENABLED=true')
  console.log('   TUNNEL_UUID=<你的Tunnel UUID>')
  console.log('   YOUR_HOSTNAME=kanban.example.com')
  console.log('')
  console.log('首次使用请运行：node deploy/tunnel/setup-tunnel.cjs')
  process.exit(0)
}

if (!tunnelUuid) {
  console.error('✖ .env 中未配置 TUNNEL_UUID')
  process.exit(1)
}
if (!hostname) {
  console.error('✖ .env 中未配置 YOUR_HOSTNAME')
  process.exit(1)
}
if (!existsSync(CF_BIN)) {
  console.error('✖ 找不到 cloudflared.exe，请确认项目根目录有该文件')
  process.exit(1)
}
if (!existsSync(CREDENTIALS_FILE)) {
  console.error('✖ 凭据文件不存在，请先运行：node deploy/tunnel/setup-tunnel.cjs')
  process.exit(1)
}

// 生成 tunnel.yml（每次启动时动态注入 UUID，方便切换）
const ymlContent = `tunnel: ${tunnelUuid}
credentials-file: ${CREDENTIALS_FILE}

ingress:
  - hostname: ${hostname}
    service: http://localhost:5173
  - service: http_status:404
`
writeFileSync(TUNNEL_YML, ymlContent)
console.log(`✔ tunnel.yml 已更新：${TUNNEL_YML}`)
console.log('')
console.log('🌐 隧道正在启动...')
console.log(`   访问地址：https://${hostname}`)
console.log('   按 Ctrl+C 停止隧道\n')

const tunnel = spawn(CF_BIN, ['tunnel', 'run', '--config', TUNNEL_YML], {
  stdio: 'inherit',
  cwd: PROJECT_ROOT,
})

tunnel.on('error', (err) => {
  console.error('✖ 启动隧道失败：', err.message)
  process.exit(1)
})

tunnel.on('close', (code) => {
  console.log(`\n隧道已退出（退出码 ${code}）`)
  process.exit(code ?? 0)
})
