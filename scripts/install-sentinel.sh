#!/usr/bin/env bash
# install-sentinel.sh — Autonomous Sentinel deployment script.
# Drops the binary, installs the systemd unit, and enables the service.
# Intended to be wrapped by the onboarding API's deployment command.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

SENTINEL_BIN="${REPO_ROOT}/src/sentinel/sentinel"
SERVICE_SRC="${REPO_ROOT}/deploy/sentinel.service"
SERVICE_DEST="/etc/systemd/system/sentinel.service"
INSTALL_DIR="/opt/canary"

# --- Pre-flight checks ---
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root." >&2
  exit 1
fi

if [ ! -f "$SERVICE_SRC" ]; then
  echo "ERROR: Service unit file not found at $SERVICE_SRC" >&2
  exit 1
fi

# --- Install Auditd Dependencies ---
echo "[*] Installing Auditd dependencies..."
if command -v apt-get &> /dev/null; then
    apt-get update -y && apt-get install -y auditd audispd-plugins
elif command -v dnf &> /dev/null; then
    dnf install -y audit audispd-plugins
fi

# --- Install binary ---
echo "[*] Installing Sentinel binary to ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR"
if [ -f "$SENTINEL_BIN" ]; then
  cp "$SENTINEL_BIN" "${INSTALL_DIR}/sentinel"
  chmod 755 "${INSTALL_DIR}/sentinel"
else
  echo "WARN: Sentinel binary not found at ${SENTINEL_BIN}. Skipping binary copy."
  echo "      Ensure the binary is placed at ${INSTALL_DIR}/sentinel before starting."
fi

# --- Configure Canary Audit Rules ---
echo "[*] Deploying Canary Audit Rules..."
mkdir -p /etc/audit/rules.d
cat <<EOF > /etc/audit/rules.d/canary.rules
-w /opt/canary/deployed -p wa -k canary_tamper
-w ${INSTALL_DIR}/sentinel -p wa -k sentinel_tamper
EOF

# --- Register audispd plugin ---
echo "[*] Registering Sentinel as audispd plugin..."
PLUGIN_DIR="/etc/audisp/plugins.d"
if [ ! -d "$PLUGIN_DIR" ]; then PLUGIN_DIR="/etc/audit/plugins.d"; fi
mkdir -p "$(dirname "$PLUGIN_DIR")"

cat <<EOF > "$PLUGIN_DIR/sentinel.conf"
active = yes
direction = out
path = ${INSTALL_DIR}/sentinel
args = audit-consume
type = always
format = string
EOF

# Apply kernel rules and restart dispatcher
augenrules --load
service auditd restart

# --- Install systemd unit ---
echo "[*] Installing systemd service unit..."
cp deploy/sentinel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable sentinel.service

echo "[✓] Installation complete."
echo "    Note: Service is ENABLED but NOT started."
echo "    To bootstrap: sudo systemctl start sentinel (Ensure SENTINEL_JOIN_TOKEN is set)"
echo "    Status: systemctl status sentinel.service"
echo "    Logs:   journalctl -u sentinel.service -f"
