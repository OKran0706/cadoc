#!/usr/bin/env bash
# install-sentinel.sh - standalone Sentinel agent installer (no repo checkout needed).
#
#   curl -fsSLk https://<backend>/install.sh | sudo bash -s -- \
#       --token <join-jwt> --server https://<backend> --client-id <slug>.<server-id> --ca-sha256 <hex>  [--profile app-server|db-server|k8s-node] [--interval seconds] [--jitter seconds]
#
# Downloads the binary + assets from <backend>/downloads, pins the Canary CA by
# SHA-256, writes config, installs auditd rules + systemd unit, starts the agent,
# waits for enrollment, then removes the one-time join token from disk.
set -euo pipefail

TOKEN=""; SERVER=""; CLIENT_ID=""; CA_SHA256=""; PROFILE="app-server"; INTERVAL="600"; JITTER="120"
while [ $# -gt 0 ]; do
  case "$1" in
    --token)      TOKEN="$2"; shift 2 ;;
    --server)     SERVER="${2%/}"; shift 2 ;;
    --client-id)  CLIENT_ID="$2"; shift 2 ;;
    --ca-sha256)  CA_SHA256="$2"; shift 2 ;;
    --profile)    PROFILE="$2"; shift 2 ;;
    --interval)   INTERVAL="$2"; shift 2 ;;
    --jitter)     JITTER="$2"; shift 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

INSTALL_DIR="/opt/canary"
CONF_DIR="/opt/sentinel/config"
TLS_DIR="/etc/canary/tls"
STATE_DIR="/var/lib/canary"
ENV_FILE="/etc/canary/sentinel.env"
UNIT="/etc/systemd/system/sentinel.service"

# --- Pre-flight checks ---
if [ "$(id -u)" -ne 0 ]; then echo "ERROR: run as root (use sudo)." >&2; exit 1; fi
[ -n "$SERVER" ]    || { echo "ERROR: --server is required." >&2; exit 2; }
[ -n "$CLIENT_ID" ] || { echo "ERROR: --client-id is required." >&2; exit 2; }
for c in curl tar sha256sum openssl systemctl; do
  command -v "$c" >/dev/null 2>&1 || { echo "ERROR: required command not found: $c" >&2; exit 1; }
done

ALREADY_PROVISIONED=0
[ -f "${STATE_DIR}/mtls.crt" ] && ALREADY_PROVISIONED=1
if [ "$ALREADY_PROVISIONED" -eq 0 ] && [ -z "$TOKEN" ]; then
  echo "ERROR: --token is required for first-time enrollment." >&2; exit 2
fi

case "$(uname -m)" in
  x86_64|amd64)  ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "ERROR: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$TLS_DIR" "$CONF_DIR" "$INSTALL_DIR" /etc/canary
chmod 755 /etc/canary

# --- Trust: fetch Canary CA (insecure fetch), verify pinned fingerprint, then use it ---
echo "[*] Fetching and verifying Canary CA..."
curl -fsSLk "${SERVER}/downloads/ca.crt" -o "${TLS_DIR}/ca.crt.new"
GOT_FP="$(openssl x509 -in "${TLS_DIR}/ca.crt.new" -outform DER | sha256sum | cut -d' ' -f1)"
if [ -n "$CA_SHA256" ]; then
  if [ "$GOT_FP" != "$(echo "$CA_SHA256" | tr 'A-F' 'a-f')" ]; then
    rm -f "${TLS_DIR}/ca.crt.new"
    echo "ERROR: CA fingerprint mismatch (expected ${CA_SHA256}, got ${GOT_FP}). Aborting." >&2
    exit 1
  fi
else
  echo "WARN: no --ca-sha256 supplied; trusting CA on first use (fingerprint ${GOT_FP})." >&2
fi
mv -f "${TLS_DIR}/ca.crt.new" "${TLS_DIR}/ca.crt"
chmod 644 "${TLS_DIR}/ca.crt"
CURL="curl -fsSL --cacert ${TLS_DIR}/ca.crt"

# --- Install auditd dependencies ---
echo "[*] Installing auditd dependencies..."
if command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -y </dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y auditd audispd-plugins </dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y audit audispd-plugins </dev/null || dnf install -y audit </dev/null
elif command -v yum >/dev/null 2>&1; then
  yum install -y audit audispd-plugins </dev/null || yum install -y audit </dev/null
fi

# --- Download + verify binary and assets ---
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "[*] Downloading Sentinel (${ARCH})..."
$CURL "${SERVER}/downloads/sentinel-linux-${ARCH}" -o "${TMP}/sentinel"
$CURL "${SERVER}/downloads/sentinel-linux-${ARCH}.sha256" -o "${TMP}/sentinel.sha256"
( cd "$TMP" && echo "$(cut -d' ' -f1 sentinel.sha256)  sentinel" | sha256sum -c - ) \
  || { echo "ERROR: binary checksum mismatch." >&2; exit 1; }

echo "[*] Downloading templates and profiles..."
$CURL "${SERVER}/downloads/sentinel-assets.tar.gz" -o "${TMP}/assets.tar.gz"
mkdir -p /opt/sentinel/templates "${INSTALL_DIR}/config" "${INSTALL_DIR}/deployed"
tar -xzf "${TMP}/assets.tar.gz" -C "$TMP"
cp -r "${TMP}/templates/." /opt/sentinel/templates/
mkdir -p "${INSTALL_DIR}/config/profiles"
cp -r "${TMP}/profiles/." "${INSTALL_DIR}/config/profiles/"   # deployer.LoadProfile reads <config>/profiles/<name>.yaml

# Stop a running agent before replacing its binary (idempotent re-runs).
systemctl stop sentinel.service 2>/dev/null || true
install -m 755 "${TMP}/sentinel" "${INSTALL_DIR}/sentinel"

# --- Config ---
echo "[*] Writing ${CONF_DIR}/sentinel.yaml..."
cat > "${CONF_DIR}/sentinel.yaml" <<EOF
client_id: "${CLIENT_ID}"

signing:
  algorithm: ed25519
  key_source: broker          # key is issued by the ingestion broker at enrollment (memory only)

telemetry:
  tls: true
  ca_cert: ${TLS_DIR}/ca.crt

oob_alert:
  url: ""
  method: POST
  timeout_seconds: 10
  retry_count: 3

watchdog:
  heartbeat_interval_seconds: 5
  alert_threshold_seconds: 15
  peer_socket: "/run/canary/sentinel-heartbeat.sock"
  ingestion_url: "${SERVER}/ingest"

log_integrity:
  chain_algorithm: sha256
  local_log: /var/lib/canary/local-chain.log

self_protection:
  monitor_own_pid: true
  monitor_signals: [SIGKILL, SIGSTOP, SIGTERM]
  alert_on_ptrace_attach: true
  alert_on_proc_modification: true
EOF
chmod 644 "${CONF_DIR}/sentinel.yaml"

# --- Audit rules + audispd plugin ---
echo "[*] Deploying Canary audit rules..."
mkdir -p /etc/audit/rules.d
cat > /etc/audit/rules.d/canary.rules <<EOF
-w ${INSTALL_DIR}/deployed -p wa -k canary_tamper
-w ${INSTALL_DIR}/sentinel -p wa -k sentinel_tamper
EOF

echo "[*] Registering Sentinel as audispd plugin..."
PLUGIN_DIR="/etc/audisp/plugins.d"
[ -d "$PLUGIN_DIR" ] || PLUGIN_DIR="/etc/audit/plugins.d"
mkdir -p "$PLUGIN_DIR"
cat > "${PLUGIN_DIR}/sentinel.conf" <<EOF
active = yes
direction = out
path = ${INSTALL_DIR}/sentinel
args = audit-consume
type = always
format = string
EOF
augenrules --load || true
service auditd restart || systemctl restart auditd || true

# --- systemd unit ---
echo "[*] Installing systemd unit..."
# Validate inputs that are interpolated into the unit file.
case "$PROFILE" in app-server|db-server|k8s-node) ;; *) echo "ERROR: unknown --profile '$PROFILE'." >&2; exit 2 ;; esac
case "$INTERVAL" in ''|*[!0-9]*) echo "ERROR: --interval must be seconds (integer)." >&2; exit 2 ;; esac
case "$JITTER" in ''|*[!0-9]*) echo "ERROR: --jitter must be seconds (integer)." >&2; exit 2 ;; esac
PROFILE_FILE="${INSTALL_DIR}/config/profiles/${PROFILE}.yaml"
[ -f "$PROFILE_FILE" ] || { echo "ERROR: profile file ${PROFILE_FILE} missing from assets." >&2; exit 1; }

# Decoy target directories from the profile. They must exist and be writable under
# ProtectSystem=full (which makes /etc read-only), so pre-create and whitelist them.
RW_PATHS="${INSTALL_DIR}"
while read -r d; do
  case "$d" in /*) mkdir -p "$d"; RW_PATHS="${RW_PATHS} ${d}" ;; esac
done < <(sed -n 's/^[[:space:]]*-[[:space:]]*path:[[:space:]]*\(\/[^[:space:]#]*\).*/\1/p' "$PROFILE_FILE")

cat > "$UNIT" <<EOF
[Unit]
Description=Canary Sentinel Daemon
After=network-online.target auditd.service
Wants=network-online.target

[Service]
EnvironmentFile=-/etc/canary/sentinel.env
ExecStartPre=/usr/bin/mkdir -p /run/canary
ExecStartPre=/usr/bin/chmod 700 /run/canary
ExecStart=${INSTALL_DIR}/sentinel -deployer-profile ${PROFILE} -deployer-config ${INSTALL_DIR}/config -deployer-templates /opt/sentinel/templates -deployer-interval ${INTERVAL} -deployer-max-jitter ${JITTER}
Restart=always
RestartSec=10
CapabilityBoundingSet=CAP_AUDIT_CONTROL CAP_NET_ADMIN CAP_AUDIT_WRITE CAP_AUDIT_READ
AmbientCapabilities=CAP_AUDIT_CONTROL CAP_NET_ADMIN CAP_AUDIT_WRITE CAP_AUDIT_READ
ProtectSystem=full
ReadWritePaths=${RW_PATHS}
StateDirectory=canary
PrivateTmp=true
NoNewPrivileges=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

# One-time join token: root-only env file, removed after enrollment succeeds.
if [ "$ALREADY_PROVISIONED" -eq 0 ]; then
  umask 077
  printf 'SENTINEL_JOIN_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  rm -f "$ENV_FILE"
fi

systemctl daemon-reload
systemctl enable sentinel.service
systemctl start sentinel.service

if [ "$ALREADY_PROVISIONED" -eq 0 ]; then
  echo "[*] Waiting for enrollment (up to 60s)..."
  for _ in $(seq 1 60); do
    [ -f "${STATE_DIR}/mtls.crt" ] && break
    sleep 1
  done
  if [ ! -f "${STATE_DIR}/mtls.crt" ]; then
    echo "ERROR: enrollment did not complete. The join token is single-use and expires in 15 minutes." >&2
    echo "       Inspect: journalctl -u sentinel.service -n 50 --no-pager" >&2
    echo "       Generate a fresh token in the UI before re-running." >&2
    rm -f "$ENV_FILE"; systemctl stop sentinel.service || true
    exit 1
  fi
  # Token is consumed; remove it so restarts use the renewal-token recovery path.
  rm -f "$ENV_FILE"
fi

echo "[ok] Sentinel installed and enrolled as ${CLIENT_ID}."
echo "     Status: systemctl status sentinel.service"
echo "     Logs:   journalctl -u sentinel.service -f"
