/**
 * 对外暴露安全闸
 *
 * 背景：
 *   鉴权中间件（syncAuth.js 的 requireLogin）在「未配置任何登录账号」时是**直接放行**的
 *   —— 这是为了本机开发不配账号也能用。但部署到公网时，如果漏填 .env 里的
 *   LOGIN_USERS / LOGIN_USER，整套挂着真实经营数据的看板就会以零认证状态对全网开放。
 *
 *   .env.example 里的文字提醒挡不住手快的人，所以这里把它变成硬约束：
 *   生产环境（NODE_ENV=production）下未配置登录账号 → **拒绝启动**。
 *   宁可看着它起不来，也不要它在公网上裸奔。
 *
 * 逃生舱：
 *   确实要做「无人认证的公开只读看板」时，显式设置 ALLOW_ANONYMOUS_ACCESS=true。
 *   要求「显式写下这一行」本身就是一道确认动作。
 */

/**
 * 判断当前配置是否允许对外提供服务。
 *
 * @param {object} opts
 * @param {string} [opts.nodeEnv]        进程的 NODE_ENV
 * @param {boolean} [opts.loginEnabled]  是否已配置登录账号
 * @param {string} [opts.allowAnonymous] ALLOW_ANONYMOUS_ACCESS 原始值
 * @returns {{ level: 'ok'|'warn'|'fatal', message: string }}
 */
export function checkExposureGuard({ nodeEnv, loginEnabled, allowAnonymous } = {}) {
  const isProd = String(nodeEnv || '').trim() === 'production'
  // 只认字面 true，避免 'false' / '0' / 空格被当成开启了逃生舱
  const allowed = String(allowAnonymous ?? '').trim().toLowerCase() === 'true'

  if (loginEnabled) return { level: 'ok', message: '' }

  if (isProd && !allowed) {
    return {
      level: 'fatal',
      message: [
        '生产环境检测到「未配置任何登录账号」，已拒绝启动。',
        '',
        '  原因：本服务的鉴权在无账号时是放行的，此时看板对任何访问者完全开放。',
        '        生产环境挂着真实经营数据，不能以这种状态对外服务。',
        '',
        '  修复（在 deploy/.env 里二选一）：',
        '    1) 配置登录账号（推荐）：',
        '         LOGIN_USERS=用户名=强密码',
        '    2) 确实要做「无人认证的公开只读看板」：',
        '         ALLOW_ANONYMOUS_ACCESS=true',
        '',
        '  提示：执行 deploy/gen-env.sh 可以直接生成一份合规的生产 .env。',
      ].join('\n'),
    }
  }

  return {
    level: 'warn',
    message:
      '未配置登录账号 —— 当前任何人都可访问。仅适用于本机 / 内网自测，请勿直接暴露到公网。',
  }
}
