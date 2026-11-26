#!/usr/bin/env bash
# XYZW 控制台 —— 新服务器一次性初始化
#
# 做的事：装 nginx / Node 20 / pm2，建好目录。
# 用法（在服务器上以 root 或 sudo 执行）：
#   bash setup-server.sh
#
# 可重复执行，已装过的步骤会跳过。
set -euo pipefail

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[警告] %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 或 sudo 执行"
  exit 1
fi

# ---------- 1. 识别系统 ----------
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VER="${VERSION_ID:-}"
else
  OS_ID="unknown"; OS_VER=""
fi
log "系统: ${OS_ID} ${OS_VER}"

PM=""
if command -v apt-get >/dev/null 2>&1; then PM="apt"
elif command -v dnf >/dev/null 2>&1; then PM="dnf"
elif command -v yum >/dev/null 2>&1; then PM="yum"
fi
[ -n "$PM" ] || { echo "找不到包管理器（apt/yum/dnf）"; exit 1; }

pkg_install() {
  case "$PM" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" ;;
    *)   "$PM" install -y "$@" ;;
  esac
}

# ---------- 2. 基础工具 + nginx ----------
log "安装基础工具与 nginx"
case "$PM" in
  apt)
    apt-get update -y
    pkg_install curl ca-certificates gnupg nginx rsync
    ;;
  *)
    pkg_install curl ca-certificates nginx rsync
    ;;
esac

systemctl enable nginx >/dev/null 2>&1 || true
systemctl start nginx || true

# ---------- 3. Node 20 ----------
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CUR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$CUR" -ge 18 ]; then
    NEED_NODE=0
    log "已有 Node $(node -v)，跳过安装"
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  log "安装 Node 20 LTS"
  # 优先用 npmmirror 的官方二进制包：不依赖系统源、版本确定、国内速度快。
  # （NodeSource 在 OpenCloudOS / 非标准 RHEL 衍生版上经常装不上）
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) NODE_ARCH="linux-x64" ;;
    aarch64|arm64) NODE_ARCH="linux-arm64" ;;
    *) echo "不支持的架构: $ARCH"; exit 1 ;;
  esac
  NODE_VER="v20.19.5"
  TARBALL="node-${NODE_VER}-${NODE_ARCH}.tar.xz"

  if curl -fL --max-time 300 "https://npmmirror.com/mirrors/node/${NODE_VER}/${TARBALL}" -o "/tmp/${TARBALL}"; then
    tar -xJf "/tmp/${TARBALL}" -C /usr/local --strip-components=1
    rm -f "/tmp/${TARBALL}"
  else
    warn "npmmirror 下载失败，回退到 NodeSource"
    curl -fsSL --max-time 30 https://rpm.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    pkg_install nodejs
  fi

  hash -r
  log "Node 版本: $(node -v) / npm: $(npm -v)"
fi

# ---------- 4. pm2 ----------
if ! command -v pm2 >/dev/null 2>&1; then
  log "安装 pm2"
  npm install -g pm2 --registry=https://registry.npmmirror.com
fi
log "pm2: $(pm2 -v)"

# ---------- 5. 目录 ----------
log "创建目录"
mkdir -p /var/www/xyzw
mkdir -p /opt/xyzw/backend/logs
chmod -R 755 /var/www/xyzw

# ---------- 6. 防火墙 ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  log "放行防火墙端口"
  ufw allow 80/tcp  >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
  ufw allow 3000/tcp >/dev/null || true
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  log "放行 firewalld 端口"
  firewall-cmd --permanent --add-port=80/tcp   >/dev/null || true
  firewall-cmd --permanent --add-port=443/tcp  >/dev/null || true
  firewall-cmd --permanent --add-port=3000/tcp >/dev/null || true
  firewall-cmd --reload >/dev/null || true
else
  warn "未检测到启用的 ufw/firewalld；如果云厂商有安全组，记得放行 80 / 443 / 3000"
fi

log "初始化完成"
echo
echo "nginx: $(nginx -v 2>&1)"
echo "node : $(node -v)"
echo "pm2  : $(pm2 -v)"
