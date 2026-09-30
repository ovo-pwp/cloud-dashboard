/**
 * 可执行文件解析（Python 解释器等）
 *
 * 为什么需要单独一个函数：
 *   PYTHON_PATH 在两种环境下写法不同 ——
 *     · 本机 Windows：绝对路径  C:/Users/.../envs/default/Scripts/python.exe
 *     · 容器 Linux  ：命令名    python3
 *   命令名用 fs.existsSync('python3') 判断**必然是 false**（它不在当前工作目录里），
 *   于是前置校验会误报「Python 不存在」，把同步 / 定时任务全部拦下。
 *
 *   所以：含路径分隔符的按路径查存在性，否则到 PATH 里逐个目录搜。
 *   syncRunner 与 scheduler 共用这一份，避免两处各自实现后再次分叉。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {string} cmd 绝对/相对路径，或命令名（如 python3）
 * @returns {string|null} 解析到的真实路径；找不到返回 null
 */
export function resolveExecutable(cmd) {
  if (!cmd) return null
  if (cmd.includes('/') || cmd.includes('\\')) return fs.existsSync(cmd) ? cmd : null

  // Windows 下命令名可能带 .exe/.cmd/.bat 后缀，Linux 下就是原名
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        /* 个别目录无权限，跳过继续找 */
      }
    }
  }
  return null
}
