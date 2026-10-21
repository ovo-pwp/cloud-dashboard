/**
 * 定时轮询调度器：定期从金山文档/WPS 拉取最新数据并自动导入 PostgreSQL
 *
 * 工作流：
 *   1. 定时调用 kdocs_pull.py 拉取三张表，落到 IMPORT_WATCH_FOLDER
 *   2. 拉取完成后，直接对目标文件执行 importExcel / importCustomerPlatformUnpaid
 *   3. 失败静默重试（记录日志），不中断后端服务
 *
 * 配置（.env）：
 *   KDOCS_SCHEDULER_ENABLED=true        # 是否启用（默认 false）
 *   KDOCS_SCHEDULER_INTERVAL_MIN=60     # 轮询间隔（分钟），默认 60，最小 1
 *   PYTHON_PATH=C:/Users/.../python.exe # Python 路径
 *   KDOCS_PULL_SCRIPT=C:/Users/.../kdocs_pull.py  # 抓取脚本路径
 *   IMPORT_WATCH_FOLDER=C:/Users/.../应收看板-数据导出  # 导出目录
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveExecutable } from './utils/executable.js'
import path from 'path'

import { pool, query } from './db/pool.js'
import { todayDate } from './utils/date.js'
import {
  importExcel,
  importCustomerPlatformUnpaid,
  CUSTOMER_PLATFORM_BIZ_TYPE,
} from './services/importer.js'
// 每天备份一次数据库：历史快照不可再生（源表只有「当前状态」），丢了无法重建
import { runBackup } from './services/dbBackup.js'
import {
  CUSTOMER_INVOICE_BIZ_TYPE,
  CUSTOMER_INVOICE_OUT_NAME,
  importCustomerInvoice,
  importCustomerRecon,
} from './services/customerInvoice.js'
import {
  acquireSyncLock,
  releaseSyncLock,
  pushSyncLog,
} from './services/syncRunner.js'

// ------------------------------------------------------------
// 配置
// ------------------------------------------------------------
const ENABLED = process.env.KDOCS_SCHEDULER_ENABLED === 'true'
const INTERVAL_MIN = Math.max(1, Number(process.env.KDOCS_SCHEDULER_INTERVAL_MIN) || 60)
const INTERVAL_MS = INTERVAL_MIN * 60 * 1000

const PYTHON =
  process.env.PYTHON_PATH ||
  'C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe'

// PYTHON 可能是绝对路径（本机 Windows），也可能是命令名（容器里的 python3）。
// 必须经 resolveExecutable 解析 —— 直接 existsSync('python3') 恒为 false，
// 会让定时同步永远卡在「Python 不存在」。
const PYTHON_BIN = resolveExecutable(PYTHON)

const PULL_SCRIPT =
  process.env.KDOCS_PULL_SCRIPT ||
  'C:/Users/Administrator/Desktop/看板模板/kdocs_pull.py'

// 抓取输出目录：优先 EXPORT_DIR（与 sync.js 同一个变量），
// 再退回 IMPORT_WATCH_FOLDER（监控目录，本项目里与导出目录是同一个），避免两处配岔
const EXPORT_DIR = (
  process.env.EXPORT_DIR ||
  process.env.IMPORT_WATCH_FOLDER ||
  'C:/Users/Administrator/Desktop/应收看板-数据导出'
).replace(/\\/g, '/')

// 与 sync.js 保持一致的表映射
const TABLE_SPECS = [
  { bizType: 'billed_unpaid',           outName: '(已开票未回款-每天)未回款.xlsx' },
  { bizType: 'shipped_uninvoiced',      outName: '(已发货未开票-每天)未开票.xlsx' },
  { bizType: 'customer_platform_unpaid', outName: '(客户未回款平台)未回款.xlsx' },
  { bizType: CUSTOMER_INVOICE_BIZ_TYPE, outName: CUSTOMER_INVOICE_OUT_NAME },
  // ⚠️ 2026-10-12 补：客户对账明细表（123）—— 先前漏了，导致「每日发货·回款」的左侧数据不更新
  { bizType: 'customer_recon', outName: '(客户对账明细表)对账.xlsx' },
]

// ------------------------------------------------------------
// 报表降频（2026-10-21）
//
// 背景：同步从 5-7 秒涨到 17 秒，实测 95% 的时间都在等金山文档接口
//   （12 次分页往返，每次约 1 秒），入库只占 0.58 秒。
//   而「客户开票明细」「客户对账明细」这两张报表是按天出数的，
//   每小时拉一次纯属浪费 —— 它们占了 5 次分页请求（约 6 秒）。
//
// 做法：主表（未回款/未开票/客户平台）每小时照常拉；
//   两张报表每 REPORTS_REFRESH_HOURS 小时才拉一次，其余轮次连导入也一起跳过
//   （不导旧文件，避免拿陈旧 xlsx 去全量替换，也省掉无谓的写库）。
// ------------------------------------------------------------
const REPORT_BIZ_TYPES = new Set([CUSTOMER_INVOICE_BIZ_TYPE, 'customer_recon'])
const CORE_SPECS = TABLE_SPECS.filter((s) => !REPORT_BIZ_TYPES.has(s.bizType))
const REPORT_SPECS = TABLE_SPECS.filter((s) => REPORT_BIZ_TYPES.has(s.bizType))

/** 报表刷新间隔（小时），默认 6；想恢复每小时全量就把环境变量设成 1 */
const REPORTS_REFRESH_HOURS = Math.max(1, Number(process.env.REPORTS_REFRESH_HOURS) || 6)
const REPORTS_STATE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '.runtime',
  'reports-pull.json'
)

/** 距上次拉报表是否已超过间隔（没有记录时返回 true = 该拉了） */
function reportsDue() {
  try {
    const t = Number(JSON.parse(readFileSync(REPORTS_STATE_FILE, 'utf8')).lastAt || 0)
    if (!t) return true
    return Date.now() - t >= REPORTS_REFRESH_HOURS * 3600 * 1000
  } catch {
    return true
  }
}

/** 记录本次拉报表的时间；写失败只记日志，绝不影响同步结果 */
function markReportsPulled() {
  try {
    mkdirSync(path.dirname(REPORTS_STATE_FILE), { recursive: true })
    writeFileSync(
      REPORTS_STATE_FILE,
      JSON.stringify({ lastAt: Date.now(), at: new Date().toISOString() }, null, 2)
    )
  } catch (e) {
    errLog('记录报表拉取时间失败（不影响同步）: ' + e.message)
  }
}

// ------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------

/** 本轮同步的日志缓冲，结束时落库到 sync_run.log */
let runLines = []

/** 仅打印到控制台的启动提示（不进网页端同步日志，避免干扰同步记录） */
function notice(msg) {
  console.log('[scheduler] ' + msg)
}

function log(...args) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false })
  console.log('[scheduler] ' + ts, ...args)
  // 同步进「系统管理」页的同步日志，网页端能看到定时任务在干什么
  pushSyncLog(`[scheduler] ${args.join(' ')}`)
  if (runLines.length < 400) runLines.push(args.join(' '))
}

function errLog(...args) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false })
  console.error('[scheduler] ' + ts, ...args)
  pushSyncLog(`[scheduler] ${args.join(' ')}`)
  if (runLines.length < 400) runLines.push(args.join(' '))
}

/** 调用 kdocs_pull.py 抓取数据，返回 { ok: boolean }
 *  withReports=false 时只拉三张主表（报表降频，见上方说明） */
function pull(withReports = true) {
  return new Promise((resolve) => {
    if (!existsSync(PULL_SCRIPT)) {
      errLog('kdocs_pull.py 不存在: ' + PULL_SCRIPT)
      resolve({ ok: false })
      return
    }
    if (!PYTHON_BIN) {
      errLog('Python 不存在: ' + PYTHON)
      resolve({ ok: false })
      return
    }

    // 不传表名 = 拉全部；降频轮次只传三张主表，省掉 5 次分页请求（约 6 秒）
    const args = withReports ? [PULL_SCRIPT] : [PULL_SCRIPT, '未回款', '未开票', '客户平台']
    log(withReports
      ? '开始从金山文档拉取数据（含开票/对账报表）...'
      : `开始从金山文档拉取数据（本轮跳过开票/对账报表，${REPORTS_REFRESH_HOURS} 小时刷新一次）...`)
    const child = spawn(PYTHON_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))

    child.on('close', (code) => {
      // exit 0=全部成功 1=部分失败 3=无凭证 4=连不上 5=凭证失效
      if (code === 0) {
        log('拉取完成 ✓')
        resolve({ ok: true })
      } else if (code === 1) {
        log('拉取部分失败（仍有部分表可能已更新）')
        resolve({ ok: true }) // 允许部分成功
      } else if (code) {
        const reason = { 3: '无凭证', 4: '连不上服务', 5: '凭证失效' }[code] || ('exit=' + code)
        errLog('拉取失败: ' + reason)
        resolve({ ok: false })
      } else {
        resolve({ ok: false })
      }
    })

    child.on('error', (spawnErr) => {
      errLog('拉取进程启动失败: ' + spawnErr.message)
      resolve({ ok: false })
    })
  })
}

/** 导入指定文件；失败时只记日志，不抛错 */
async function importFile(tableSpec) {
  const filePath = path.join(EXPORT_DIR, tableSpec.outName)
  if (!existsSync(filePath)) {
    log('  文件不存在，跳过: ' + tableSpec.outName)
    return false
  }
  try {
    const snapshotDate = todayDate()
    let result
    if (tableSpec.bizType === 'customer_recon') {
      // 全量替换（当前状态表）
      result = await importCustomerRecon(pool, { xlsxPath: filePath })
      log('  ✓ ' + tableSpec.outName + ': ' + result.inserted + ' 条（已发货未开票 ' +
          result.uninvoicedTotal.toLocaleString('en-US') + '）')
    } else if (tableSpec.bizType === CUSTOMER_INVOICE_BIZ_TYPE) {
      // 全量替换（当前状态表，不做历史快照）
      result = await importCustomerInvoice(pool, { xlsxPath: filePath })
      log('  ✓ ' + tableSpec.outName + ': ' + result.inserted + ' 条（开票 ' +
          result.invoiceTotal.toLocaleString('en-US') + ' / 回款 ' +
          result.payTotal.toLocaleString('en-US') + '）')
    } else if (tableSpec.bizType === CUSTOMER_PLATFORM_BIZ_TYPE) {
      result = await importCustomerPlatformUnpaid(pool, { xlsxPath: filePath, snapshotDate })
      log('  ✓ ' + tableSpec.outName + ': ' + result.inserted + ' 条，金额 ' +
          result.totalAmount.toLocaleString('en-US') + '（跳过 ' + result.skippedCount + ' 行）')
    } else {
      result = await importExcel(pool, { bizType: tableSpec.bizType, xlsxPath: filePath, snapshotDate })
      log('  ✓ ' + tableSpec.outName + ': ' + result.inserted + ' 条，金额 ' +
          result.totalAmount.toLocaleString('en-US') + '（跳过 ' + result.skippedCount + ' 行）')
      if (result.warnings.length) {
        log('  ⚠ ' + result.warnings.length + ' 行账龄分档与总额不符')
      }
    }
    return true
  } catch (importErr) {
    errLog('  ✖ 导入失败 ' + tableSpec.outName + ': ' + importErr.message)
    return false
  }
}

// ------------------------------------------------------------
// 主循环
// ------------------------------------------------------------

/** 单次完整周期：抢锁 → 拉取 → 导入 → 释放锁 */
/**
 * 执行一轮「抓取 → 导入」。
 *
 * 返回值用于决定下次调度（2026-09-30 新增）：
 *   'ok'      —— 全部成功，回到正常周期
 *   'failed'  —— 抓取/导入失败，值得**短间隔重试**（多半是网络还没就绪/临时抖动）
 *   'skipped' —— 被同步锁挡住（网页端手动同步正在跑），**不该重试**，
 *                否则会和正在跑的那次打架
 */
async function runSyncTick() {
  // 与网页端「立即同步」共用同一把锁（数据库层面原子互斥），避免两边同时写库
  const lock = await acquireSyncLock({ trigger: 'scheduler' })
  if (!lock.ok) {
    log('已有同步任务在执行（网页端手动同步或上一轮尚未结束），本轮跳过')
    return 'skipped'
  }
  runLines = []

  let okAll = false
  let message = ''
  try {
    const withReports = reportsDue()
    const { ok } = await pull(withReports)
    if (!ok) {
      message = '定时同步：本轮抓取失败，跳过导入，等待下次周期重试'
      log(message)
      return 'failed'
    }
    // 没拉报表就只导主表：拿上一次的旧 xlsx 去全量替换没有任何意义，还白花时间
    const specs = withReports ? TABLE_SPECS : CORE_SPECS
    log('开始导入 ' + specs.length + ' 张表...')
    let okCnt = 0
    const importedTypes = new Set()
    for (const spec of specs) {
      const imported = await importFile(spec)
      if (imported) {
        okCnt++
        importedTypes.add(spec.bizType)
      }
    }
    okAll = okCnt === specs.length

    // 🔴 降频的「时间戳」只能在报表**导入也成功**之后再记。
    //   如果只按「拉取成功」记，一旦导入失败（文件被占用等偶发情况），
    //   接下来 6 小时都会跳过报表，数据会一直是旧的。
    if (withReports) {
      const reportsOk = REPORT_SPECS.every((s) => importedTypes.has(s.bizType))
      if (reportsOk) {
        markReportsPulled()
      } else {
        log('报表未全部导入成功，本轮不记降频时间，下一轮会重新拉取')
      }
    }

    message = `定时同步完成：成功导入 ${okCnt}/${specs.length} 张表` +
      (withReports ? '' : `（开票/对账报表按 ${REPORTS_REFRESH_HOURS} 小时降频，本轮跳过）`)
    log(message)
  } catch (syncErr) {
    message = '定时同步异常：' + syncErr.message
    errLog(message)
  } finally {
    await releaseSyncLock(lock.id, {
      ok: okAll,
      step: okAll ? 'done' : 'error',
      message,
      log: runLines.length ? runLines.join('\n') : null,
    })
    runLines = []
  }
  return okAll ? 'ok' : 'failed'
}

/**
 * 一轮调度 = 同步 + 每日备份。
 *
 * 备份**独立于同步**：无论同步返回 ok / failed / skipped（含上面的提前 return），
 * 都保证备份被执行 —— 所以放在外层的 finally 里，而不是 runSyncTick 内部。
 * 备份失败只记日志，绝不影响同步结果。
 */
async function tick() {
  try {
    return await runSyncTick()
  } finally {
    await dailyBackup()
    await dailyCleanup()
  }
}

/** 每天备份一次数据库；同一天只做一次 */
async function dailyBackup() {
  try {
    const b = await runBackup()
    if (b.error) {
      errLog('数据库备份失败：' + b.error)
    } else if (!b.skipped) {
      log(`数据库已备份：${b.file.split(/[\\/]/).pop()}（${(b.bytes / 1024 / 1024).toFixed(2)} MB）`)
      if (b.pruned?.length) log(`已清理旧备份：${b.pruned.join(', ')}`)
    }
  } catch (e) {
    errLog('数据库备份异常：' + e.message)
  }
}

/**
 * 每天清理一次登录日志（2026-10-17 加）。
 * 原来 login_log 只增不删（9-20～10-17 已 897 条）；按 LOGIN_LOG_KEEP_DAYS（默认 180 天，最低 30）删旧记录。
 * ⚠️ 与备份一样用 try 包住：清理失败绝不影响同步。
 */
async function dailyCleanup() {
  try {
    const days = Math.max(30, Number(process.env.LOGIN_LOG_KEEP_DAYS) || 180)
    const { rowCount } = await query(
      `DELETE FROM login_log WHERE created_at < NOW() - make_interval(days => $1)`,
      [days]
    )
    if (rowCount) log(`已清理登录日志：${rowCount} 条（保留最近 ${days} 天）`)
  } catch (e) {
    errLog('登录日志清理失败：' + e.message)
  }
}

// ------------------------------------------------------------
// 入口
// ------------------------------------------------------------

/**
 * 启动定时调度器。
 * 启动时立即执行一次 tick()，之后按 INTERVAL_MS 周期执行。
 * 仅在 KDOCS_SCHEDULER_ENABLED=true 时启用。
 */
export function startScheduler() {
  if (!ENABLED) {
    notice('KDOCS_SCHEDULER_ENABLED 未开启，跳过定时轮询。')
    return
  }
  if (!existsSync(PULL_SCRIPT)) {
    notice('KDOCS_SCHEDULER_ENABLED=true，但找不到 kdocs_pull.py: ' + PULL_SCRIPT)
    notice('   请设置 KDOCS_PULL_SCRIPT 环境变量或在 .env 中指定正确路径')
    return
  }
  if (!existsSync(EXPORT_DIR)) {
    notice('导出目录不存在，定时轮询跳过: ' + EXPORT_DIR)
    notice('   请创建目录或修改 .env 中的 IMPORT_WATCH_FOLDER')
    return
  }

  log('定时轮询已启动：每 ' + INTERVAL_MIN + ' 分钟拉取并导入一次')
  log('  Python:  ' + PYTHON)
  log('  脚本:    ' + PULL_SCRIPT)
  log('  导出目录: ' + EXPORT_DIR)

  // 启动时立即执行一次，把当前已有的文件也导入
  schedule(0, 'startup')
}

// ------------------------------------------------------------
// 调度循环（2026-09-30 重写：失败后短间隔重试）
//
// 为什么不用 setInterval：
//   原来「启动即跑一次 + setInterval(60min)」，如果启动那次失败（最常见的是
//   开机后网络还没就绪 —— 实测 09:04 开机、09:05 就跑，报「连不上服务」），
//   就得**干等 60 分钟**才重试。而这类失败往往十几秒后自己就好了。
//
// 现在的行为：
//   成功 / 被锁跳过 → 回到正常周期 INTERVAL_MIN
//   失败            → 按 RETRY_DELAYS 依次短间隔重试，用完后回正常周期
//
// 用递归 setTimeout 而不是 setInterval，是为了让「下一次的间隔」可以由本轮结果决定。
// ------------------------------------------------------------

/**
 * 失败后的重试间隔（毫秒）。默认 2 分钟 → 5 分钟 → 15 分钟。
 *
 * 可用 `KDOCS_SCHEDULER_RETRY_MIN` 覆盖（逗号分隔的分钟数），
 * 例如 `0.1,0.2` 表示 6 秒、12 秒 —— 主要是给演练/排查用，
 * 便于在不改代码的前提下观察重试是否真的发生。
 */
const RETRY_DELAYS = (process.env.KDOCS_SCHEDULER_RETRY_MIN || '2,5,15')
  .split(',')
  .map((s) => Number(String(s).trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
  .map((min) => Math.round(min * 60 * 1000))

/**
 * 决定下一轮该等多久。**纯函数**，抽出来是为了能单测 ——
 * 调度逻辑写错（比如失败后不回退、一直 2 分钟重试）会静默持续跑，
 * 肉眼很难发现，必须有断言守着。
 *
 * @param {'ok'|'failed'|'skipped'} result 本轮结果
 * @param {number} retryIdx 已重试次数
 * @returns {{ delayMs: number, nextRetryIdx: number, reason: string }}
 */
export function computeNextDelay(result, retryIdx, intervalMs = INTERVAL_MS, retryDelays = RETRY_DELAYS) {
  // 成功、或被锁跳过（说明另一路同步在跑，跟着重试会打架）→ 回正常周期
  if (result === 'ok') {
    return { delayMs: intervalMs, nextRetryIdx: 0, reason: retryIdx > 0 ? '重试后已成功' : '正常周期' }
  }
  if (result === 'skipped') {
    return { delayMs: intervalMs, nextRetryIdx: 0, reason: '被同步锁跳过' }
  }
  // 失败：还有重试额度就短间隔再来，否则回正常周期
  if (retryIdx < retryDelays.length) {
    return {
      delayMs: retryDelays[retryIdx],
      nextRetryIdx: retryIdx + 1,
      reason: `失败重试第 ${retryIdx + 1}/${retryDelays.length} 次`,
    }
  }
  return { delayMs: intervalMs, nextRetryIdx: 0, reason: '重试用尽，回正常周期' }
}

let retryIdx = 0
let timer = null

/** 延迟的可读文案：小于 1 分钟显示秒（演练时会配到秒级，显示「0 分钟后」很怪） */
function fmtDelay(ms) {
  return ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分钟`
}

/**
 * 安排下一轮。
 * @param {number} delayMs 延迟
 * @param {string} why     只进控制台日志（不进网页端同步日志，避免污染同步记录）
 */
function schedule(delayMs, why) {
  if (timer) clearTimeout(timer)
  if (why && delayMs > 0) {
    notice(`下一轮：${fmtDelay(delayMs)}后（${why}）`)
  }
  timer = setTimeout(async () => {
    let result = 'failed'
    try {
      result = await tick()
    } catch (err) {
      errLog('定时拉取失败: ' + err.message)
      result = 'failed'
    }
    const { delayMs: next, nextRetryIdx, reason } = computeNextDelay(result, retryIdx)
    retryIdx = nextRetryIdx
    schedule(next, reason)
  }, delayMs)
}
