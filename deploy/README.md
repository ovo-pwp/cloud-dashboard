# 云端看板 · 云服务器部署

把整套看板（前端 + 后端 + 数据库 + 金山文档同步）部署到一台云服务器上，
之后任何人打开域名就能用，不再依赖你本机一直开机。

> **本部署包已在 Docker 上完整实测通过**（2026-09-21）：
> 三个容器起得来、健康检查过、建表与迁移成功、**从金山文档真实抓取并入库三张源表**、
> 看板显示正确、真实浏览器登录成功、Excel 导出正常、
> 体检（本机 51 项 / 容器内 50 项 + 1 项跳过）**失败 0 项**。
>
> 实测中修掉的问题（都是「容器里才暴露」的）：
> ① 容器内 `python3` 被误判为「不存在」→ 同步永远抓不到数据；
> ② 同步失败提示把「入库失败」误报成「凭证失效」→ 误导用户去重新取 Token；
> ③ 源表里的 `1900/01/00`（Excel 空日期）让整张未开票表导入回滚；
> ④ 计数类字段回了字符串 → 表格按「单数」排序结果错乱；
> ⑤ **手工填 `.env` 时漏掉 `LOGIN_USERS` → 看板零认证对公网开放**（已加启动安全闸，见下方）；
> ⑥ **用 `openssl rand -base64` 生成数据库密码 → 密码含 `/`，`api` 容器起不来**（已提供 `gen-env.sh`）。

---

## 一、架构

```
                    公网
                     │
              ┌──────▼──────────────────────────┐
              │  web  (Caddy)   :80 / :443      │  ← 唯一对公网开放的入口
              │   · 托管前端静态文件              │
              │   · /api/* 反向代理              │
              │   · 自动申请 HTTPS 证书           │
              └──────┬──────────────────────────┘
                     │  compose 内部网络
              ┌──────▼──────────────────────────┐
              │  api  (Node + Python)           │  ← 不映射端口，仅内网
              │   · 26 个业务接口                 │
              │   · 调用 kdocs_pull.py 抓金山文档 │
              │   · 同步互斥锁 / 状态持久化        │
              └──────┬──────────────────────────┘
                     │
              ┌──────▼──────────────────────────┐
              │  db  (PostgreSQL 16)            │  ← 不映射端口，仅内网
              └─────────────────────────────────┘
```

**数据库不对公网暴露**，只有 80/443 对外开放。

---

## 二、需要准备什么

| 项 | 说明 |
|---|---|
| 一台云服务器 | 1 核 2G 起步够用；系统 Ubuntu 22.04 / 24.04 最省事 |
| Docker + Compose 插件 | 见下方安装命令 |
| 域名（可选但强烈建议） | 配 HTTPS 用；只用 IP 也能跑，但没有加密 |
| 项目源码 | 把整个 `cloud-dashboard` 目录传到服务器 |
| 金山文档 Token | 见第五节 |

### 该买什么服务器（选型建议）

| 项 | 建议 |
|---|---|
| 配置 | **2 核 2G** 起步；1 核 2G 也能跑，但构建前端时建议先加 swap |
| 系统盘 | ≥ 40G（镜像 + 数据库 + 备份都占地方） |
| 系统 | Ubuntu 22.04 / 24.04 LTS |
| 带宽 | 3 Mbps 起步。「看板」是办公内网用，不需要大带宽 |
| 地域 | **见下，这一步决定你要不要备案** |

**地域与备案，买之前先想清楚：**

- **中国大陆地域**（北京/上海/广州…）：延迟最低最稳。但**绑定域名必须完成 ICP 备案**，
  通常要 1～3 周并需要相应资质。不备案就只能用 `http://IP/` 明文访问，
  登录密码会明文过网。
- **中国香港地域**：**免备案**，绑域名当场生效，Caddy 立刻能签 HTTPS 证书。
  代价是大陆访问延迟略高（香港一般 30～60ms，够用）。

> 急着上线又不想等备案：先买**中国香港**地域，配上域名直接跑 HTTPS；
> 之后要长期正规运营，再迁到大陆地域并补备案。

安装 Docker（Ubuntu）：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker   # 免 sudo
docker compose version                            # 确认插件已装
```

> 服务器内存只有 1G 时，构建前端可能被 OOM 杀掉。可以加一条 swap：
> `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`

### ⚠ 国内服务器必看：拉不动 Docker Hub

**这是国内部署最常见的卡点**，症状是先卡一会儿然后报：

```
ERROR: failed to authorize: failed to fetch anonymous token:
  Get "https://auth.docker.io/token?...": Bad Gateway
```

原因是 `auth.docker.io` / `registry-1.docker.io` 在国内多数网络下不可达
（本机实测也是这样，与部署包本身无关）。

**解法：给 Docker 配国内镜像加速器。** 编辑 `/etc/docker/daemon.json`
（没有就新建）：

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me"
  ]
}
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
docker info | grep -A4 "Registry Mirrors"     # 确认已生效
```

然后重新执行 `docker compose up -d --build`。

> 镜像加速器是公益服务，可用性会变。上面几个是从本机实测能通的（2026-09）。
> 若全都不通，换成你所在云厂商的镜像源（腾讯云内网用
> `https://mirror.ccs.tencentyun.com`，阿里云控制台有专属加速地址）。

**备用方案**（不想改 daemon 配置、或加速器也不通时）——手动拉基础镜像再改回标准名：

```bash
for img in node:22-bookworm-slim caddy:2-alpine postgres:16-alpine; do
  docker pull docker.m.daocloud.io/library/$img
  docker tag  docker.m.daocloud.io/library/$img $img
done
docker compose up -d --build
```

另外，`api` 镜像构建时要 `apt-get install python3-openpyxl` 和 `npm ci`，
国内网络下可能很慢。若卡住，可在 `deploy/Dockerfile.api` 里把 apt 源换成国内镜像：

```dockerfile
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-openpyxl ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
```

---

## 三、快速开始

### 1. 在本地：打包源码

`node_modules` 有 200 多 MB，而容器构建时会自己重新安装，**不要传上去**：

```bash
cd "C:/Users/Administrator/Desktop"          # 切到 cloud-dashboard 的上一级

tar -czf cloud-dashboard.tgz \
  --exclude=node_modules --exclude=dist --exclude=.git \
  --exclude=deploy/backups --exclude=server/logs \
  cloud-dashboard

scp cloud-dashboard.tgz root@<服务器IP>:~/
```

> 排除之后只剩几百 KB。直接 `scp -r` 整个目录会把 237 MB 的
> `node_modules` 一起拖上去，慢且毫无意义。

### 2. 在服务器上：解包并生成配置

```bash
cd ~ && tar -xzf cloud-dashboard.tgz && cd cloud-dashboard/deploy

chmod +x *.sh
./gen-env.sh                    # 交互式；不让它问就直接 -u 你的用户名
```

`gen-env.sh` 会一次性生成好 `POSTGRES_PASSWORD`、`AUTH_SECRET` 和登录密码
（全是 URL 安全的随机串），并把登录密码打印出来。**请立刻存进密码管理器。**

有域名的话顺便指定，Caddy 会自动申请 HTTPS 证书：

```bash
./gen-env.sh -u admin -s kanban.example.com
```

> 为什么不用手工填 `.env`：见第四节 —— 手工填有两个能把人坑半天的经典事故。

### 3. 构建并启动

```bash
docker compose up -d --build    # 首次 5～10 分钟：下镜像 + 装依赖 + 打包前端
./init-db.sh                    # 建表，只在新服务器上执行一次
```

### 4. 打开看板

访问 `http://<服务器IP>/`（配了域名则是 `https://你的域名/`），
用 `gen-env.sh` 给出的账号登录，到「系统管理」页点一次「立即同步」。
第一次同步需要几分钟（要调 `kdocs_pull.py` 抓金山文档）。

---

## 四、配置：别手填，跑 `gen-env.sh`

`deploy/.env` 里有四项不能将就。**手工填有两个经典事故**，所以交给脚本：

```bash
./gen-env.sh -u 你的用户名 -s kanban.example.com
```

它会一次性写好：

| 项 | 生成内容 |
|---|---|
| `POSTGRES_PASSWORD` | 32 位随机串（纯字母数字） |
| `AUTH_SECRET` | 64 位随机 hex |
| `LOGIN_USERS` | `用户名=随机密码:admin`（加了 `-v` 则再跟一个 `:member` 成员账号） |
| `SITE_ADDRESS` | 按 `-s` 参数，默认 `:80` |

想要「自己一个管理员 + 给同事一个成员账号」这两个，加上 `-v`：

```bash
./gen-env.sh -u admin -v finance -s kanban.example.com
```

它会生成 `LOGIN_USERS=admin=xxxx:admin,finance=yyyy:member`，
并把两个密码都打印出来。角色说明见下方「账号权限」。

### 事故一：`LOGIN_USERS` 留空 = 看板对全网裸奔

鉴权在「一个账号都没配」时是**直接放行**的（本机开发图方便）。所以 `.env` 里
`LOGIN_USERS` 空着，就等于任何人都能进来看真实客户的应收和开票数据。

为此加了**启动安全闸**：当 `NODE_ENV=production`（compose 里已强制）且未配任何账号时，
`api` 容器会**拒绝启动**，并打印出具体改法 —— 而不是默默跑起来：

```
==================================================================
  启动已中止（安全闸）
==================================================================
生产环境检测到「未配置任何登录账号」，已拒绝启动。
  ...
    1) 配置登录账号（推荐）：
         LOGIN_USERS=用户名=强密码
    2) 确实要做「无人认证的公开只读看板」：
         ALLOW_ANONYMOUS_ACCESS=true
```

确实要做无人认证的公开只读看板，才显式写 `ALLOW_ANONYMOUS_ACCESS=true`
（这个逃生舱只认 `true`，大小写随意；`yes` / `1` / `on` 都不算）。

### 事故二：`openssl rand -base64` 生成数据库密码 → 容器起不来

compose 是把密码**拼进连接串**的：

```
postgresql://用户:密码@db:5432/库名
```

而 base64 会产出 `/` 和 `#`，连接串就变成：

```
postgresql://cloud_dashboard:abc/defghijklmnop@db:5432/cloud_dashboard
                              └─ 这个 / 把 URL 结构切断了
```

`pg` 解析时直接抛 `ERR_INVALID_URL`，`api` 容器起不来，而报错信息完全指不到根因。
密码里的 `%` 更阴：不报错，但会被 URL 解码成另一个值，表现为「密码认证失败」。

所以二选一：

- `./gen-env.sh`（生成纯字母数字）✅ 推荐
- `openssl rand -hex 24`（纯十六进制）✅ 也可以

体检里有一条断言专门守这个字符集。**`LOGIN_USERS` 的密码同理不能含英文逗号 `,` 或等号 `=`，**
它们是 `user1=pass1:role,user2=pass2` 这个格式的分隔符。
另外密码也别以 `:admin` / `:member` 结尾 —— 那会被当成角色切走，于是你记的密码不是真密码、
主账号还可能悄悄降权。`gen-env.sh` 会在生成前就把这三种写法拦下来。

### `AUTH_SECRET` —— 令牌签名盐值

不设置会退回用**容器主机名**当盐值：既不安全（主机名可猜），
容器重建后还会让所有人被强制退出登录。`gen-env.sh` 会自动填好。

### `SITE_ADDRESS` —— 站点地址

```
SITE_ADDRESS=kanban.example.com     # 有域名：自动申请并续期 HTTPS 证书
SITE_ADDRESS=:80                    # 只有 IP：纯 HTTP，先跑通再说
```

用域名需要：域名 A 记录已指向服务器 IP，且 80/443 能从公网访问。
Caddy 会自动申请和续期证书，不用自己折腾 certbot。

> **长期挂公网请务必用域名走 HTTPS。** `:80` 是明文传输，
> 登录密码会以明文经过网络 —— 只适合「先跑通看看」。

### 改完配置后

```bash
docker compose up -d          # 让新配置生效
docker compose logs -f web    # 看证书申请情况
```

### 账号权限：管理员 / 成员两档

账号格式是 `用户名=密码:角色`，角色只有两个，**不写就是管理员**：

| 角色 | 能做什么 |
|---|---|
| `admin`（管理员） | 全部功能：看板 + 「立即同步」+ 导出 Excel + 改明细的备注 / 人工提醒 + 系统管理（登录记录 / 同步历史） |
| `member`（成员） | 所有页面的数据都能看，**也能导出 Excel、也能改明细的备注与人工提醒**；但**不能同步、进不了系统管理** |

> 「提醒」有两个，别混：**人工提醒**是人填的（新字段 `manual_reminder`），
> **提醒**列的黄色 ⚠ 图标是系统自动检测的数据质量问题（账龄分档与总额对不上），同步时重算、人改不了。
> 两者在同一格里并排显示，互不覆盖。

> 旧角色名 `viewer` 仍会被当作 `member` 处理（防止手写的老配置登不上），但新配置请直接写 `member`。

```bash
# 自己留管理员，给财务 / 业务同事发成员账号
LOGIN_USERS=zhangsan=Kf7xQ2mP9a:admin,lisi=Rt4bW8nE3s:member
```

成员账号的实际表现（三层都拦，不是只藏个按钮）：

- 侧边栏**没有**「系统管理」入口；直接敲 `/system` 地址会被弹回首页并提示原因
- 首页没有「系统管理」入口卡
- 导出 Excel **可用**，明细页的备注与人工提醒**可点可改**（与管理员一致）
- 就算绕过页面直接调接口，后端也返回 **403**（`POST /api/sync`、`GET /api/system-config`、
  `GET /api/login-log`、`GET /api/login-users`、`GET /api/sync/status|runs`）

**改角色立刻生效**：改完 `LOGIN_USERS` 后 `docker compose up -d` 即可，不必等旧令牌过期
（后端每次校验都按当前配置取角色，而不是令牌里签发时的那个）。
启动日志会打印每个账号的角色，方便确认没配错：

```
登录保护: 已开启（账号 zhangsan·管理员、lisi·成员｜普通 12h，记住我 168h）
账号权限: 管理员 = 全部功能；成员 = 看数据 + 导出 Excel + 改备注（同步/系统管理仍限管理员）（当前成员：lisi）
```

### 之后想加账号 / 改密码

直接编辑 `deploy/.env` 的 `LOGIN_USERS`（逗号分隔多个），然后 `docker compose up -d`。
**改密码只会让那个账号的令牌失效**，其他人不受影响；换 `AUTH_SECRET` 才会让所有人重新登录。

---

## 五、让服务器能抓数据

同步要调 `kdocs_pull.py`，它需要**脚本本体**和**金山文档 Token**。
这两样**已经在 `deploy/kdocs/` 里**，前面打包上传时会一起带过去：

```
deploy/kdocs/
├── kdocs_pull.py        # 抓取脚本
└── kdocs_token.txt      # 金山文档 Token（敏感凭证）
```

到服务器上确认一下并收紧权限（Token 是敏感凭证）：

```bash
cd ~/cloud-dashboard/deploy
ls -l kdocs/                                       # 确认两个文件都在
chmod 700 kdocs && chmod 600 kdocs/kdocs_token.txt
```

> 若 `kdocs_pull.py` 不在，网页的「系统管理」页会红字提示
> 「环境检查未通过，缺少：抓取脚本」。

不需要重启容器 —— 每次同步都是现读这两个文件。
到网页点「立即同步」验证一下。第一次要跑几分钟（要抓三个数据源）。

### Token 过期了怎么办

金山文档 Token 有有效期，过期后同步会报「凭证已失效（400006）」。
拿到新 Token 后覆盖同名文件即可，**不用重启容器**：

```bash
# 在本地执行
scp "新的token文件.txt" root@<服务器IP>:~/cloud-dashboard/deploy/kdocs/kdocs_token.txt
```

### 想让它自动同步？

编辑 `.env`：

```
KDOCS_SCHEDULER_ENABLED=true
KDOCS_SCHEDULER_INTERVAL_MIN=60    # 每小时一次
```

```bash
docker compose up -d
```

定时轮询和网页按钮**共用同一把数据库级互斥锁**，同时触发也只会跑一个。

---

## 六、历史数据迁移（可选）

服务器能自己从金山文档同步，所以这一步只为保留**历史快照**
（比如「每日趋势」页要看的多天曲线 —— 新库上只有同步之后的数据）。

在**本地 Windows** 上：

```powershell
cd "C:\Users\Administrator\Desktop\cloud-dashboard\deploy"
.\push-local-data.ps1 -Server <服务器IP>
```

它会：本机 `pg_dump` → `scp` 上传 → 在服务器上导入（覆盖同名表）。
本地会在 `deploy/backups/` 留一份导出副本。

> Linux / macOS 本机等价命令：
> ```bash
> pg_dump --dbname="$DATABASE_URL" --clean --if-exists --no-owner -f dump.sql
> scp dump.sql root@<IP>:/tmp/
> ssh root@<IP> "cd ~/cloud-dashboard/deploy && docker compose exec -T db psql -U cloud_dashboard -d cloud_dashboard < /tmp/dump.sql"
> ```

---

## 七、日常运维

```bash
cd ~/cloud-dashboard/deploy

docker compose ps                  # 看各容器状态与健康检查
docker compose logs -f api         # 后端日志
docker compose logs -f web         # Caddy 日志（访问日志也在这）
docker compose restart api         # 只重启后端
docker compose down                # 停掉（数据保留在卷里）
docker compose up -d --build       # 改完代码后重新发布
```

### 健康自检（推荐部署完跑一次）

项目自带一个只读体检脚本，会逐个调用接口并拿「接口返回」与「库内真值」交叉核对
（50 项：汇总口径、分页求和、导出文件、账龄分布、快照日期、字段类型契约、
索引与锁、上公网安全闸）。
它可以直接在容器里跑，**建议在服务器上也执行一次**：

```bash
docker compose exec -T api node server/test/audit.test.mjs
```

期望输出结尾是 `通过 50 项，失败 0 项，跳过 1 项`（合计 51 项）
（跳过的 1 项是「前端 dist 产物」：前端文件在 web 镜像里，
api 容器内没有 `dist/`，属正常。在本机项目根目录跑则是 `通过 51 项，失败 0 项`）。

只要 **失败 0 项**，就说明数据链路、口径、日期都没有漂移。

### 备份

```bash
./backup.sh                        # 手动备份一次，落在 deploy/backups/
```

加到 crontab 每天自动备份并保留 14 天：

```bash
crontab -e
# 追加一行：
0 3 * * * cd /root/cloud-dashboard/deploy && ./backup.sh >> backups/cron.log 2>&1
```

**恢复**（会覆盖当前数据）：

```bash
gunzip -c backups/cloud_dashboard-20260921-030000.sql.gz \
  | docker compose exec -T db psql -U cloud_dashboard -d cloud_dashboard
```

### 连数据库看看

数据库没有对公网开放，要连就进容器：

```bash
docker compose exec db psql -U cloud_dashboard -d cloud_dashboard
```

---

## 八、安全清单（上公网前逐条确认）

- [ ] `.env` 是用 `./gen-env.sh` 在**服务器上**生成的 ——
      **不是**从本机 `scp` 带过去的那份（本机那份是为自测留的弱口令）
- [ ] `LOGIN_USERS` 已配好，不是 `4111/4111` 之类
- [ ] 每个账号的角色都是你想要的（`admin` / `member`）—— 只给「看 + 导出 + 改备注」的人一律发 `member`
- [ ] 没有把**本机 `.env` 原样带上服务器**（那份是为自测留的口令，服务器上应用 `./gen-env.sh` 重新生成）
- [ ] `POSTGRES_PASSWORD` 是随机长串，且**不含 `/` `#` `%`**（`gen-env.sh` 生成的天然满足）
- [ ] `AUTH_SECRET` 已设置为随机长值
- [ ] **没有**为了图省事设 `ALLOW_ANONYMOUS_ACCESS=true`
- [ ] 用域名 + HTTPS（`SITE_ADDRESS=你的域名`），不要长期停在 `:80` 明文
- [ ] 服务器防火墙只放 22 / 80 / 443，**不要**放 3000 和 5432
- [ ] `docker compose ps` 里 db / api 没有对外映射端口
- [ ] `deploy/.env` 与 `deploy/kdocs/kdocs_token.txt` 权限已收紧，且不在 git 里
- [ ] 已配置数据库自动备份

全部勾完，再跑一次「健康自检」，确认 `失败 0 项`。

> 关于认证强度的实话：本项目登录模块的定位是
> 「防止局域网内他人随意访问」级别（HMAC 令牌 + 按 IP 限流 + 密码比对），
> 不是对抗专业攻击的强认证体系。放到公网上，**安全性主要靠 HTTPS + 强密码 +
> 不暴露多余端口**。如果数据敏感度高，建议再在前面加一层访问控制
> （例如 Cloudflare Access、Nginx basic auth，或只允许公司固定 IP 访问）。

### 想限制只有公司 IP 能访问？

在 `deploy/Caddyfile` 的站点块最上面加：

```
@blocked not remote_ip 203.0.113.0/24 198.51.100.7
respond @blocked "Forbidden" 403
```

（把 IP 段换成公司出口 IP）改完 `docker compose restart web`。

---

## 九、常见问题

**Q：`docker compose up` 报 POSTGRES_PASSWORD 未设置**
`.env` 没建或没填。跑 `./gen-env.sh` 生成一份即可。

**Q：`api` 容器反复重启，日志里是「启动已中止（安全闸）」**
`.env` 里没有配任何登录账号，而 `NODE_ENV=production` 下这是被禁止的
（不禁止的话看板会零认证对全网开放）。按日志提示填 `LOGIN_USERS=用户名=强密码`，
然后 `docker compose up -d api`。

**Q：`api` 容器起不来，日志里是 `ERR_INVALID_URL`**
`POSTGRES_PASSWORD` 里含 `/` 或 `#`，把 `DATABASE_URL` 的结构切断了。
换成不含这些字符的密码（`./gen-env.sh` 或 `openssl rand -hex 24`）。

**Q：报 `password authentication failed`**
两种常见原因：

1. 密码里含 `%` —— 它会被 URL 解码成别的字符，于是数据库收到的密码
   与 `POSTGRES_PASSWORD` 不一致。换掉。
2. **改过 `POSTGRES_PASSWORD`，但数据卷还是用旧密码初始化的**
   —— PostgreSQL 只在**首次初始化**时读取该变量，之后改 `.env` 对已有数据卷无效。
   要么改回旧密码，要么重建数据卷（**会清空数据，先备份**）：
   ```bash
   docker compose down
   docker volume rm deploy_pgdata     # ⚠ 数据会没，先 ./backup.sh
   docker compose up -d
   ```

**Q：构建时报 `failed to fetch anonymous token ... Bad Gateway`**
国内网络连不上 Docker Hub，与部署包无关。按第二节「⚠ 国内服务器必看」配镜像加速器。

**Q：网页能打开，但接口全 401 / 点登录没反应**
多半是 `SITE_ADDRESS` 与实际访问地址不一致导致 Caddy 没配到这个站点。
先确认 `docker compose logs web` 里站点已加载。

**Q：某个账号点「立即同步」/ 进系统管理时报「没有该操作权限」（403）**
这个账号的角色是 `member`（成员）。同步/系统管理只给 `admin`；要让他也能同步，改成 `admin`，
或者这些操作你自己来。（导出 Excel 成员本来就能用，不会 403。）
403 是**故意**的（不是 401）：401 会被前端当成登录过期，把人踢回登录页。

**Q：改了账号角色，但那个人还是旧权限**
改的是 `.env` 后必须**重启 api 容器**（`docker compose up -d api`）才会读新配置。
重启后不用让对方重新登录 —— 后端每次校验都按当前配置取角色。

**Q：登录时提示「尝试次数过多」**
限流生效了：同一 IP 15 分钟内失败 5 次即锁定，等窗口过去即可。
如果误锁了自己，可以清一下记录：
```bash
docker compose exec db psql -U cloud_dashboard -d cloud_dashboard \
  -c "DELETE FROM login_log WHERE success = false;"
```

**Q：点「立即同步」提示缺少抓取脚本 / Python**
`deploy/kdocs/` 里没放 `kdocs_pull.py`，或文件名不对。见第五节。

**Q：同步报「凭证已失效（400006）」**
金山文档 Token 过期了，重新获取后覆盖 `deploy/kdocs/kdocs_token.txt`，不用重启容器。

**Q：容器重启后所有人都要重新登录**
`AUTH_SECRET` 没设置（退回主机名当盐值），或每次用 `--build` 重建导致主机名变了。
设置 `AUTH_SECRET` 后就不会再出现。

**Q：想换端口 / 换域名**
改 `.env` 的 `SITE_ADDRESS`，`docker compose up -d` 即可。端口在 `docker-compose.yml` 的 `web.ports`。

---

## 十、这套部署与「本机运行」的差异

| 项 | 本机开发 | 服务器部署 |
|---|---|---|
| 前端 | Vite dev server（5173，热更新） | 打包成静态文件，Caddy 托管 |
| 后端 | `node server/index.js` | 容器内常驻，崩溃自动重启 |
| 数据库 | 本机 PostgreSQL 16 | 容器内 PostgreSQL 16，数据在 docker 卷 |
| 同步 | 本机 Python 环境 | 容器内 Python3 + openpyxl |
| 访问 | `localhost:5173` | 域名 + HTTPS |
| 登录限流 IP | `req.socket.remoteAddress` | 采信 `X-Forwarded-For`（`TRUST_PROXY=true`） |
| 文件监控 | 可开（监控桌面导出目录） | 关闭（容器里没有桌面） |

功能上完全一致：登录、看板、筛选、明细、趋势、Excel 导出、立即同步、同步历史、登录记录，全都在。
