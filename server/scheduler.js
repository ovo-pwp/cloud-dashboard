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
import { existsSync } from 'node:fs'
import path from 'path'

import { pool } from './db/pool.js'
import {
  importExcel,
  importCustomerPlatformUnpaid,
  CUSTOMER_PLATFORM_BIZ_TYPE,
} from './services/importer.js'
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

const PULL_SCRIPT =
  process.env.KDOCS_PULL_SCRIPT ||
  'C:/Users/Administrator/Desktop/看板模板/kdocs_pull.py'

const EXPORT_DIR = (process.env.IMPORT_WATCH_FOLDER || 'C:/Users/Administrator/Desktop/应收看板-数据导出')
  .replace(/\\/g, '/')

// 与 sync.js 保持一致的表映射
const TABLE_SPECS = [
  { bizType: 'billed_unpaid',           outName: '(已开票未回款-每天)未回款.xlsx' },
  { bizType: 'shipped_uninvoiced',      outName: '(已发货未开票-每天)未开票.xlsx' },
  { bizType: 'customer_platform_unpaid', outName: '(客户未回款平台)未回款.xlsx' },
]

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

/** 调用 kdocs_pull.py 抓取数据，返回 { ok: boolean } */
function pull() {
  return new Promise((resolve) => {
    if (!existsSync(PULL_SCRIPT)) {
      errLog('kdocs_pull.py 不存在: ' + PULL_SCRIPT)
      resolve({ ok: false })
      return
    }
    if (!existsSync(PYTHON)) {
      errLog('Python 不存在: ' + PYTHON)
      resolve({ ok: false })
      return
    }

    log('开始从金山文档拉取数据...')
    const child = spawn(PYTHON, [PULL_SCRIPT], {
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
    const snapshotDate = new Date().toISOString().slice(0, 10)
    let result
    if (tableSpec.bizType === CUSTOMER_PLATFORM_BIZ_TYPE) {
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
async function tick() {
  // 与网页端「立即同步」共用同一把锁（数据库层面原子互斥），避免两边同时写库
  const lock = await acquireSyncLock({ trigger: 'scheduler' })
  if (!lock.ok) {
    log('已有同步任务在执行（网页端手动同步或上一轮尚未结束），本轮跳过')
    return
  }
  runLines = []

  let okAll = false
  let message = ''
  try {
    const { ok } = await pull()
    if (!ok) {
      message = '定时同步：本轮抓取失败，跳过导入，等待下次周期重试'
      log(message)
      return
    }

    log('开始导入 ' + TABLE_SPECS.length + ' 张表...')
    let okCnt = 0
    for (const spec of TABLE_SPECS) {
      const imported = await importFile(spec)
      if (imported) okCnt++
    }
    okAll = okCnt === TABLE_SPECS.length
    message = `定时同步完成：成功导入 ${okCnt}/${TABLE_SPECS.length} 张表`
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
  tick().catch((err) => errLog('启动时首次拉取失败: ' + err.message))

  setInterval(() => {
    tick().catch((err) => errLog('定时拉取失败: ' + err.message))
  }, INTERVAL_MS)
}
