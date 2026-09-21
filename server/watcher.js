/**
 * 文件夹监控：检测到业务类型 Excel 出现/变化 → 自动导入
 *
 * 复用 server/services/importer.js。支持白名单轮询 + 文件去重（按 mtime+size），
 * 避免 fs.watch 的事件风暴导致重复导入。
 */
import fs from 'fs'
import path from 'path'
import { pool } from './db/pool.js'
import {
  importExcel,
  importCustomerPlatformUnpaid,
  detectBizType,
  CUSTOMER_PLATFORM_BIZ_TYPE,
} from './services/importer.js'

/** 最近一次处理过的文件指纹，防止重复导入同一文件 */
const lastFingerprint = new Map()

/** 上一轮观察到的文件指纹；与当前一致说明文件已稳定（未被写入中） */
const stableFingerprint = new Map()

function getFingerprint(p) {
  try {
    const st = fs.statSync(p)
    return `${st.size}_${st.mtimeMs}`
  } catch {
    return null
  }
}

/** 尝试导入单个文件；匹配不到业务类型则忽略 */
async function tryImport(filePath) {
  const bizType = detectBizType(path.basename(filePath))
  if (!bizType) return

  const fp = getFingerprint(filePath)
  if (fp === null) return
  if (lastFingerprint.get(filePath) === fp) return // 已处理过同一版本

  // 稳定窗口：指纹须连续两轮扫描一致才导入，避免文件写入中读到半成品
  if (stableFingerprint.get(filePath) !== fp) {
    stableFingerprint.set(filePath, fp)
    console.log(`[watcher] 文件变动待稳定（下次确认一致再导入）: ${path.basename(filePath)}`)
    return
  }

  console.log(`\n[watcher] 检测到已稳定的新文件: ${filePath} → ${bizType}`)
  try {
    const result =
      bizType === CUSTOMER_PLATFORM_BIZ_TYPE
        ? await importCustomerPlatformUnpaid(pool, {
            xlsxPath: filePath,
            snapshotDate: new Date().toISOString().slice(0, 10),
          })
        : await importExcel(pool, {
            bizType,
            xlsxPath: filePath,
            snapshotDate: new Date().toISOString().slice(0, 10),
          })

    if (bizType === CUSTOMER_PLATFORM_BIZ_TYPE) {
      console.log(
        `[watcher] ✔ 客户平台未回款自动导入成功: ${result.inserted} 条，` +
          `金额 ${result.totalAmount.toLocaleString('en-US')}（跳过 ${result.skippedCount} 行）`
      )
    } else {
      console.log(
        `[watcher] ✔ 自动导入成功 batch#${result.batchId}: ${result.inserted} 条，` +
          `金额 ${result.totalAmount.toLocaleString('en-US')}（跳过 ${result.skippedCount} 行）`
      )
      if (result.warnings.length) {
        console.log(`[watcher] ⚠ ${result.warnings.length} 行账龄分档与总额不符`)
      }
    }
    // 导入成功：记录该版本指纹，清空稳定窗口状态
    lastFingerprint.set(filePath, fp)
    stableFingerprint.delete(filePath)
  } catch (err) {
    console.error(`[watcher] ✖ 导入失败 ${filePath}:`, err.message)
    // 失败则清掉指纹，允许文件下次变动重试
    lastFingerprint.delete(filePath)
    stableFingerprint.delete(filePath)
  }
}

/**
 * 启动监控。dir 不存在时给出提醒。
 * intervalMs：轮询间隔；为避免 fs.watch 跨平台（Windows）事件差异，用定时扫描 + 去重。
 */
export function startWatcher(dir = process.env.IMPORT_WATCH_FOLDER, intervalMs = 15000) {
  if (!dir) {
    console.log('[watcher] 未配置 IMPORT_WATCH_FOLDER，自动导入跳过。')
    return
  }
  if (!fs.existsSync(dir)) {
    console.log(`[watcher] 监控目录不存在，自动导入跳过: ${dir}`)
    console.log('[watcher] 目录创建后重新启动后端即可生效。')
    return
  }

  console.log(`\n[watcher] 开始监控目录: ${dir}`)
console.log(`[watcher] 业务类型识别: 含「客户未回款」→ 客户平台未回款；含「未回款」→ billed_unpaid；含「未开票」→ shipped_uninvoiced\n`)

  // 启动时把目录里已有的目标文件一次性导入
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(xlsx|xls)$/i.test(name)) continue
      tryImport(path.join(dir, name))
    }
  } catch (err) {
    console.error('[watcher] 启动时扫描目录失败:', err.message)
  }

  setInterval(() => {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/\.(xlsx|xls)$/i.test(name)) continue
        tryImport(path.join(dir, name))
      }
    } catch (err) {
      // 目录临时不可读等，忽略并等下一轮
    }
  }, intervalMs)
}