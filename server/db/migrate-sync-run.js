/**
 * 增量建表：同步任务运行记录（sync_run）
 *
 * 单独脚本，不走 schema.sql（那个会 DROP 重建，清空业务数据）。
 * 可重复执行（IF NOT EXISTS），用于老库补表。
 *
 *   node server/db/migrate-sync-run.js
 *
 * 作用：
 *   1. 把「同步状态」从内存搬到数据库 —— 后端重启后仍能看到上次同步的结果/日志；
 *   2. active 上建「唯一部分索引」—— 数据库层面保证全局至多一个同步任务在跑
 *      （内存里的互斥锁会随进程消失，数据库的不会）。
 */
import 'dotenv/config'
import { pool } from './pool.js'

const SQL = `
CREATE TABLE IF NOT EXISTS sync_run (
  id          BIGSERIAL    PRIMARY KEY,
  trigger     VARCHAR(32)  NOT NULL DEFAULT 'manual',   -- 触发来源：manual（网页按钮）/ scheduler（定时轮询）
  active      BOOLEAN      NOT NULL DEFAULT TRUE,       -- 是否仍在执行；结束时置 false
  started_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  ok          BOOLEAN,                                  -- 结束才有值：true 全成功 / false 有失败
  step        VARCHAR(32)  NOT NULL DEFAULT 'pull',     -- pull / import / done / error / interrupted
  message     TEXT,
  pid         INTEGER,                                  -- 同步子进程 PID，供重启后回收孤儿进程
  host        VARCHAR(64),                              -- 起任务的机器名，便于多人共用时区分
  log         TEXT                                      -- 日志快照（换行分隔，滚动覆盖）
);

-- 核心：全局至多一条 active 记录。
-- 并发下第二次 INSERT 会因唯一冲突失败（SQLSTATE 23505），这就是跨进程的原子互斥锁。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sync_run_active ON sync_run (active) WHERE active;

CREATE INDEX IF NOT EXISTS idx_sync_run_started ON sync_run (started_at DESC);

COMMENT ON TABLE  sync_run IS '同步任务运行记录（持久化状态 + 跨进程互斥锁）';
COMMENT ON COLUMN sync_run.active IS 'TRUE 表示正在执行；全局至多一条为 TRUE（由唯一部分索引保证）';
COMMENT ON COLUMN sync_run.step IS 'pull 抓取云端 / import 入库 / done 完成 / error 出错 / interrupted 被重启打断';
COMMENT ON COLUMN sync_run.pid IS '同步子进程 PID，后端重启时用于确认并回收孤儿进程';
`

const { rows } = await pool.query(`SELECT to_regclass('public.sync_run') AS exists_flag`)
const existed = rows[0].exists_flag !== null

await pool.query(SQL)

// 顺带报告是否有「遗留的活跃记录」——正常情况下应该没有
const stale = await pool.query(
  `SELECT id, trigger, started_at FROM sync_run WHERE active ORDER BY id`
)
const cnt = await pool.query('SELECT count(*) AS c FROM sync_run')

console.log(
  existed
    ? `✔ 表 sync_run 已存在，结构已校验（当前 ${cnt.rows[0].c} 条记录）`
    : `✔ 建表成功：sync_run（当前 0 条记录）`
)
if (stale.rows.length) {
  console.log(
    `⚠ 有 ${stale.rows.length} 条「仍在执行」的记录（后端启动时会自动判定并回收）：`
  )
  for (const r of stale.rows) {
    console.log(`    #${r.id} trigger=${r.trigger} started_at=${r.started_at.toISOString()}`)
  }
} else {
  console.log('· 无遗留的活跃同步记录')
}

await pool.end()
