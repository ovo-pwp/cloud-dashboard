# cloud-dashboard 回款 / 开票管理看板系统

销售回款管理看板。数据源为金山文档云端抓取（也可手动导入 Excel），导入 PostgreSQL 后按业务员、客户、账龄等多维查看。

**三个业务口径：**

| 业务类型                        | 源文件                        | 含义            |
| --------------------------- | --------------------------- | ------------- |
| `billed_unpaid`             | 《(已开票未回款-每天)未回款.xlsx》      | 已开票但客户还没付款     |
| `shipped_uninvoiced`        | 《(已发货未开票-每天)未开票.xlsx》       | 已发货但还没开票       |
| `customer_platform_unpaid`  | 《(客户未回款平台)未回款.xlsx》（每周四）    | 客户平台订单级未回款（独立表） |

前两类**结构同构**（13 列），共用一套表，用 `biz_type` 字段区分，前端顶部可一键切换；第三类是订单级明细（23/27 列两种源结构，导入时按表头列名自动映射），独立表 + 独立页面。

## 登录与安全

整个看板需**登录后访问**，未登录会跳转到登录页。

| 接口                              | 是否需要登录 | 说明                 |
| ------------------------------- | ------ | ------------------ |
| `POST /api/login`               | 否      | 用户名 + 密码（+ 是否记住我）→ 登录令牌 |
| `GET /api/me`                   | 否      | 查当前登录状态（未登录返回 401） |
| `POST /api/logout`              | 否      | 退出登录（会写一条审计）       |
| `GET /api/health`               | 否      | 健康检查               |
| `GET /api/login-users`          | **是**  | 已配置的账号列表（不含密码）     |
| `GET /api/login-log`            | **是**  | 登录记录（分页 + 过滤）      |
| 其余所有 `/api/*`（含数据查询、同步）         | **是**  | 未登录一律 401 → 前端跳登录页  |

配置（`.env`）：

```bash
# 多账号：逗号分隔的「用户名=密码」，可配多个
LOGIN_USERS=4111=4111,zhangsan=abc123,lisi=pass456
# 兼容单个账号的旧写法（两者都存在时 LOGIN_USERS 优先）
LOGIN_USER=4111
LOGIN_PASSWORD=4111

LOGIN_TTL_HOURS=12               # 普通登录有效期（小时）
LOGIN_REMEMBER_TTL_HOURS=168     # 勾选「记住我」时的有效期（小时，默认 7 天）

LOGIN_MAX_FAILS=5                # 限流：窗口内允许的失败次数
LOGIN_FAIL_WINDOW_MINUTES=15     # 限流：统计窗口 / 锁定时长（分钟）
TRUST_PROXY=false                # 是否信任 X-Forwarded-For（见下方「登录限流」）
```

> 全部留空 = 关闭登录保护（不推荐，局域网内任何人都能访问）。

**多账号**

登录页支持任意已配置账号；每个账号的令牌签名密钥**绑定用户名**，因此某个账号改密码只影响该账号的令牌，不会把其他人踢下线。用户名不存在与密码错误都会做等长比较（`dummyCompare`），耗时一致，无法通过响应时间区分两者。

**记住我**

登录页有「记住我」勾选框：不勾用 `LOGIN_TTL_HOURS`（默认 12 小时），勾了用 `LOGIN_REMEMBER_TTL_HOURS`（默认 7 天）。该偏好会记在浏览器里，下次打开登录页自动勾选。

**登录限流（防暴力破解）**

密码是短口令，若允许无限次尝试，脚本几分钟就能穷举完，因此登录接口带 IP 限流：

- 同一 IP 在 `LOGIN_FAIL_WINDOW_MINUTES` 分钟内失败达到 `LOGIN_MAX_FAILS` 次后，返回 **429** 并带 `Retry-After`；
- **锁定期内即使密码正确也会被拒绝**（否则限流可被「猜中即通过」绕过）；
- 采用**滑动窗口**：最早那次失败滑出窗口即自动解锁，无需人工干预；
- 被拦下的请求会以 `触发限流` 记入审计，但**该原因不计入失败窗口** —— 否则持续请求会把窗口无限续期，变成永久封禁；
- 只按 **IP** 计数，不按账号计数，避免攻击者用错误密码把正常用户「顺手锁死」；
- 失败次数快用完时，登录页会提示剩余次数，锁定时显示等待时间。

数据源直接复用 `login_log` 表，**不引入额外内存状态**，因此后端重启不会让计数清零。

> **`TRUST_PROXY` 为什么默认关闭**：后端直接监听 `0.0.0.0` 对外提供服务，前面没有反向代理覆写
> `X-Forwarded-For`。若此时采信该头，任何客户端都能随手伪造或轮换它，**限流就会被完全绕过**。
> 默认取 TCP 连接的真实来源 IP；只有当确实在 Nginx 等反向代理之后（且代理会覆写该头）时，
> 才把 `TRUST_PROXY` 设为 `true`。

**登录记录（谁登录了平台）**

每次登录尝试都会写入 `login_log` 表，成功和失败都记（含时间、账号、结果、失败原因、IP、浏览器/设备）。在「**系统管理**」页的「登录记录」卡片可查看：

- 顶部统计：累计成功 / 失败尝试 / 今日成功；
- 支持按账号、结果（仅成功 / 仅失败）、日期范围过滤，分页浏览；
- 表格展示时间、账号、结果、备注（如 `密码错误`、`账号不存在`、`触发限流`、`主动退出`）、IP、浏览器。

表由独立迁移脚本创建，**不放在 `schema.sql`**（那个脚本会 DROP 数据）：

```bash
node server/db/migrate-login-log.js    # 幂等，可重复执行
```

**实现要点**

- 令牌为 HMAC-SHA256 签名的无状态令牌（`base64url(payload).signature`），**不需要服务端 session 或 Redis**；
  payload 内含用户名、用途（scope）与过期时间。
- 令牌存于浏览器 `localStorage`，刷新/重开浏览器保持登录；后端重启后若密钥变化会自动要求重新登录。
- 任一接口返回 401（登录过期）时，前端拦截器会清掉令牌、弹一次提示并跳转登录页（带 `redirect` 参数，登录后回到原页面）。
- 密码比较使用 `timingSafeEqual` 定长比较；用户名与密码两个字段都参与比较且不短路。

**同步授权**

「立即同步」按钮复用登录令牌，**登录即授权**（能登录看板说明是自己人）。
未启用登录保护时不再做额外校验 —— 此时看板本身已对局域网完全开放，
若在意这一点请务必保留登录配置。

**边界说明**：后端默认监听 `0.0.0.0`，HTTP 明文传输，适合局域网内使用。
若需对外网暴露，请配合 HTTPS（令牌在明文 HTTP 下可被抓包）。
若只想允许本机访问，把 `server/index.js` 中 `app.listen(PORT, ...)` 改为
`app.listen(PORT, '127.0.0.1', ...)`。

## 云端一键同步（推荐）

数据主链路：**金山文档 → 本地 xlsx → PostgreSQL → 网页看板**，有两种触发方式。

### 方式一：网页端点按钮（最常用）

进入「**系统管理**」页 → 点「**立即同步**」，即可完成「抓云端 → 入库」，约 8 秒。
页面提供分阶段进度、实时滚动日志，完成后各看板页面自动为最新。

> 需登录后才能操作（登录即授权）。同一时刻只允许一个同步任务，重复点击会被拦截并接入现有进度。

### 方式二：双击 bat / 命令行

```
双击桌面「云端看板.bat」
  ├─ kdocs_pull.py    从金山文档抓最新数据 → 落到「应收看板-数据导出」
  ├─ sync_watch.py    生成图片看板（PNG/HTML → 「看板输出」文件夹）
  └─ sync.js --import 自动把 xlsx 导入 PostgreSQL（网页看板即最新）
```

也可以单独运行（不依赖 bat）：

```bash
node sync.js            # 抓取 + 入库（全自动）
node sync.js --import   # 只入库（用已抓好的本地文件）
node sync.js --pull     # 只抓取（不入库）
```

> 后端运行时，若 `IMPORT_WATCH_ENABLED=true`，watcher 会监控「应收看板-数据导出」目录，
> 抓完 15 秒内自动入库（与网页按钮双保险，导入幂等同日覆盖）。当前为 `false`（只用网页按钮触发）。

## 技术栈

| 层        | 技术                          |
| -------- | --------------------------- |
| 前端       | Vue 3 + Vite + Element Plus |
| 状态       | Pinia（业务类型切换）               |
| 路由       | Vue Router 5                |
| 请求       | Axios                       |
| 后端       | Node.js + Express 5         |
| 数据库      | PostgreSQL 16               |
| Excel 解析 | SheetJS (xlsx)              |

## 首次初始化（只在第一次部署时执行）

\\ash
# 1. 创建数据库（需先用 postgres 用户登录 psql）
createdb -U postgres cloud_dashboard

# 2. 建表 + 视图
npm run db:init

# 3. 导入第一批数据（从桌面导出目录）
npm run db:import:unpaid
npm run db:import:uninvoiced
\
> 详见下方「手动导入 Excel」章节。

## 环境状态


本机已装好并运行：

- PostgreSQL 16.15，服务 `postgresql-x64-16`（Windows 服务，自动启动）
- 超级用户 `postgres` / 密码 `postgres`
- 数据库 `cloud_dashboard`（UTF8）
- 程序目录 `C:\Program Files\PostgreSQL\16`
- **数据目录 `D:\PostgreSQL\data`**（已从 C 盘迁出，迁移前备份在 `D:\PostgreSQL\data-backup-20260920`）

> 数据目录迁移方式：停服务 → 移动 `data` → WMI 改服务定义 `-D` 参数（`sc.exe` 被本机安全策略拉黑，需用 `Invoke-CimMethod`）。验证方式：`SHOW data_directory;` 应输出 `D:/PostgreSQL/data`。

## 目录结构

```
cloud-dashboard/
├── start.js                    # 启动入口（体检 + 并行起前后端）
├── sync.js                     # 云端一键同步（抓金山文档 + 入库）
├── server/
│   ├── index.js                # 服务入口：中间件、路由挂载、错误处理
│   ├── watcher.js              # 文件夹监控，自动导入新 Excel
│   ├── services/
│   │   └── importer.js         # Excel 导入核心逻辑（CLI/watcher/sync 共用）
│   ├── db/
│   │   ├── pool.js             # 连接池与 query 封装
│   │   ├── schema.sql          # 建表 + 视图（含 customer_platform_unpaid）
│   │   ├── init.js             # 一键建表
│   │   └── import-excel.js     # 导入命令行壳
│   └── routes/
│       └── receivable.js       # 全部业务接口（含客户平台）
├── src/
│   ├── api/
│   │   ├── request.js          # axios 实例与拦截器
│   │   └── index.js            # 接口封装
│   ├── stores/biz.js           # 业务类型状态（Pinia）
│   ├── layout/index.vue        # 侧边栏 + 业务类型切换
│   ├── router/index.js         # 路由表
│   └── views/
│       ├── Home.vue            # 数据概览
│       ├── Detail.vue          # 明细查询（筛选+分页+排序）
│       ├── ByCustomer.vue      # 按客户汇总
│       ├── Trend.vue           # 每日快照趋势
│       └── CustomerPlatformUnpaid.vue  # 客户平台未回款看板
├── .env                        # 数据库配置 + 监控目录
└── package.json
```

## 快速开始

```bash
npm install

npm run db:init                 # 建表
npm run db:import:unpaid "C:/Users/Administrator/Desktop/(已开票未回款-每天)未回款.xlsx"
npm run db:import:uninvoiced "C:/Users/Administrator/Desktop/(已发货未开票-每天)未开票 (1).xlsx"

npm start                       # 一键：先体检（依赖/配置/数据库/数据），再起前后端
```

### 启动方式

| 命令 | 说明 |
| --- | --- |
| `npm start` | **开发推荐**。先做环境体检，全部通过后并行启动前端（Vite）+ 后端 |
| `npm run check` | 只做环境体检，不启动（排查问题时用） |
| `npm run dev` | 直接并行启动，跳过体检 |
| `npm run dev:web` | 只启前端 |
| `npm run api` | 只启后端（不带热重载） |
| `npm run build` | 构建生产包到 `dist/` |
| `npm run build` | 构建生产包到 `dist/` |

体检会检查：依赖是否安装、`.env` 是否配置、PostgreSQL 是否连通、数据是否已导入。任何一项失败都会给出**可直接照做的修复命令**。

前端固定 5173（`strictPort: true`，被占用会直接报错而非静默漂移到 5174，避免多个实例同时跑）。后端固定 3000，端口冲突时会提示如何终止占用进程。

## 自动导入（文件夹监控）

后端启动时会监控一个文件夹，检测到符合命名规则的 Excel 出现或变更就**自动导入**，不用手动敲命令。

配置（`.env`）：

```bash
IMPORT_WATCH_ENABLED=true
IMPORT_WATCH_FOLDER=C:/Users/Administrator/Desktop/应收看板-数据导出
IMPORT_WATCH_INTERVAL=15000
```

登录与同步口令配置（详见上方「登录与安全」）：

```bash
LOGIN_USERS=4111=4111          # 多账号：user=pass,user2=pass2
LOGIN_TTL_HOURS=12
LOGIN_REMEMBER_TTL_HOURS=168
```

**识别规则**（按文件名，先匹配长关键词防误判）：

| 文件名包含      | 导入为                                        |
| ---------- | ------------------------------------------ |
| `客户未回款`    | `customer_platform_unpaid`（客户平台，独立表）       |
| `未回款`      | `billed_unpaid`（已开票未回款）                    |
| `未开票`      | `shipped_uninvoiced`（已发货未开票）               |

> 监控目录指向「应收看板-数据导出」——云端看板.bat / sync.js 抓取的文件就落在这里。**不要指向整个桌面**：桌面上若有其他文件名含「未回款」的表（如客户平台周报导出），曾被误判导入过。

行为说明：

- 采用**轮询**（默认 15 秒）而非 `fs.watch` —— Windows 上 `fs.watch` 事件不稳定且易重复触发
- 按 `文件大小 + mtime` 生成指纹去重，同一版本只导入一次
- 导入失败会移除指纹，允许你修好文件后自动重试
- 快照日期取**当天**日期

> 建议把监控目录单独设成一个「待导入」文件夹，不要直接指向桌面，避免误导入无关文件。

## 数据导入

```bash
# 通用形式
node server/db/import-excel.js <biz_type> "<xlsx路径>" [快照日期YYYY-MM-DD]

# 便捷脚本
npm run db:import:unpaid     "<未回款xlsx>"
npm run db:import:uninvoiced "<未开票xlsx>"
```

导入行为：

- 13 列自动映射到 `receivable_detail`
- 日期从 Excel 序列号转换（含 `46112.6111` 这类带小数的值，向下取整；序列 ≤0 或 <1000 视为无效）
- 业务员列自动拆解：`大客户中心` → `department`，其余 → `salesperson`
- **脏数据自动跳过**：分类为空 + 账龄分档全为 0 + 总额非 0 的行（记录在 `skipped_count`）
- **账龄不一致保留并标记**：分档之和 ≠ 总额时不丢弃，写入 `data_warning`，前端标黄
- 同业务类型 + 同日期重复导入会**覆盖**旧快照
- 事务导入 + 条数金额双校验，失败整体回滚

## API 一览

除 `/api/biz-types` 和 `/api/trend` 外，均支持 `?bizType=billed_unpaid|shipped_uninvoiced`（默认 `billed_unpaid`）。

| 方法  | 路径                                          | 说明                 |
| --- | ------------------------------------------- | ------------------ |
| GET | `/api/health`                               | 健康检查               |
| GET | `/api/biz-types`                            | 可用业务类型及最新快照        |
| GET | `/api/summary`                              | 顶部汇总               |
| GET | `/api/aging-by-salesperson`                 | 业务员 × 账龄档          |
| GET | `/api/aging-summary`                        | 账龄分档汇总             |
| GET | `/api/detail`                               | 明细查询（分页 + 筛选 + 排序） |
| GET | `/api/export/detail`                        | 导出明细 Excel（当前筛选的**全部**行） |
| GET | `/api/by-customer`                          | 按客户汇总              |
| GET | `/api/filters`                              | 筛选选项               |
| GET | `/api/trend`                                | 每日快照趋势             |
| GET | `/api/warnings`                             | 数据质量告警             |
| GET | `/api/customer-platform-unpaid/summary`     | 客户平台·顶部汇总          |
| GET | `/api/customer-platform-unpaid/breakdown`   | 客户平台·客户+平台两级汇总     |
| GET | `/api/customer-platform-unpaid/salespersons`| 客户平台·业务员列表（筛选）     |
| GET | `/api/customer-platform-unpaid/detail`      | 客户平台·订单级明细         |
| GET | `/api/export/customer-platform-detail`      | 导出客户平台订单明细 Excel（全部行） |

### `/api/detail` 查询参数

| 参数                  | 说明                                               |
| ------------------- | ------------------------------------------------ |
| `bizType`           | 业务类型                                             |
| `salesperson`       | 业务员精确匹配                                          |
| `customer`          | 客户精确匹配                                           |
| `agingCategory`     | 账龄档匹配（`未分类` 亦可）                                  |
| `from` / `to`       | 日期范围（`YYYY-MM-DD`）                               |
| `keyword`           | 模糊搜单据号或客户名                                       |
| `sortBy`            | `amountTotal` / `docDate` / `docNo` / `customer` |
| `sortOrder`         | `asc` / `desc`（默认 desc）                          |
| `page` / `pageSize` | 分页，默认 1 / 20，上限 500                              |

## 数据导出（Excel）

「**明细查询**」和「**客户平台订单明细**」两个页面都有「导出 Excel」按钮，
导出的是**当前筛选条件下的全部行**，不受页面上分页的限制。

- **后端生成** —— 新增 `/api/export/detail` 与 `/api/export/customer-platform-detail`。
  放服务端有三个理由：不受 `pageSize` 上限（500）限制、能用 Excel 的数字格式与列宽、
  `xlsx` 库不必打进浏览器包。
- **筛选逻辑与页面共用** —— 后端的 `buildDetailFilter()` / `buildCpuDetailFilter()` 被
  查询接口和导出接口同时使用，前端也是同一个 `buildFilterParams()`。
  **这是刻意的**：否则两边各写一份，改一处忘一处，导出结果迟早和页面所见对不上。
- **下载方式** —— 前端用 `responseType: 'blob'` + `createObjectURL`，
  不能用 `window.open`（那样带不上 `X-Auth-Token` 头）。鉴权与其它接口一致，走登录中间件。
- **文件内容** —— 首行即列标题（可直接在 Excel 里筛选/透视），末尾追加一行「合计」，
  表头开了自动筛选且**范围不含合计行**。金额列是真数字 + 千分位格式，能被 Excel 直接求和。
- **文件名** —— 形如 `已开票未回款明细_2026-09-20_206行.xlsx`，带上业务类型、快照日期和行数。
- **边界** —— 筛选无结果返回 404；单次导出上限 `EXPORT_MAX_ROWS`（20000 行），
  超了返回 413 并提示缩小范围，避免一个大查询把服务打满。

> 导出用的是项目已有的 SheetJS **社区版**（xlsx 0.18.5）。它支持数字格式、列宽、自动筛选，
> 但**不支持字体加粗、底色**等单元格样式（那是 Pro 功能），所以表格靠格式而非视觉取悦。
> 另外 SheetJS 读回文件时只还原格式化文本（`cell.w`），不会重建 `cell.z` —— 写校验时注意。

## 数据模型

### `import_batch` — 导入批次

| 字段                           | 说明        |
| ---------------------------- | --------- |
| `biz_type`                   | 业务类型      |
| `snapshot_date`              | 快照日期      |
| `row_count` / `total_amount` | 导入行数 / 金额 |
| `skipped_count`              | 跳过的脏数据行数  |

唯一约束 `(biz_type, snapshot_date)` —— 同类型同日期只保留一份。

### `receivable_detail` — 明细

源表列映射（两份源表一致）：

| 源表列    | 表字段                                                  | 说明                    |
| ------ | ---------------------------------------------------- | --------------------- |
| A 编号   | `doc_no`                                             | 未回款=开票方案编号，未开票=合同执行编号 |
| B 日期   | `doc_date`                                           | 未回款=开票日期，未开票=执行日期     |
| C 分类   | `aging_category`                                     | 5 档账龄，可能为空            |
| D 挂账客户 | `customer_name`                                      |                       |
| E 权限   | `permission_raw`                                     | 原文保留                  |
| F 业务员  | `salesperson_raw`                                    | 原文保留                  |
| —      | `department` / `salesperson`                         | 由 F 列拆解               |
| G 总金额  | `amount_total`                                       |                       |
| H–L    | `amount_over3m` / `_3m` / `_2m` / `_1m` / `_current` | 账龄分档                  |
| M 备注   | `follow_up_note`                                     |                       |
| —      | `data_warning`                                       | 账龄不一致提示               |

### 视图

| 视图                       | 用途         |
| ------------------------ | ---------- |
| `v_aging_by_salesperson` | 按业务员 × 账龄档 |
| `v_aging_summary`        | 按账龄分档      |
| `v_by_customer`          | 按客户        |
| `v_by_department`        | 按部门        |
| `v_daily_trend`          | 每日快照趋势     |
| `v_overview`             | 两个口径并列总览   |

## 当前数据（快照 2026-09-20，云端抓取）

| 指标    | 已开票未回款              | 已发货未开票                  | 客户平台未回款（每周四）      |
| ----- | ------------------- | ----------------------- | ----------------- |
| 金额合计  | 6,912,410.37        | 11,414,362.72           | 8,699,222.76      |
| 单据/订单 | 209                 | 553                     | 273               |
| 客户数   | 76                  | 266                     | 46（挂账客户）          |
| 业务员   | 7                   | 8                       | 6+未指定             |
| 3个月以上 | 1,926,448.16（27.9%） | 7,949,993.87（**69.6%**） | —（按订单日期另算）        |
| 跳过脏数据 | 0 行                 | 1 行                     | 0 行               |

> 客户平台为云端 27 列结构（含数据源/权限/预计回款平台日期等额外列），导入按表头列名映射，与桌面 23 列手动导出兼容。

**已开票未回款** 账龄：当月 238.0万 / 一个月 143.2万 / 两个月 98.7万 / 三个月以上 192.6万 / 三个月 18.6万

**已发货未开票** 账龄：三个月以上 795.0万 / 三个月 41.6万 / 两个月 69.0万 / 一个月 76.9万 / 当月 159.0万

> ⚠️ 「已发货未开票」的 3 个月以上占 69.6%，明显高于「已开票未回款」的 27.9% —— 说明存在大量长期挂账未开票的发货，是最需要关注的风险点。

## 已知数据问题

1. **业务员列混入部门名** — `大客户中心`（未回款 36 行 / 未开票 67 行），已拆到 `department`
2. **权限列格式不统一** — 有 `农立珍`、`刘晓欣19317272917`（带手机号）、`李雅芳,蒋超`（多人逗号分隔）、`W_雨霏`（疑似昵称），原文保留
3. **客户命名不规范** — 混合机构+部门+人名（如 `中行区分行个金部-陈小金`），未拆分
4. **1 行脏数据**（未开票 `ZX-26-2097`）— 日期为 0、分类为空、账龄分档全 0 但总额 7096.32，**已跳过**
5. **4 行负数冲销**（未开票）— `-143.14` / `-20.31` / `-3.67` / `-0.01`，分类为空但分档与总额一致，属正常红冲，**已保留**
6. **日期含小数** — 如 `46112.6111`、`45829.6914`，导入时向下取整

## 后续可扩展

- 每日导入后对比上期变化（`v_daily_trend` 已就绪，Trend 页已能显示环比）
- 逾期预警（源表无到期日字段，需补充数据源）
- 导出 Excel 报表
