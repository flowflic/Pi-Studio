#!/usr/bin/env bash
set -Eeuo pipefail

# Configure an HTTPS/WSS reverse proxy for the Pi Studio signaling service.
#
# Interactive usage:
#   bash scripts/configure-nginx-signaling.sh
#
# Non-interactive usage:
#   bash scripts/configure-nginx-signaling.sh \
#     relay.example.com \
#     /etc/letsencrypt/live/relay.example.com/fullchain.pem \
#     /etc/letsencrypt/live/relay.example.com/privkey.pem \
#     http://127.0.0.1:8787

SITE_NAME="pi-studio-signaling"
SITE_AVAILABLE="/etc/nginx/sites-available/${SITE_NAME}"
SITE_ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}"
ACME_ROOT="/var/www/acme"

log() {
    printf '[nginx-signaling] %s\n' "$*"
}

die() {
    printf '[nginx-signaling] ERROR: %s\n' "$*" >&2
    exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
    die "请使用 root 用户执行此脚本"
fi

if [[ ! -f /etc/os-release ]]; then
    die "无法识别操作系统"
fi

. /etc/os-release

if [[ "${ID}" != "debian" && "${ID}" != "ubuntu" ]]; then
    die "当前脚本仅支持 Debian 或 Ubuntu"
fi

if ! command -v nginx >/dev/null 2>&1; then
    log "未检测到 Nginx，正在安装"
    apt-get update
    apt-get install -y nginx
fi

if ! command -v openssl >/dev/null 2>&1; then
    log "未检测到 OpenSSL，正在安装"
    apt-get update
    apt-get install -y openssl
fi

DOMAIN="${1:-}"
SSL_CERT="${2:-}"
SSL_KEY="${3:-}"
PROXY_PASS="${4:-}"

if [[ -z "${DOMAIN}" ]]; then
    read -r -p '请输入域名，例如 relay.example.com: ' DOMAIN
fi

if [[ -z "${SSL_CERT}" ]]; then
    read -r -p '请输入 SSL 证书（公钥/fullchain）路径: ' SSL_CERT
fi

if [[ -z "${SSL_KEY}" ]]; then
    read -r -p '请输入 SSL 私钥路径: ' SSL_KEY
fi

if [[ -z "${PROXY_PASS}" ]]; then
    read -r -p '请输入反代地址 [http://127.0.0.1:8787]: ' PROXY_PASS
fi

PROXY_PASS="${PROXY_PASS:-http://127.0.0.1:8787}"

if [[ -z "${DOMAIN}" || "${DOMAIN}" == *[!A-Za-z0-9.-]* ]]; then
    die "域名格式无效：${DOMAIN}"
fi

if [[ "${DOMAIN}" == .* || "${DOMAIN}" == *. || "${DOMAIN}" == *..* ]]; then
    die "域名格式无效：${DOMAIN}"
fi

if [[ ! -f "${SSL_CERT}" ]]; then
    die "SSL 证书文件不存在：${SSL_CERT}"
fi

if [[ ! -r "${SSL_CERT}" ]]; then
    die "SSL 证书文件不可读：${SSL_CERT}"
fi

if [[ ! -f "${SSL_KEY}" ]]; then
    die "SSL 私钥文件不存在：${SSL_KEY}"
fi

if [[ ! -r "${SSL_KEY}" ]]; then
    die "SSL 私钥文件不可读：${SSL_KEY}"
fi

if [[ "${SSL_CERT}" == *[[:space:]]* || "${SSL_KEY}" == *[[:space:]]* ]]; then
    die "SSL 证书和私钥路径不能包含空格"
fi

if [[ ! "${PROXY_PASS}" =~ ^https?://[^/[:space:]]+$ ]]; then
    die "反代地址必须是类似 http://127.0.0.1:8787 的地址，不能包含路径"
fi

if ! openssl x509 -in "${SSL_CERT}" -noout >/dev/null 2>&1; then
    die "SSL 证书文件不是有效的 PEM/X.509 证书：${SSL_CERT}"
fi

# Nginx cannot start unattended with an encrypted private key. The command
# uses an empty passphrase explicitly so it never blocks for interactive input.
if ! openssl pkey -in "${SSL_KEY}" -noout -passin pass: >/dev/null 2>&1; then
    die "SSL 私钥无效，或是加密私钥。请提供未加密的私钥文件：${SSL_KEY}"
fi

install -d -m 0755 "$(dirname "${SITE_AVAILABLE}")" "$(dirname "${SITE_ENABLED}")" "${ACME_ROOT}"

BACKUP_FILE=""
if [[ -e "${SITE_AVAILABLE}" || -L "${SITE_AVAILABLE}" ]]; then
    BACKUP_FILE="${SITE_AVAILABLE}.bak.$(date +%Y%m%d%H%M%S)"
    cp -a "${SITE_AVAILABLE}" "${BACKUP_FILE}"
    log "已备份现有配置：${BACKUP_FILE}"
fi

write_config() {
    cat > "${SITE_AVAILABLE}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_ROOT};
        try_files \$uri =404;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${DOMAIN};

    ssl_certificate ${SSL_CERT};
    ssl_certificate_key ${SSL_KEY};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_ROOT};
        try_files \$uri =404;
    }

    location = /healthz {
        proxy_pass ${PROXY_PASS};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location = /ws {
        proxy_pass ${PROXY_PASS};
        proxy_http_version 1.1;

        # WebSocket Upgrade headers.
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }

    location / {
        return 404;
    }
}
NGINX
}

write_config
ln -sfn "${SITE_AVAILABLE}" "${SITE_ENABLED}"

if ! nginx -t; then
    log "Nginx 配置检查失败，正在恢复本次修改前的配置"
    if [[ -n "${BACKUP_FILE}" ]]; then
        cp -a "${BACKUP_FILE}" "${SITE_AVAILABLE}"
    else
        rm -f "${SITE_AVAILABLE}" "${SITE_ENABLED}"
    fi
    exit 1
fi

systemctl enable --now nginx
systemctl reload nginx

log "Nginx 配置完成"
log "WSS 地址：wss://${DOMAIN}/ws"
log "健康检查：https://${DOMAIN}/healthz"
log "反代地址：${PROXY_PASS}"

if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 5 "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
        log "HTTPS 健康检查通过"
    else
        log "提示：HTTPS 健康检查未通过，请确认 DNS、证书和后端服务已就绪"
    fi
fi
