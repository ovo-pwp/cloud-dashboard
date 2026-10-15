/**
 * 构建前检查：源码里用到的 Element Plus 组件，是否都已登记到白名单。
 *
 * 背景：2026-10-10 起 Element Plus 改成「白名单按需注册」（主包 954KB→550KB）。
 * 代价是：**新写一个 <el-xxx> 但忘了登记，Vue 不会报错** ——
 * 它会静默渲染成未知元素，页面只是「没样式 / 没功能」，极难发现。
 *
 * 这个脚本把「静默失败」变成「构建失败」：
 *   · 扫描 src 下所有 .vue/.js 里的 <el-xxx> 标签
 *   · 转成组件名（el-table-column → ElTableColumn）
 *   · 逐个确认它「在 src/main.js 的白名单里」或「在该文件自己 import 了」
 *   · 有遗漏就打印清单并非零退出 —— 于是 npm run build / 发版.bat 会直接失败
 *
 * 通过 package.json 的 "prebuild" 自动执行，也可手动跑：npm run check:ep
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const MAIN = path.join(SRC, 'main.js')

/** el-table-column → ElTableColumn */
function toComponentName(tag) {
  return (
    'El' +
    tag
      .replace(/^el-/, '')
      .split('-')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('')
  )
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(vue|js|ts)$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * 取出「可能写标签」的部分。
 *
 * ⚠️ 不要用 `<template>([\s\S]*?)</template>` 去截模板 ——
 *    Vue 模板里有**嵌套 `<template #default>`**（el-table 的插槽就是），
 *    非贪婪匹配会在第一个 `</template>` 就截断，后面的组件全漏扫（会漏报！）。
 *    正确做法：**去掉 `<script>` / `<style>` 区块 + 去注释**，剩下的就是模板。
 */
function tagSection(file, src) {
  let s = src
  if (file.endsWith('.vue')) {
    // 去掉 script / style 区块（里面有注释和字符串，容易误判）
    s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
    s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
  }
  // 去掉 HTML 注释与整行 // 注释
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  return s
}

const mainSrc = fs.readFileSync(MAIN, 'utf8')
const files = walk(SRC)

const missing = new Map() // 组件名 → 用到的文件
let usedTotal = 0

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8')
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  const src = tagSection(f, raw)

  // 收集本文件用到的 el-* 标签
  const tags = new Set()
  for (const m of src.matchAll(/<el-([a-z][a-z0-9-]*)/g)) tags.add(`el-${m[1]}`)
  if (!tags.size) continue

  // 该文件自己 import 进来的 EP 组件（如 App.vue 里的 ElConfigProvider）
  const localImports = new Set()
  for (const m of raw.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]element-plus['"]/g)) {
    for (const n of m[1].split(',')) {
      const name = n.trim()
      if (name) localImports.add(name)
    }
  }

  for (const tag of tags) {
    usedTotal++
    const comp = toComponentName(tag)
    // 白名单里（main.js 出现该名字）或本文件自己 import 了 → 都算已登记
    const inWhitelist = new RegExp(`\\b${comp}\\b`).test(mainSrc)
    if (inWhitelist || localImports.has(comp)) continue
    if (!missing.has(comp)) missing.set(comp, [])
    missing.get(comp).push(rel)
  }
}

if (missing.size === 0) {
  console.log(`[check:ep] ✅ 源码用到的 ${usedTotal} 处 Element Plus 组件都已登记`)
  process.exit(0)
}

console.error('')
console.error('❌ [check:ep] 有 Element Plus 组件没登记到白名单，样式/功能会静默失效：')
console.error('')
for (const [comp, where] of [...missing.entries()].sort()) {
  console.error(`   ${comp}`)
  console.error(`      用到的地方：${[...new Set(where)].join(', ')}`)
}
console.error('')
console.error('   修法：在 src/main.js 顶部 import 里补上它，')
console.error('        并加进下面的 EP_COMPONENTS 数组。')
console.error('')
process.exit(1)
