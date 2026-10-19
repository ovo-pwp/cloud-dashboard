/**
 * 一键同步：从金山文档抓取最新数据 → 导入 PostgreSQL → 网页看板自动刷新
 *
 * 用法：
 *   node sync.js            # 抓全部三张表（未回款 / 未开票 / 客户平台）并入库
 *   node sync.js --pull     # 只抓取（不入库）
 *   node sync.js --import   # 只入库（用已抓好的本地文件，不重新抓取）
 *
 * 依赖：kdocs_pull.py（看板模板目录）+ kdocs_token.txt 凭证
 */


import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pool } from './server/db/pool.js'
import { importExcel, importCustomerPlatformUnpaid } from './server/services/importer.js'
import { todayDate } from './server/utils/date.js'
import { resolveExecutable } from './server/utils/executable.js'

// 抓取脚本 / Python / 导出目录全部走环境变量，便于容器化部署
// （Windows 本机跑时用 .env 里的值即可，默认值与原来一致）
const PY =
  process.env.PYTHON_PATH ||
  'C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe'
const KDOCS_PULL =
  process.env.KDOCS_PULL_SCRIPT || 'C:/Users/Administrator/Desktop/看板模板/kdocs_pull.py'
const EXPORT_DIR =
  process.env.EXPORT_DIR || 'C:/Users/Administrator/Desktop/应收看板-数据导出'

// PY 在本机 Windows 是绝对路径，在容器里是命令名（python3）。
// 命令名必须经 PATH 解析 —— 直接 existsSync('python3') 恒为 false，
// 会让同步永远停在「找不到 Python」（容器化部署时踩过这个坑）。
const PY_BIN = resolveExecutable(PY)

// 三张表：抓取参数名 → { 文件名, 业务类型 }
const TABLES = {
  billed_unpaid: {
    kdocsName: '未回款',
    file: '(已开票未回款-每天)未回款.xlsx',
    bizType: 'billed_unpaid',
  },
  shipped_uninvoiced: {
    kdocsName: '未开票',
    file: '(已发货未开票-每天)未开票.xlsx',
    bizType: 'shipped_uninvoiced',
  },
  customer_platform_unpaid: {
    kdocsName: '客户平台',
    file: '(客户未回款平台)未回款.xlsx',
    bizType: 'customer_platform_unpaid',
  },
}

function log(msg) {
  console.log(msg)
}

/** 抓取金山文档数据（kdocs_pull.py 会把 xlsx 落到 EXPORT_DIR） */
function pull() {
  log('\n=== [1/2] 从金山文档抓取最新数据 ===')
  if (!fs.existsSync(KDOCS_PULL)) {
    log(`✖ 找不到抓取脚本：${KDOCS_PULL}`)
    return false
  }
  if (!PY_BIN) {
    log(`✖ 找不到 Python：${PY}`)
    return false
  }

  const res = spawnSync(PY_BIN, [KDOCS_PULL, '未回款', '未开票', '客户平台'], {
    encoding: 'utf8',
    stdio: 'inherit',
  })

  if (res.error) {
    log(`✖ 抓取进程启动失败：${res.error.message}`)
    return false
  }

  // kdocs_pull.py 退出码：0=成功 1=部分失败 2=表名错 3=无凭证 4=连不上 5=凭证失效
  if (res.status === 3) {
    log('✖ 未配置金山文档凭证。请把 Token 写入 看板模板/kdocs_token.txt')
    return false
  }
  if (res.status === 5) {
    log('✖ 金山文档凭证已失效，请重新获取 Token 写入 看板模板/kdocs_token.txt')
    return false
  }
  if (res.status === 4) {
    log('✖ 连不上金山文档服务，请检查网络后重试')
    return false
  }
  log('✔ 抓取完成')
  return true
}

/** 导入 EXPORT_DIR 里的 xlsx 到数据库 */
async function importAll() {
  log('\n=== [2/2] 导入 PostgreSQL ===')
  // 用本地日期而不是 UTC：new Date().toISOString() 在北京时间 00:00–08:00 会记成昨天
  const snapshotDate = todayDate()
  let ok = 0
  let fail = 0

  for (const [key, meta] of Object.entries(TABLES)) {
    const filePath = path.join(EXPORT_DIR, meta.file)
    if (!fs.existsSync(filePath)) {
      log(`  - ${meta.file}：文件不存在，跳过`)
      fail++
      continue
    }
    try {
      let result
      if (key === 'customer_platform_unpaid') {
        result = await importCustomerPlatformUnpaid(pool, { xlsxPath: filePath, snapshotDate })
        log(`  ✔ ${meta.file}：${result.inserted} 条，销售金额合计 ${result.totalAmount.toLocaleString('en-US')}（跳过 ${result.skippedCount} 行）`)
      } else {
        result = await importExcel(pool, { bizType: meta.bizType, xlsxPath: filePath, snapshotDate })
        log(`  ✔ ${meta.file}：${result.inserted} 条，金额 ${result.totalAmount.toLocaleString('en-US')}（跳过 ${result.skippedCount} 行）`)
      }
      ok++
    } catch (err) {
      log(`  ✖ ${meta.file}：${err.message}`)
      fail++
    }
  }

  log(`\n导入完成：成功 ${ok} 张，失败 ${fail} 张`)
  return fail === 0
}

async function main() {
  const args = process.argv.slice(2)
  const doPull = !args.includes('--import')
  const doImport = !args.includes('--pull')

  log('============================================')
  log('  云端看板数据同步（抓取 → 入库 → 网页看板）')
  log('============================================')

  let pulled = true
  if (doPull) pulled = pull()

  let imported = true
  if (doImport) {
    if (!pulled) {
      log('\n抓取失败，改用本地已有文件入库（数据可能不是最新）。')
    }
    imported = await importAll()
  }

  await pool.end()

  // 退出码含义（上层 syncRunner 依赖它生成提示语，别再改动）：
  //   0 = 全部成功
  //   1 = 云端抓取失败（多半是 Token 失效 / 网络不通）
  //   2 = 抓取成功但部分文件入库失败（多半是文件缺失或格式变了）
  // 必须区分开：这两种情况让用户做的事完全不同 —— 换凭证 vs 查文件。
  if (!pulled && doPull) {
    log('\n⚠ 云端抓取未成功。')
    process.exitCode = 1
  } else if (!imported && doImport) {
    log('\n⚠ 部分文件导入失败，请检查上方错误。')
    process.exitCode = 2
  } else {
    log('\n✔ 全部完成！网页看板已是最新数据：http://localhost:5173')
  }
}

main().catch(async (err) => {
  console.error('\n✖ 执行异常：', err)
  await pool.end()
  process.exit(1)
})
