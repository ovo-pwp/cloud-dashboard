module.exports = {
  apps: [
    {
      name: 'cloud-dashboard',
      script: 'server/index.js',
      cwd: 'C:/Users/Administrator/Desktop/cloud-dashboard',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      kill_timeout: 3000,
      listen_timeout: 8000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
    },
    {
      // 前端 Vite 开发服务器。
      // 2026-09-29 之前它是由 `node start.js` 手动拉起的，一旦那个进程退出
      // （例如后端 3000 端口被 PM2 占用导致体检失败），前端就再也没人管，
      // 表现就是「页面打不开 / 一片白」。纳入 PM2 后会自动拉起并常驻。
      //
      // 2026-09-29 17:40 又出现一次：进程收到外部 SIGINT 被杀（日志
      // `msg=process tree killed`），PM2 列表里整个进程消失、5173 无人监听。
      // 那种情况 max_memory_restart 拦不住（不是 OOM，是外部信号），
      // 所以显式打开 autorestart，并给一个退避间隔，避免被杀后反复硬重启。
      name: 'cloud-dashboard-web',
      script: 'node_modules/vite/bin/vite.js',
      args: '--host',
      cwd: 'C:/Users/Administrator/Desktop/cloud-dashboard',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '1G',
      autorestart: true,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      kill_timeout: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/web-error.log',
      out_file: 'logs/web-out.log',
      merge_logs: true,
    },
    {
      // 隧道看门狗（2026-10-21）。
      // 起因：公网整站 502，但本地 127.0.0.1:3000 一直 200 —— 是 cloudflared 的隧道
      // 静默断连（服务状态仍是 Running、进程还在，只是没有出网连接）。
      // 这个进程每 5 分钟探一次公网 /api/health，连续 2 次不通且本地正常就重启隧道服务。
      // ⚠️ 重启 Windows 服务需要管理员权限 ⇒ **PM2 必须以管理员身份启动**，
      //    否则日志里会出现「重启失败：…拒绝访问」，届时只能人工处理。
      name: 'tunnel-watchdog',
      script: 'scripts/tunnel-watchdog.mjs',
      cwd: 'C:/Users/Administrator/Desktop/cloud-dashboard',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '200M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/watchdog-error.log',
      out_file: 'logs/watchdog-out.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        TUNNEL_WATCH_INTERVAL_MIN: '5',
        TUNNEL_WATCH_FAILS: '2',
        TUNNEL_WATCH_MAX_PER_HOUR: '3',
      },
    },
  ]
}
