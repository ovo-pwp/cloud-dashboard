/**
 * 测试桩：冒充 sync.js，供自动化测试使用（不抓云端、不动数据）。
 *
 * 行为由环境变量决定，缺省「立刻成功退出」：
 *   STUB_EXIT_CODE=1      退出码（默认 0）
 *   STUB_SLEEP_MS=60000   进入导入前停留多久（默认 0），用来模拟「同步跑了很久」
 *   STUB_QUIET=1          不输出任何日志
 *
 * 配合后端环境变量 SYNC_SCRIPT_PATH 使用：
 *   SYNC_SCRIPT_PATH=server/test/stub-sync.mjs PORT=3100 node server/index.js
 */
const code = Number(process.env.STUB_EXIT_CODE || 0) || 0
const sleepMs = Number(process.env.STUB_SLEEP_MS || 0) || 0

if (!process.env.STUB_QUIET) {
  console.log(`[1/2] 抓取金山文档（桩）… 退出码=${code} 停留=${sleepMs}ms`)
  console.log('    桩脚本：跳过真实抓取，仅用于测试')
}

// 把「抓取」阶段拉长，模拟一个正在跑的同步（用于测试中途被打断）
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))

if (!process.env.STUB_QUIET) {
  console.log('[2/2] 导入数据库（桩）…')
  console.log(code === 0 ? '    全部完成（桩）' : '    桩脚本按配置失败退出')
}

process.exit(code)
