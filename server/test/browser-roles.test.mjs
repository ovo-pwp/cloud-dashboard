/**
 * 真实浏览器回归：管理员 / 成员两种账号的界面表现
 *
 *   npm run test:browser:roles      （需要后端 3000 + 前端 dev server 5173 都在跑）
 *   前端不在默认地址时用 APP_URL 覆盖，例：APP_URL=http://localhost:5173 npm run test:browser:roles
 *
 * 为什么光有 audit.test.mjs 的接口断言不够：
 *   接口 403 只证明「拦得住」，证明不了「界面是否按角色藏起了入口」。
 *   而这类东西最容易静默回退 —— 新增一个路由忘了写 meta.roles、
 *   新加一个导出按钮忘了判断角色，接口测试一条都不会红。
 *
 * 这里走的是**深链接冷启动**（直接 Page.navigate 到 /detail、/system），
 * 覆盖的是「路由守卫在首屏就拿到角色」这条最容易出错的分支。
 * 令牌直接写进 localStorage，不经过登录表单（避开登录限流对测试的干扰）。
 *
 * 用零依赖的 Chrome headless + CDP。找不到 Chrome 或 dev server 不可达时
 * 打印原因并以 0 退出（跳过，而不是报一堆看不懂的错）。
 */
import 'dotenv/config'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { issueLoginToken, listAccounts } from '../services/syncAuth.js'

const APP = process.env.APP_URL || 'http://127.0.0.1:5173'
const OUT = 'test-results/browser/roles'
const LOGF = 'test-results/browser/roles/run.log'
// 日志同步落盘（stdout 重定向到文件是块缓冲的，进程被 kill 就丢输出）；
// 目录先建好，否则最初的几行会写不进去
try {
  fs.mkdirSync(path.dirname(LOGF), { recursive: true })
  fs.writeFileSync(LOGF, '')
} catch {
  /* ignore */
}
const TOKEN_KEY = 'cloud-dashboard:auth-token'

const log = (...a) => {
  const s = a.join(' ')
  process.stdout.write(s + '\n')
  try {
    fs.appendFileSync(LOGF, s + '\n')
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------ 断言收集
const results = []
/**
 * 控制台错误累积器必须声明在 try **外面**：finally 里要把它写进报告，
 * 而 try 块内声明的 const 在 finally 里是**不可见**的 —— 会抛 ReferenceError，
 * 再被一个空的 catch 吞掉，表现就是「报告文件凭空没生成」，极难查。
 */
const consoleErrors = []
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra })
  log(`  ${cond ? '✔' : '✖'} ${name}${extra ? `   ${extra}` : ''}`)
}

// ------------------------------------------------------------ CDP 客户端（每次调用带超时）
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
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时 ${timeoutMs}ms: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
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
    } catch {
      /* ignore */
    }
  }
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p))

const CDP_PORT = 9333
let chrome = null
let cdp = null
let userDataDir = null

try {
  if (!CHROME) {
    log('未找到 Chrome/Edge，跳过（可用 CHROME_PATH 指定）')
    process.exit(0)
  }
  try {
    if (!(await fetch(APP + '/')).ok) throw new Error('HTTP')
  } catch {
    log(`前端 dev server 不可达：${APP}，请先 npm run dev`)
    process.exit(0)
  }

  const accounts = listAccounts()
  const memberAcc = accounts.find((a) => a.role === 'member')
  const adminAcc = accounts.find((a) => a.role === 'admin')
  const TOKENS = {
    member: memberAcc ? issueLoginToken(memberAcc.username, false) : null,
    admin: adminAcc ? issueLoginToken(adminAcc.username, false) : null,
  }
  log(`账号：${JSON.stringify(accounts)}`)

  fs.mkdirSync(OUT, { recursive: true })

  userDataDir = path.join(os.tmpdir(), 'role-verify-' + Date.now())
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

  // 等调试目标
  let wsUrl = null
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) wsUrl = page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    if (!wsUrl) await sleep(250)
  }
  if (!wsUrl) throw new Error('连不上 Chrome 调试端口')

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

  // 秒消失的 toast 必须在文档加载前就挂上收集器
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
    if (r.exceptionDetails) {
      throw new Error('eval 失败: ' + (r.exceptionDetails.exception?.description || expr))
    }
    return r.result.value
  }

  const goto = async (url, settleMs = 2600) => {
    await cdp.send('Page.navigate', { url })
    for (let i = 0; i < 60; i++) {
      if ((await ev('document.readyState').catch(() => null)) === 'complete') break
      await sleep(100)
    }
    await sleep(settleMs)
  }

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    const f = path.join(OUT, name + '.png')
    fs.writeFileSync(f, Buffer.from(data, 'base64'))
    return f
  }

  const installToken = async (token) => {
    await goto(APP + '/login', 900)
    await ev(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)}); true`)
    const back = await ev(`localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`)
    if (back !== token) throw new Error('令牌没写进 localStorage')
  }

  const dump = () => `
    (function () {
      const txt = (s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\\s+/g,' ').trim() : '' }
      const menus = [...document.querySelectorAll('.el-menu-item')].map((e) => e.innerText.trim())
      const btns = [...document.querySelectorAll('button')].map((b) => ({
        text: b.innerText.replace(/\\s+/g,' ').trim(),
        disabled: b.disabled === true || b.classList.contains('is-disabled'),
      }))
      const exportBtn = btns.find((b) => b.text.includes('导出 Excel')) || null
      // 备注单元格：能编辑时 class 里带 note-editable，title 是「点击修改备注」
      const noteCells = [...document.querySelectorAll('.note')]
      return {
        path: location.pathname + location.search,
        title: document.title,
        userTrigger: txt('.user-trigger'),
        menus,
        hasSystemMenu: menus.some((m) => m.includes('系统管理')),
        exportBtn,
        noteEditable: noteCells.filter((e) => e.classList.contains('note-editable')).length,
        noteRows: noteCells.length,
        toasts: JSON.parse(JSON.stringify(window.__toasts || [])),
      }
    })()
  `

  const NOT_JS_ERROR = /Failed to load resource|favicon|Vue Devtools|Download the Vue/i
  const jsErrors = () => consoleErrors.filter((e) => !NOT_JS_ERROR.test(e))

  // ============================================================
  // 一、成员账号（能看数据 + 能导出；不能同步 / 进系统管理）
  // ============================================================
  if (TOKENS.member) {
    log('\n=== 一、成员账号（member）===')
    await installToken(TOKENS.member)

    // 深链接冷启动到 /detail
    await goto(APP + '/detail')
    const d = await ev(dump())
    log('  ' + JSON.stringify(d))
    check('成员：顶栏显示账号与「成员」角色', d.userTrigger.includes(memberAcc.username) && d.userTrigger.includes('成员'), d.userTrigger)
    check('成员：侧边栏没有「系统管理」', !d.hasSystemMenu, `菜单=${JSON.stringify(d.menus)}`)
    check('成员：明细页能看到数据（导出按钮存在）', !!d.exportBtn)
    check(
      '成员：「导出 Excel」按钮可点（成员有导出权限）',
      d.exportBtn && d.exportBtn.disabled === false,
      d.exportBtn ? `disabled=${d.exportBtn.disabled}` : ''
    )
    check(
      '成员：备注单元格可编辑（成员有改备注权限）',
      d.noteEditable > 0 && d.noteEditable === d.noteRows,
      `可编辑 ${d.noteEditable} / 共 ${d.noteRows} 行`
    )
    await shot('member-detail')

    // 悬停导出按钮：按钮是可用的，就不该冒出「没有导出权限」这类提示
    try {
      const box = await ev(`
        (function () {
          const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('导出 Excel'))
          if (!b) return null
          const r = b.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })()
      `)
      if (box) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
        await sleep(800)
        const tip = await ev(`
          (function () {
            const p = [...document.querySelectorAll('.el-popper')].map((e) => e.innerText.replace(/\\s+/g,' ').trim())
            return JSON.stringify(p.filter(Boolean))
          })()
        `)
        check('成员：悬停导出按钮不会出现「无导出权限」提示', !String(tip).includes('没有导出权限'), String(tip))
      }
    } catch (e) {
      log(`  · 悬停提示检查跳过：${e.message}`)
    }

    // 直接敲 /system：应当被弹回首页并给出原因
    await goto(APP + '/system')
    const s = await ev(dump())
    log('  ' + JSON.stringify(s))
    check('成员：直接访问 /system 被挡回首页', s.path.startsWith('/homepage'), `实际 ${s.path}`)
    check(
      '成员：弹出了「仅管理员可访问」的说明',
      s.toasts.some((t) => t.includes('仅管理员可访问')),
      JSON.stringify(s.toasts)
    )
    // 首页那张「系统管理」入口卡也不该出现（否则点了只会被弹回来）
    const entries = JSON.parse(
      await ev(`JSON.stringify([...document.querySelectorAll('.entry .e-name')].map((e) => e.innerText.trim()))`)
    )
    check(
      '成员：首页没有「系统管理」入口卡',
      !entries.some((t) => t.includes('系统管理')),
      JSON.stringify(entries)
    )
    await shot('member-system-denied')

    check('成员：整轮没有未捕获的 JS 异常', jsErrors().length === 0, jsErrors().slice(0, 3).join(' | '))
  } else {
    log('\n· 未配置 member 账号，跳过成员那一轮')
  }

  // ============================================================
  // 二、管理员账号
  // ============================================================
  if (TOKENS.admin) {
    log('\n=== 二、管理员账号 ===')
    consoleErrors.length = 0
    await installToken(TOKENS.admin)

    await goto(APP + '/detail')
    const d = await ev(dump())
    log('  ' + JSON.stringify(d))
    check('管理员：顶栏显示账号与「管理员」角色', d.userTrigger.includes('管理员'), d.userTrigger)
    check('管理员：侧边栏有「系统管理」', d.hasSystemMenu, `菜单=${JSON.stringify(d.menus)}`)
    check('管理员：「导出 Excel」按钮可用', d.exportBtn && d.exportBtn.disabled === false, d.exportBtn ? `disabled=${d.exportBtn.disabled}` : '')
    check(
      '管理员：备注单元格可编辑',
      d.noteEditable > 0 && d.noteEditable === d.noteRows,
      `可编辑 ${d.noteEditable} / 共 ${d.noteRows} 行`
    )
    await shot('admin-detail')

    await goto(APP + '/system')
    const s = await ev(dump())
    log('  ' + JSON.stringify(s))
    const body = await ev('document.body.innerText')
    check('管理员：/system 正常打开', s.path.startsWith('/system'), `实际 ${s.path}`)
    check('管理员：系统管理页内容已渲染', body.includes('数据同步') && body.includes('登录记录'))
    check(
      '管理员：登录记录里显示账号角色',
      /\（管理员\）/.test(body),
      (body.match(/已配置账号：[^\n]*/) || [''])[0]
    )
    check(
      '管理员：账号数量与 roles 一致',
      /（成员）/.test(body) && memberAcc && body.includes(memberAcc.username),
      (body.match(/已配置账号：[^\n]*/) || [''])[0]
    )
    await shot('admin-system')

    await goto(APP + '/homepage')
    const entries = JSON.parse(
      await ev(`JSON.stringify([...document.querySelectorAll('.entry .e-name')].map((e) => e.innerText.trim()))`)
    )
    check(
      '管理员：首页有「系统管理」入口卡',
      entries.some((t) => t.includes('系统管理')),
      JSON.stringify(entries)
    )
    check('管理员：整轮没有未捕获的 JS 异常', jsErrors().length === 0, jsErrors().slice(0, 3).join(' | '))
  } else {
    log('\n· 未配置 admin 账号，跳过管理员那一轮')
  }
} catch (err) {
  log(`\n!! 脚本异常：${err.message}`)
  results.push({ name: '脚本执行', ok: false, extra: err.message })
} finally {
  const failed = results.filter((r) => !r.ok)
  log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
  if (failed.length) log('失败项：' + failed.map((f) => f.name).join('；'))
  log(`截图目录：${OUT}`)
  try {
    fs.writeFileSync(
      path.join(OUT, 'report.json'),
      JSON.stringify({ results, consoleErrors }, null, 2),
      'utf8'
    )
  } catch (e) {
    // 别写成空 catch：报告没写出来时，至少要在日志里留下原因
    log(`  · report.json 写入失败：${e.message}`)
  }
  cdp?.close()
  try {
    chrome?.kill()
  } catch {
    /* ignore */
  }
  await sleep(300)
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(failed.length ? 1 : 0)
}
