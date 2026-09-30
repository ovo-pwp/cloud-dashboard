/**
 * 一键完成 Cloudflare Tunnel 首次身份验证
 *
 * 用法：
 *   node deploy/tunnel/setup-tunnel.cjs
 *
 * 步骤：
 *   1. 从 .env 读取 TUNNEL_UUID 和 YOUR_HOSTNAME
 *   2. 用内置的 cloudflared.exe 执行 quic connect
 *   3. 打开浏览器完成 OAuth 授权
 *   4. 凭据自动写入 deploy/tunnel/.credentials.json
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const PROJECT_ROOT = resolve(__dirname, '../..')
const ENV_PATH = resolve(PROJECT_ROOT, '.env')
const CREDENTIALS_DIR = resolve(__dirname)
const CREDENTIALS_FILE = resolve(CREDENTIALS_DIR, '.credentials.json')
const CF_BIN = resolve(PROJECT_ROOT, 'cloudflared.exe')

// 简单解析 .env（KEY=VALUE，忽略注释行）
function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error('✖ 找不到 .env 文件，请先复制 .env.example 并填写必要项')
    process.exit(1)
  }
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n')
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
const tunnelUuid = env.TUNNEL_UUID?.trim()
const hostname = env.YOUR_HOSTNAME?.trim()

if (!tunnelUuid) {
  console.error('✖ .env 中未配置 TUNNEL_UUID')
  console.error('  请到 Cloudflare Zero Trust → Networks → Tunnels 创建 Tunnel 并复制 UUID')
  process.exit(1)
}
if (!hostname) {
  console.error('✖ .env 中未配置 YOUR_HOSTNAME')
  console.error('  请填写你的子域名，如 kanban.example.com')
  process.exit(1)
}
if (!existsSync(CF_BIN)) {
  console.error('✖ 找不到 cloudflared.exe，请确认项目根目录有该文件')
  process.exit(1)
}

mkdirSync(CREDENTIALS_DIR, { recursive: true })

if (existsSync(CREDENTIALS_FILE)) {
  console.log('⚠ 凭据文件已存在，跳过 OAuth 授权步骤')
  console.log(`  文件位置：${CREDENTIALS_FILE}`)
} else {
  console.log('🚀 开始 Cloudflare Tunnel 身份验证...')
  console.log(`   域名：${hostname}`)
  console.log(`   Tunnel UUID：${tunnelUuid}`)
  console.log('   请在弹出的浏览器中完成 OAuth 授权\n')

  try {
    execSync(
      `"${CF_BIN}" tunnel --url https://${hostname} quic connect ${tunnelUuid}`,
      { stdio: 'inherit', cwd: PROJECT_ROOT }
    )
    console.log('\n✔ Tunnel 身份验证成功！')
  } catch (err) {
    console.error('\n✖ 身份验证失败：', err.message)
    process.exit(1)
  }
}

console.log('\n✅ 设置完成！现在可以运行以下命令启动隧道：')
console.log(`   node deploy/tunnel/start-tunnel.cjs`)
