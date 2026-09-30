#!/usr/bin/env bash
# ============================================================
# 首次部署：建表 + 视图 + 增量迁移
#
#   cd deploy
#   ./init-db.sh
#
# ⚠ 只在新服务器上跑一次。
#    server/db/init.js 会 DROP 并重建三张业务表（数据清空），
#    已有数据后再跑会丢数据 —— 那是脚本自带的行为（有 5 秒确认提示）。
#    之后要更新数据请用网页上的「立即同步」。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "✖ 找不到 deploy/.env，请先执行： cp .env.example .env  并按说明修改" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a
DB_USER="${POSTGRES_USER:-cloud_dashboard}"

echo "==> 1/4 等待数据库就绪"
for i in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U "$DB_USER" >/dev/null 2>&1; then
    echo "    数据库已就绪"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "✖ 数据库 60 秒内未就绪，请查看： docker compose logs db" >&2
    exit 1
  fi
  sleep 1
done

echo "==> 2/4 建表 + 6 个视图（schema.sql）"
docker compose exec -T api node server/db/init.js

echo "==> 3/4 增量迁移：登录记录表 login_log"
docker compose exec -T api node server/db/migrate-login-log.js

echo "==> 4/4 增量迁移：同步状态表 sync_run"
docker compose exec -T api node server/db/migrate-sync-run.js

echo
echo "✔ 初始化完成"
echo
echo "下一步："
echo "  1) 打开站点，用 deploy/.env 里配置的账号登录"
echo "  2) 到「系统管理」页点「立即同步」拉一次数据"
echo "     （若提示缺少 kdocs_pull.py 或 Token，见 deploy/README.md 第二节）"
