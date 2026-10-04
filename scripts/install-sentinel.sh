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

# --- Argument Parsing ---
JOIN_TOKEN=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --join-token)
      JOIN_TOKEN="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# --- Install systemd unit ---
echo "[*] Installing systemd service unit..."
cp deploy/sentinel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable sentinel.service

# --- Bootstrap/Start ---
if [ -n "$JOIN_TOKEN" ]; then
  echo "[*] Bootstrapping Sentinel with join token..."
  # Use a transient override to pass the token for the first run only
  systemctl set-property sentinel.service Environment="SENTINEL_JOIN_TOKEN=$JOIN_TOKEN"
  systemctl start sentinel.service
  echo "[✓] Sentinel bootstrapped and started."
else
  echo "[!] No join token provided. Service enabled but NOT started."
  echo "    To start manually: sudo systemctl start sentinel"
fi

echo "[✓] Installation complete."
echo "    Status: systemctl status sentinel.service"
echo "    Logs:   journalctl -u sentinel.service -f"
