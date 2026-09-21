-- ============================================================
-- cloud-dashboard 回款/开票管理看板 数据库结构
-- PostgreSQL 16+
-- 数据来源（三张源表，由 kdocs_pull.py 从金山文档抓取到「应收看板-数据导出」）：
--   1.《(已开票未回款-每天)未回款.xlsx》→ 业务类型 billed_unpaid
--   2.《(已发货未开票-每天)未开票.xlsx》→ 业务类型 shipped_uninvoiced
--   3.《(客户未回款平台)未回款.xlsx》  → 独立表 customer_platform_unpaid
-- 前两张源表结构同构（13 列），共用 import_batch 与 receivable_detail，用 biz_type 区分；
-- 第三张为订单级明细，结构不同，独立建表。
--
-- 执行：npm run db:init
-- ⚠ 警告：本脚本会 DROP 并重建 import_batch / receivable_detail，其中的数据将被清空！
--          仅用于首次建表或结构变更；日常导入数据请用 `node sync.js --import`。
-- ============================================================

DROP TABLE IF EXISTS receivable_detail CASCADE;
DROP TABLE IF EXISTS import_batch      CASCADE;
-- 注：customer_platform_unpaid 使用 IF NOT EXISTS 建表，不清空（其数据无法从源文件快速重建的场景请先备份）

-- ------------------------------------------------------------
-- 导入批次：每次导入一份「业务类型 + 日期」的快照
-- ------------------------------------------------------------
CREATE TABLE import_batch (
  id            SERIAL PRIMARY KEY,
  biz_type      VARCHAR(30)  NOT NULL,        -- billed_unpaid / shipped_uninvoiced
  snapshot_date DATE         NOT NULL,        -- 快照日期
  source_file   VARCHAR(255),
  row_count     INTEGER      NOT NULL DEFAULT 0,
  total_amount  NUMERIC(16,2) NOT NULL DEFAULT 0,
  skipped_count INTEGER      NOT NULL DEFAULT 0,  -- 跳过的脏数据行数
  imported_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  remark        TEXT,
  -- 同一业务类型的同一天只允许一份快照，重复导入做覆盖
  UNIQUE (biz_type, snapshot_date)
);

COMMENT ON TABLE  import_batch             IS '数据导入批次';
COMMENT ON COLUMN import_batch.biz_type    IS '业务类型：billed_unpaid 已开票未回款 / shipped_uninvoiced 已发货未开票';
COMMENT ON COLUMN import_batch.skipped_count IS '因数据质量问题被跳过的行数';

-- ------------------------------------------------------------
-- 明细表：每行一条业务单据
-- 源表列映射（两张源表一致）：
--   A 编号     → doc_no        （未回款为「开票方案编号」，未开票为「合同执行编号」）
--   B 日期     → doc_date      （未回款为「开票日期」，未开票为「执行日期」）
--   C 分类     → aging_category
--   D 挂账客户 → customer_name
--   E 权限     → permission_raw
--   F 业务员   → salesperson_raw
--   G 总金额   → amount_total
--   H 3个月以上 → amount_over3m
--   I 3个月    → amount_3m
--   J 2个月    → amount_2m
--   K 1个月    → amount_1m
--   L 当月     → amount_current
--   M 备注     → follow_up_note
-- ------------------------------------------------------------
CREATE TABLE receivable_detail (
  id              SERIAL PRIMARY KEY,
  batch_id        INTEGER      NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  biz_type        VARCHAR(30)  NOT NULL,       -- 冗余自 batch，便于直接按类型查

  doc_no          VARCHAR(30)  NOT NULL,
  doc_date        DATE,
  aging_category  VARCHAR(30),                 -- 允许为空（源表存在分类缺失行）
  customer_name   VARCHAR(150) NOT NULL,

  permission_raw  VARCHAR(200),
  salesperson_raw VARCHAR(100) NOT NULL,

  department      VARCHAR(50),                 -- 由 salesperson_raw 拆解
  salesperson     VARCHAR(50)  NOT NULL,

  amount_total    NUMERIC(16,2) NOT NULL DEFAULT 0,
  amount_over3m   NUMERIC(16,2) NOT NULL DEFAULT 0,
  amount_3m       NUMERIC(16,2) NOT NULL DEFAULT 0,
  amount_2m       NUMERIC(16,2) NOT NULL DEFAULT 0,
  amount_1m       NUMERIC(16,2) NOT NULL DEFAULT 0,
  amount_current  NUMERIC(16,2) NOT NULL DEFAULT 0,

  follow_up_note  TEXT,
  data_warning    TEXT,                        -- 数据质量提示（如账龄分档对不上）

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_rd_batch        ON receivable_detail(batch_id);
CREATE INDEX idx_rd_biz_type     ON receivable_detail(biz_type);
CREATE INDEX idx_rd_doc_no       ON receivable_detail(doc_no);
CREATE INDEX idx_rd_doc_date     ON receivable_detail(doc_date);
CREATE INDEX idx_rd_customer     ON receivable_detail(customer_name);
CREATE INDEX idx_rd_salesperson  ON receivable_detail(salesperson);
CREATE INDEX idx_rd_department   ON receivable_detail(department);
CREATE INDEX idx_rd_aging        ON receivable_detail(aging_category);

COMMENT ON TABLE  receivable_detail          IS '未回款/未开票明细，每行一条业务单据';
COMMENT ON COLUMN receivable_detail.doc_no   IS '单据编号（未回款=开票方案编号，未开票=合同执行编号）';
COMMENT ON COLUMN receivable_detail.doc_date IS '单据日期（未回款=开票日期，未开票=执行日期）';
COMMENT ON COLUMN receivable_detail.data_warning IS '数据质量提示；非空表示该行账龄分档与总额不符等';

-- ------------------------------------------------------------
-- 视图 1：按业务员 × 账龄档（看板主表）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_aging_by_salesperson AS
SELECT
  biz_type,
  salesperson,
  department,
  COALESCE(SUM(amount_over3m), 0)  AS over3m,
  COALESCE(SUM(amount_3m), 0)      AS m3,
  COALESCE(SUM(amount_2m), 0)      AS m2,
  COALESCE(SUM(amount_1m), 0)      AS m1,
  COALESCE(SUM(amount_current), 0) AS current_month,
  COALESCE(SUM(amount_total), 0)   AS total,
  COUNT(*)                         AS doc_count
FROM receivable_detail
GROUP BY biz_type, salesperson, department;

-- ------------------------------------------------------------
-- 视图 2：按账龄档汇总
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_aging_summary AS
SELECT
  biz_type,
  COALESCE(aging_category, '未分类') AS aging_category,
  COUNT(*)                           AS doc_count,
  COALESCE(SUM(amount_total), 0)     AS total
FROM receivable_detail
GROUP BY biz_type, COALESCE(aging_category, '未分类');

-- ------------------------------------------------------------
-- 视图 3：按客户汇总
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_by_customer AS
SELECT
  biz_type,
  customer_name,
  COUNT(*)                          AS doc_count,
  COALESCE(SUM(amount_total), 0)    AS total,
  COALESCE(SUM(amount_over3m), 0)   AS over3m,
  string_agg(DISTINCT salesperson, '、') AS salespersons
FROM receivable_detail
GROUP BY biz_type, customer_name;

-- ------------------------------------------------------------
-- 视图 4：按部门汇总
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_by_department AS
SELECT
  biz_type,
  COALESCE(department, '未归类') AS department,
  COUNT(*)                       AS doc_count,
  COALESCE(SUM(amount_total), 0) AS total
FROM receivable_detail
GROUP BY biz_type, COALESCE(department, '未归类');

-- ------------------------------------------------------------
-- 视图 5：每日快照趋势
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_trend AS
SELECT
  biz_type,
  snapshot_date,
  row_count,
  total_amount,
  skipped_count,
  source_file,
  imported_at
FROM import_batch
ORDER BY biz_type, snapshot_date DESC;

-- ------------------------------------------------------------
-- 视图 6：总览对比（两个业务口径并列）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_overview AS
SELECT
  b.biz_type,
  b.snapshot_date,
  b.row_count,
  b.total_amount,
  COUNT(DISTINCT d.customer_name) AS customer_count,
  COUNT(DISTINCT d.salesperson)   AS salesperson_count,
  COALESCE(SUM(d.amount_over3m), 0) AS over3m
FROM import_batch b
JOIN receivable_detail d ON d.batch_id = b.id
GROUP BY b.biz_type, b.snapshot_date, b.row_count, b.total_amount;

-- ============================================================
-- 客户平台未回款（订单级明细，独立数据源）
-- 源表：《(客户未回款平台)未回款.xlsx》（kdocs_pull.py 从金山文档每日抓取）
-- 与 receivable_detail 结构不同（订单级、含下单平台/回款状态等），独立建表。
-- ============================================================
CREATE TABLE IF NOT EXISTS customer_platform_unpaid (
  id                  SERIAL PRIMARY KEY,
  snapshot_date       DATE         NOT NULL,     -- 快照（导入当日），同日覆盖
  platform            VARCHAR(100),              -- 下单平台
  order_date          DATE,                      -- 订单日期
  company_name        VARCHAR(200),              -- 公司名称
  customer_order_no   VARCHAR(100),              -- 客户订单号
  customer_name       VARCHAR(300),              -- 客户名称
  payment_status      VARCHAR(30),               -- 回款状态
  product_name        TEXT,                      -- 商品名称
  invoice_points      NUMERIC(10,4),             -- 开票点数
  qty                 NUMERIC(16,2),             -- 数量
  purchase_amount     NUMERIC(16,2),             -- 采购金额
  invoice_status      VARCHAR(30),               -- 发票状态
  receiver            VARCHAR(100),              -- 收货人
  purchase_unit_price NUMERIC(16,4),             -- 采购单价
  sales_unit_price    NUMERIC(16,4),             -- 销售单价
  sales_amount        NUMERIC(16,2),             -- 销售金额
  sales_amount_total  NUMERIC(16,2),             -- 销售金额合计（看板金额口径）
  guided_sales_amount NUMERIC(16,2),             -- 导单销售金额
  self_check          VARCHAR(50),               -- 自检
  diff_adjustment     NUMERIC(16,2),             -- 差异调整
  report_plan_no      VARCHAR(50),               -- 报账方案编号
  account_customer    VARCHAR(200),              -- 挂账客户
  salesperson         VARCHAR(100),              -- 业务员
  remark              TEXT,                      -- 备注
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cpu_snapshot ON customer_platform_unpaid(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_cpu_customer ON customer_platform_unpaid(account_customer);
CREATE INDEX IF NOT EXISTS idx_cpu_platform ON customer_platform_unpaid(platform);

COMMENT ON TABLE  customer_platform_unpaid IS '客户平台未回款（订单级明细，每日快照，同日覆盖）';
COMMENT ON COLUMN customer_platform_unpaid.sales_amount_total IS '销售金额合计，看板未回款金额口径';
