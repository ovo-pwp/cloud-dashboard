/**
 * 真实浏览器端到端验证（Chrome headless + CDP，不依赖 playwright）
 *
 *   npm run test:browser      （需要前端已跑在 127.0.0.1:5173）
 *
 * 也可对着部署好的容器跑（注意端口是 80，不是 5173）：
 *   APP_URL=http://127.0.0.1/ TEST_LOGIN_USER=xxx TEST_LOGIN_PASSWORD=yyy npm run test:browser
 *
 * 覆盖三条最容易出错的路径：
 *   1. 冷启动（从未登录）→ 应静默跳登录页，不弹「登录已过期」
 *   2. 正常登录 → 应进入首页并持有令牌
 *   3. 令牌被改坏后再访问 → 应弹「登录已过期」并回登录页
 *
 * 截图输出到 test-results/browser/。
 */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CDP_PORT = Number(process.env.CDP_PORT) || 9222
const APP = process.env.APP_URL || 'http://127.0.0.1:5173'
// 账号默认从 .env 取（与后端同一份配置）：密码在 .env 里改过之后，
// 测试不该还拿旧值去登（那样会以「登录失败」的样子报出来，容易误判成功能坏了）
const TEST_USER = process.env.TEST_LOGIN_USER || process.env.LOGIN_USER || '4111'
const TEST_PASS = process.env.TEST_LOGIN_PASSWORD || process.env.LOGIN_PASSWORD || '4111'
const TOKEN_KEY = 'cloud-dashboard:auth-token'
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SHOTS = path.join(PROJECT_ROOT, 'test-results', 'browser')

fs.mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ✘ ${label}${extra ? '  ' + extra : ''}`)
  }
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      ws.onopen = () => {
        this.ws = ws
        resolve()
      }
      ws.onerror = (e) => reject(new Error('ws error: ' + (e?.message || 'unknown')))
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
        } else if (msg.method) {
          for (const h of this.handlers.get(msg.method) || []) h(msg.params)
        }
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, h) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(h)
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/* ---------------- 启动 Chrome ---------------- */

/** 前置检查：没有 Chrome 或前端没起，就明确跳过而不是报一堆看不懂的错 */
async function preflight() {
  if (!fs.existsSync(CHROME)) {
    console.log(`\n  ⚠ 未找到 Chrome：${CHROME}`)
    console.log('    可用 CHROME_PATH=<chrome.exe 路径> 指定，或跳过本项验证。')
    process.exit(0)
  }
  try {
    const r = await fetch(APP + '/')
    if (!r.ok) throw new Error('HTTP ' + r.status)
  } catch (err) {
    console.log(`\n  ⚠ 前端 dev server 不可达：${APP}（${err.message}）`)
    console.log('    请先执行 npm run dev:web（或 npm run dev），再跑本测试。')
    process.exit(0)
  }
}

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('Chrome 调试端口未就绪')
}

let cdp
let chrome
let userDataDir
const consoleErrors = []

async function main() {
  await preflight()

  userDataDir = path.join(os.tmpdir(), 'cd-verify-' + Date.now())
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false }
  )

  const wsUrl = await waitForTarget()
  cdp = new CDP(wsUrl)
  await cdp.connect()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')

  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') consoleErrors.push(entry.text)
  })
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    consoleErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || 'exception')
  })

  // 每次文档加载前注入：把屏幕上出现过的提示气泡记录下来
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__toasts = [];
      (function () {
        const push = () => {
          document.querySelectorAll('.el-message, .el-message__content').forEach((el) => {
            const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
            if (t && !window.__toasts.includes(t)) window.__toasts.push(t);
          });
        };
        const mo = new MutationObserver(push);
        const start = () => {
          if (!document.documentElement) return setTimeout(start, 10);
          mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
          push();
        };
        start();
      })();
    `,
  })

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error('eval 失败: ' + (r.exceptionDetails.exception?.description || expr))
    return r.result.value
  }

  const goto = async (url, settleMs = 2600) => {
    await cdp.send('Page.navigate', { url })
    for (let i = 0; i < 60; i++) {
      const ready = await ev(`document.readyState`).catch(() => null)
      if (ready === 'complete') break
      await sleep(100)
    }
    await sleep(settleMs)
  }

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'))
    console.log(`     → 截图 ${path.relative(PROJECT_ROOT, path.join(SHOTS, name + '.png'))}`)
  }

  console.log('\n=== 1. 冷启动（从未登录，localStorage 空） ===')
  await goto(APP + '/')
  await ev(`localStorage.clear()`)
  await goto(APP + '/')
  const p1 = await ev(`location.pathname`)
  const t1 = JSON.parse(await ev(`JSON.stringify(window.__toasts || [])`))
  const hasForm1 = await ev(`!!document.querySelector('input[placeholder="请输入用户名"]')`)
  ok(p1 === '/login', '冷启动被重定向到登录页', `pathname=${p1}`)
  ok(hasForm1, '登录表单已渲染')
  ok(!t1.some((t) => t.includes('登录已过期')), '冷启动不弹「登录已过期」', `toasts=${JSON.stringify(t1)}`)
  await shot('1-cold-start-login')

  console.log(`\n=== 2. 正常登录 ${TEST_USER} / ${'*'.repeat(TEST_PASS.length)} ===`)
  // 用 JSON.stringify 注入，避免账号密码里有引号时把表达式写坏
  await ev(`
    (function () {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        d.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(document.querySelector('input[placeholder="请输入用户名"]'), ${JSON.stringify(TEST_USER)});
      set(document.querySelector('input[placeholder="请输入密码"]'), ${JSON.stringify(TEST_PASS)});
      return true;
    })()
  `)
  const filled = await ev(`
    document.querySelector('input[placeholder="请输入用户名"]').value + '|' +
    document.querySelector('input[placeholder="请输入密码"]').value
  `)
  ok(filled === `${TEST_USER}|${TEST_PASS}`, '表单已填入账号密码', `length=${filled.length}`)

  await ev(`document.querySelector('button.el-button--primary').click()`)
  await sleep(3000)
  const p2 = await ev(`location.pathname`)
  const token2 = await ev(`localStorage.getItem('${TOKEN_KEY}') || ''`)
  const t2 = JSON.parse(await ev(`JSON.stringify(window.__toasts || [])`))
  ok(p2 !== '/login', '登录后离开登录页', `pathname=${p2}`)
  ok(token2.length > 20, '登录令牌已写入 localStorage', `长度 ${token2.length}`)
  ok(!t2.some((t) => t.includes('登录已过期')), '正常登录不误报过期', `toasts=${JSON.stringify(t2)}`)
  await shot('2-after-login')

  console.log('\n=== 3. 令牌被改坏后再访问（应提示过期） ===')
  await ev(`localStorage.setItem('${TOKEN_KEY}', 'bogus.badtoken')`)
  await goto(APP + '/')
  await sleep(600)
  const p3 = await ev(`location.pathname`)
  const t3 = JSON.parse(await ev(`JSON.stringify(window.__toasts || [])`))
  const token3 = await ev(`localStorage.getItem('${TOKEN_KEY}') || ''`)
  ok(t3.some((t) => t.includes('登录已过期')), '坏令牌触发「登录已过期」提示', `toasts=${JSON.stringify(t3)}`)
  ok(p3 === '/login', '坏令牌被踢回登录页', `pathname=${p3}`)
  ok(token3 === '', '失效令牌已从 localStorage 清除')
  await shot('3-token-expired')

  console.log('\n=== 4. 控制台错误 ===')
  // 排除两类「预期噪音」：
  //   1. favicon / Vue Devtools 提示
  //   2. 浏览器对 401 响应的网络日志 —— 未登录时 /api/me 返回 401 是设计行为，
  //      它由前端拦截器正常处理，不是 JS 异常
  const realErrors = consoleErrors.filter(
    (e) =>
      !/favicon|Download the Vue Devtools/i.test(e) &&
      !/Failed to load resource/i.test(e),
  )
  ok(realErrors.length === 0, '页面无未捕获运行时错误', realErrors.length ? JSON.stringify(realErrors.slice(0, 3)) : '')

  const http401 = consoleErrors.filter((e) => /401/.test(e)).length
  ok(http401 > 0, '401 由拦截器处理（网络层记录但无 JS 异常）', `${http401} 次`)

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  return fail === 0 ? 0 : 1
}

let code = 1
try {
  code = await main()
} catch (err) {
  console.error('验证脚本异常：', err.message)
  code = 1
} finally {
  cdp?.close()
  try {
    chrome.kill()
  } catch {}
  await sleep(300)
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {}
}
process.exit(code)
