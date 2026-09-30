#!/usr/bin/env sh
# ============================================================
# 云端看板 · 生成生产用 .env
#
# 为什么需要这个脚本（两个真实踩过的高发事故）：
#
#   1) 漏填 LOGIN_USERS
#      → 鉴权在无账号时是放行的，看板会以「零认证」状态对公网开放，
#        而里面是真实客户应收/开票数据。（启动安全闸会拦住，但更该一开始就填对）
#
#   2) 用 base64 生成数据库密码
#      → base64 会产出 '/' 和 '#'，而 compose 是把密码拼进 DATABASE_URL 的：
#        postgresql://用户:密码@db:5432/库名
#        密码里的 '/' 或 '#' 会让 pg 直接抛 ERR_INVALID_URL，api 容器起不来；
#        密码里的 '%' 会被 URL 解码，导致密码静默变成另一个值，报认证失败。
#
#   本脚本生成的密码只用 [A-Za-z0-9]，在 URL / shell / compose / LOGIN_USERS
#   四种上下文里都不会出问题，从源头绕开上面第 2 类事故。
#
# 用法：
#   ./gen-env.sh                                  交互式（推荐）
#   ./gen-env.sh -u admin                         指定账号，登录密码随机生成
#   ./gen-env.sh -u admin -p 'MyPass8888'         账号密码都指定
#   ./gen-env.sh -u admin -v finance              再建一个成员账号 finance（随机密码）
#   ./gen-env.sh -s kanban.example.com            顺便设置站点域名
#   ./gen-env.sh -f                               已存在 .env 时覆盖（会先备份）
#
# 账号角色（写在 LOGIN_USERS 里，格式 用户名=密码:角色）：
#   admin   管理员 —— 全部功能：看板 + 立即同步 + 导出 Excel + 改备注 + 系统管理
#   member  成员   —— 看板 + 导出 Excel + 改明细备注（同步、系统管理仍限管理员）
# 用 -v（viewer 的老写法，沿用至今）建出来的那个账号就是 member；主账号固定为 admin。
#
# 生成的 .env 权限会被收紧到 600。
# ============================================================
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="$DIR/.env"
EXAMPLE_FILE="$DIR/.env.example"

LOGIN_USER=""
LOGIN_PASS=""
MEMBER_USER=""
SITE_ADDRESS=""
FORCE=0

# 打印本文件顶部的注释块（到 `set -eu` 为止）。
# 用 awk 而不是写死行号：以后往头部加/删说明都不会让 --help 显示错位。
usage() {
  awk 'NR > 1 && /^set -eu$/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -u) LOGIN_USER="${2:-}"; shift 2 ;;
    -p) LOGIN_PASS="${2:-}"; shift 2 ;;
    -v) MEMBER_USER="${2:-}"; shift 2 ;;
    -s) SITE_ADDRESS="${2:-}"; shift 2 ;;
    -f) FORCE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "未知参数：$1" >&2; echo >&2; usage 1 ;;
  esac
done

# ------------------------------------------------------------
# 随机串生成
#
# 用 /dev/urandom + tr 做「拒绝式过滤」，而不是「取模」——
# 取模会引入分布偏差；tr -dc 是丢弃不在字符集里的字节，分布是均匀的。
# 只用 tr/head/awk，不依赖 openssl（最小化安装的服务器不一定有）。
# ------------------------------------------------------------
gen_rand() {
  # $1=长度  $2=字符集
  LC_ALL=C tr -dc "$2" < /dev/urandom | head -c "$1"
}

ALNUM='A-Za-z0-9'
HEX='a-f0-9'

# ------------------------------------------------------------
# 入参校验：会在配置解析里「被吃掉」的字符必须挡在生成之前
#   ','  '='  → LOGIN_USERS 是 `user=pass:role,user2=pass2` 格式，会被拆错
#   空白      → compose 解析 .env 时会被截断
#   ':admin' / ':member' 结尾 → 会被后端当成角色切走，于是密码变成另一个值、
#                                而且主账号可能悄悄降权 —— 这种「没报错但配错了」
#                                最难查，所以在这里直接拦下
# ------------------------------------------------------------
validate_token() {
  # $1=值 $2=字段名
  case "$1" in
    "") echo "错误：$2 不能为空" >&2; exit 1 ;;
  esac
  case "$1" in
    *','*|*'='*) echo "错误：$2 不能包含英文逗号 , 或等号 =（会破坏 LOGIN_USERS 解析）" >&2; exit 1 ;;
    *[[:space:]]*) echo "错误：$2 不能包含空格" >&2; exit 1 ;;
    *':admin'|*':member'|*':viewer') echo "错误：$2 不能以 :admin / :member 结尾（会被当成角色，密码就不是你想要的那个了）" >&2; exit 1 ;;
  esac
}

if [ ! -f "$EXAMPLE_FILE" ]; then
  echo "错误：找不到 $EXAMPLE_FILE，请在 deploy 目录中运行本脚本。" >&2
  exit 1
fi

# ------------------------------------------------------------
# 已存在则确认（覆盖前自动备份）
#
# 注意顺序：无论走「交互确认」还是「-f 强制」，都必须先备份。
# 曾经把 cp 写在交互分支里，导致 -f 会跳过整块 = 连备份一起跳过，
# 一次「重新生成」就把旧 .env（含真实管理员密码）静默抹掉了。
# ------------------------------------------------------------
if [ -e "$ENV_FILE" ]; then
  if [ "$FORCE" -ne 1 ]; then
    echo "检测到 .env 已存在：$ENV_FILE"
    if [ -t 0 ]; then
      printf '要覆盖它吗？（会先备份为 .env.bak）[y/N] '
      read -r ans || ans=""
      case "$ans" in
        y|Y|yes|YES) ;;
        *) echo "已取消，未做任何修改。"; exit 0 ;;
      esac
    else
      echo "非交互模式下不会覆盖，请加 -f 参数。已退出。" >&2
      exit 1
    fi
  fi
  cp "$ENV_FILE" "$ENV_FILE.bak"
  echo "已备份到 $ENV_FILE.bak"
fi

# ------------------------------------------------------------
# 登录账号
# ------------------------------------------------------------
if [ -z "$LOGIN_USER" ]; then
  if [ -t 0 ]; then
    printf '请输入管理员用户名（回车用默认值 admin）: '
    read -r LOGIN_USER || LOGIN_USER=""
  fi
  [ -z "$LOGIN_USER" ] && LOGIN_USER="admin"
fi
# 去掉可能被粘贴进来的首尾空白
LOGIN_USER=$(printf '%s' "$LOGIN_USER" | tr -d ' \t\r\n')
validate_token "$LOGIN_USER" "管理员用户名"

if [ -z "$LOGIN_PASS" ]; then
  LOGIN_PASS=$(gen_rand 16 "$ALNUM")
  GEN_PASS=1
else
  GEN_PASS=0
  validate_token "$LOGIN_PASS" "管理员密码"
fi

# 可选：再建一个成员账号，方便把看板发给业务/财务同事（能看、能导出、能改备注，但不能同步、进不了系统管理）
GEN_MEMBER_PASS=0
if [ -n "$MEMBER_USER" ]; then
  MEMBER_USER=$(printf '%s' "$MEMBER_USER" | tr -d ' \t\r\n')
  validate_token "$MEMBER_USER" "成员账号用户名"
  if [ "$MEMBER_USER" = "$LOGIN_USER" ]; then
    echo "错误：成员账号用户名不能和管理员相同（$MEMBER_USER）" >&2
    exit 1
  fi
  MEMBER_PASS=$(gen_rand 16 "$ALNUM")
  GEN_MEMBER_PASS=1
fi

if [ -z "$SITE_ADDRESS" ]; then
  SITE_ADDRESS=":80"
fi

# ------------------------------------------------------------
# 生成密钥
# ------------------------------------------------------------
PG_PASS=$(gen_rand 32 "$ALNUM")   # 数据库密码：32 位字母数字，URL 安全
AUTH_SECRET=$(gen_rand 64 "$HEX") # 令牌签名盐值：64 位 hex

# ------------------------------------------------------------
# 基于 .env.example 生成，只替换值 —— 保持与模板同步，注释不丢
# ------------------------------------------------------------
cp "$EXAMPLE_FILE" "$ENV_FILE"

# 用 awk 精确替换「以 KEY= 开头」的那一行：
#   是字面匹配（index 不是正则），所以值里含特殊字符也不会出错；
#   只替换第一处，避免碰到注释里出现的同名文本。
set_kv() {
  key="$1"; val="$2"
  tmp="$ENV_FILE.tmp.$$"
  awk -v k="$key" -v v="$val" '
    !done && index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
  ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
}

# 主账号显式写上 :admin —— 生成的配置自己就能说明角色是什么
ACCOUNTS="${LOGIN_USER}=${LOGIN_PASS}:admin"
if [ -n "$MEMBER_USER" ]; then
  ACCOUNTS="${ACCOUNTS},${MEMBER_USER}=${MEMBER_PASS}:member"
fi

set_kv POSTGRES_PASSWORD "$PG_PASS"
set_kv AUTH_SECRET       "$AUTH_SECRET"
set_kv LOGIN_USERS       "$ACCOUNTS"
set_kv SITE_ADDRESS      "$SITE_ADDRESS"

# ------------------------------------------------------------
# 自检：替换是否真的生效（防止模板改版后静默失效）
# ------------------------------------------------------------
check_kv() {
  key="$1"
  if ! grep -q "^${key}=.\{1,\}" "$ENV_FILE"; then
    echo "错误：$key 写入失败，请检查 $EXAMPLE_FILE 是否还包含该字段。" >&2
    exit 1
  fi
}
check_kv POSTGRES_PASSWORD
check_kv AUTH_SECRET
check_kv LOGIN_USERS

# 成员账号写没写进去，直接看生成的文件，别靠“应该写进去了”这种判断
if [ -n "$MEMBER_USER" ]; then
  if ! grep -q ":member" "$ENV_FILE"; then
    echo "错误：成员账号未写入 LOGIN_USERS，请检查 $EXAMPLE_FILE。" >&2
    exit 1
  fi
fi

chmod 600 "$ENV_FILE" 2>/dev/null || true

# ------------------------------------------------------------
# 输出
# ------------------------------------------------------------
cat <<EOF

$(printf '=%.0s' $(seq 1 60))
  .env 已生成：$ENV_FILE
$(printf '=%.0s' $(seq 1 60))

  管理员账号 : $LOGIN_USER
EOF

if [ "$GEN_PASS" -eq 1 ]; then
  cat <<EOF
  管理员密码 : $LOGIN_PASS      <-- 随机生成，请立刻保存
EOF
else
  echo "  管理员密码 : （沿用你指定的值）"
fi

if [ "$GEN_MEMBER_PASS" -eq 1 ]; then
  cat <<EOF

  成员账号   : $MEMBER_USER
  成员密码   : $MEMBER_PASS      <-- 随机生成，请立刻保存
               （能看数据、能导出 Excel、能改备注，但不能同步 / 进系统管理）
EOF
fi

cat <<EOF

  数据库密码 : （已写入 .env，32 位随机）
  签名盐值   : （已写入 .env，64 位随机）
  站点地址   : $SITE_ADDRESS

$(printf '=%.0s' $(seq 1 60))

  请把上面的密码存到密码管理器里，之后无法再从这里查看。

  下一步：
    docker compose up -d --build
    ./init-db.sh

  以后再想加账号 / 改角色，直接编辑 .env 里那一行 LOGIN_USERS，然后：
    docker compose up -d      （重启即生效，不必等旧令牌过期）
EOF

if [ "$SITE_ADDRESS" = ":80" ]; then
  cat <<EOF

  提示：当前 SITE_ADDRESS=:80，是纯 HTTP。上公网建议改用域名以便自动
        申请 HTTPS 证书：先改 .env 里的 SITE_ADDRESS=你的域名
        （并把域名 A 记录指向本机），再 docker compose up -d。
EOF
fi
