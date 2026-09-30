#!/usr/bin/env bash
# ============================================================
# 数据库备份
#
#   cd deploy
#   ./backup.sh              # 备份一次
#
# 建议加到 crontab，每天凌晨 3 点自动备份，并保留 14 天：
#   0 3 * * * cd /root/cloud-dashboard/deploy && ./backup.sh >> backups/cron.log 2>&1
#
# 保留天数可用环境变量覆盖： BACKUP_KEEP_DAYS=30 ./backup.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "✖ 找不到 deploy/.env" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a
DB_USER="${POSTGRES_USER:-cloud_dashboard}"
DB_NAME="${POSTGRES_DB:-cloud_dashboard}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

BK_DIR="./backups"
mkdir -p "$BK_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BK_DIR/${DB_NAME}-${STAMP}.sql.gz"

echo "==> 正在备份 $DB_NAME ..."
# --clean --if-exists：恢复时先删后建，可反复覆盖导入
# -T：不要分配 TTY，否则管道会被污染
if ! docker compose exec -T db \
      pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner --no-privileges \
      | gzip > "$FILE"; then
  echo "✖ 备份失败，删除半成品文件" >&2
  rm -f "$FILE"
  exit 1
fi

# 校验：gzip 完整性 + 文件非空（避免悄悄备份出一个空文件）
if [ ! -s "$FILE" ] || ! gzip -t "$FILE" 2>/dev/null; then
  echo "✖ 备份文件校验失败：$FILE" >&2
  rm -f "$FILE"
  exit 1
fi

echo "✔ 备份完成：$FILE（$(du -h "$FILE" | cut -f1)）"

# 清理过期备份
DELETED="$(find "$BK_DIR" -maxdepth 1 -name "${DB_NAME}-*.sql.gz" -mtime "+${KEEP_DAYS}" -print -delete | wc -l)"
if [ "$DELETED" -gt 0 ]; then
  echo "  已清理 ${DELETED} 个超过 ${KEEP_DAYS} 天的旧备份"
fi

echo
echo "恢复方式（会覆盖当前数据）："
echo "  gunzip -c $FILE | docker compose exec -T db psql -U $DB_USER -d $DB_NAME"
