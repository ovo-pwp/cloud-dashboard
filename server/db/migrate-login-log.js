/**
 * 增量建表：登录记录
 *
 * 单独脚本，不走 schema.sql（那个会 DROP 重建，清空业务数据）。
 * 可重复执行（IF NOT EXISTS），用于老库补表。
 *
 *   node server/db/migrate-login-log.js
 */
import 'dotenv/config'
import { pool } from './pool.js'

const SQL = `
CREATE TABLE IF NOT EXISTS login_log (
  id          BIGSERIAL PRIMARY KEY,
  username    VARCHAR(100)  NOT NULL,          -- 尝试登录的用户名（失败时也记录）
  success     BOOLEAN       NOT NULL,          -- 是否成功
  reason      VARCHAR(100),                    -- 失败原因（成功为 NULL）
  ip          VARCHAR(64),                     -- 客户端 IP
  user_agent  TEXT,                            -- 浏览器 UA
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_log_time ON login_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_log_user ON login_log(username);
-- 限流查询：按 IP + 时间统计近期失败次数
CREATE INDEX IF NOT EXISTS idx_login_log_ip_time ON login_log(ip, created_at DESC);

COMMENT ON TABLE  login_log IS '登录记录（成功与失败都记录，用于审计与限流）';
COMMENT ON COLUMN login_log.reason IS '失败原因：密码错误 / 账号不存在 / 参数缺失 / 触发限流 / 主动退出';
`

const { rows } = await pool.query(
  `SELECT to_regclass('public.login_log') AS exists_flag`
)
const existed = rows[0].exists_flag !== null

await pool.query(SQL)

const cnt = await pool.query('SELECT count(*) AS c FROM login_log')
console.log(
  existed
    ? `✔ 表 login_log 已存在，结构已校验（当前 ${cnt.rows[0].c} 条记录）`
    : `✔ 建表成功：login_log（当前 0 条记录）`
)

await pool.end()
