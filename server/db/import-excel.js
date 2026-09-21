/**
 * Excel 导入脚本（命令行版，薄壳）
 *
 * 复用 server/services/importer.js 的导入逻辑，仅负责参数解析与日志输出。
 * 用法：node server/db/import-excel.js <biz_type> "<xlsx路径>" [快照日期YYYY-MM-DD]
 */
import 'dotenv/config'
import { Pool } from 'pg'
import { importExcel, BIZ_TYPES } from '../services/importer.js'

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/cloud_dashboard',
})

async function main() {
  const bizType = process.argv[2]
  const xlsxPath = process.argv[3]
  const snapshotArg = process.argv[4]

  if (!bizType || !xlsxPath) {
    console.error('用法: node server/db/import-excel.js <biz_type> "<xlsx路径>" [快照日期]')
    console.error('  biz_type: billed_unpaid | shipped_uninvoiced')
    process.exit(1)
  }
  if (!BIZ_TYPES[bizType]) {
    console.error(`✖ 未知业务类型: ${bizType}`)
    console.error(`  可选: ${Object.keys(BIZ_TYPES).join(' | ')}`)
    process.exit(1)
  }

  const snapshotDate = snapshotArg || new Date().toISOString().slice(0, 10)

  console.log(`\n=== 导入任务 ===`)
  console.log(`业务类型: ${bizType} (${BIZ_TYPES[bizType].label})`)
  console.log(`源文件  : ${xlsxPath}`)
  console.log(`快照日期: ${snapshotDate}`)

  try {
    const result = await importExcel(pool, { bizType, xlsxPath, snapshotDate })

    console.log(`\n解析结果: ${result.inserted} 条，金额合计 ${result.totalAmount.toLocaleString('en-US')}`)

    if (result.skipped.length) {
      console.log(`\n⚠ 跳过 ${result.skippedCount} 行脏数据:`)
      result.skipped.forEach((s) =>
        console.log(`  第 ${s.lineNo} 行 (${s.docNo}): ${s.reason}`)
      )
    }
    if (result.warnings.length) {
      console.log(`\n⚠ ${result.warnings.length} 行账龄分档与总额不符（已保留并标记）:`)
      result.warnings.slice(0, 5).forEach((r) =>
        console.log(`  ${r.doc_no}: ${r.data_warning}`)
      )
    }

    console.log(
      `\n✔ 导入成功: ${result.inserted} 条，金额 ${result.totalAmount.toLocaleString('en-US')}（跳过 ${result.skippedCount} 行）`
    )
  } catch (err) {
    console.error('\n✖ 导入失败:', err.message)
    process.exitCode = 1
  }

  await pool.end()
}

main().catch(async (err) => {
  console.error('\n✖ 执行异常:', err.message)
  await pool.end()
  process.exit(1)
})