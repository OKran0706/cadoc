#!/bin/bash
# test-env/setup-sentinel.sh
# Provisioning script for VM 2 (canary-sentinel, 192.168.56.12).
# Installs auditd, registers sentinel-a as a native audispd plugin,
# and sets up a hardened systemd service.
# NOTE: The sentinel.service is NOT started automatically — it awaits a
# brokered Join Token from the mTLS bootstrap sequence (verify-multinode.sh).

set -euo pipefail

echo "=== Provisioning canary-sentinel (VM 2) ==="

# 0. Non-interactive apt installs
export DEBIAN_FRONTEND=noninteractive

# 1. Install system dependencies
echo "--- Installing dependencies ---"
apt-get update -q
apt-get install -y auditd audispd-plugins curl jq net-tools ca-certificates

# 2. Disable default static audit rules to avoid conflicts
echo "--- Disabling default audit rules ---"
echo "-D" > /etc/audit/audit.rules
# Also clear rules file if it exists (Ubuntu 22.04+)
if [ -f /etc/audit/rules.d/audit.rules ]; then
    echo "-D" > /etc/audit/rules.d/audit.rules
fi

# 3. Create sentinel config directory
echo "--- Creating Sentinel config directory ---"
mkdir -p /opt/sentinel/config

# 4. Write sentinel.yaml — points watchdog to VM 1's NGINX LB (mTLS)
echo "--- Writing sentinel.yaml ---"
cat > /opt/sentinel/config/sentinel.yaml << 'EOF'
watchdog:
  ingestion_url: "https://192.168.56.11:8443/ingest"
signing:
  key_source: "brokered"
EOF
echo "✓ sentinel.yaml written pointing to https://192.168.56.11:8443/ingest"

# 5. Copy sentinel-a binary from synced folder
echo "--- Copying sentinel-a binary ---"
if [ -f /opt/sentinel/bin/sentinel-a ]; then
    cp /opt/sentinel/bin/sentinel-a /usr/local/bin/sentinel-a
    chmod +x /usr/local/bin/sentinel-a
    echo "✓ sentinel-a binary installed to /usr/local/bin/sentinel-a"
elif [ -f /vagrant/sentinel-a ]; then
    cp /vagrant/sentinel-a /usr/local/bin/sentinel-a
    chmod +x /usr/local/bin/sentinel-a
    echo "✓ sentinel-a binary installed from /vagrant/sentinel-a"
else
    echo "⚠ sentinel-a binary not found in /opt/sentinel/bin/ or /vagrant/"
    echo "  Build with: (cd src/sentinel && go build -o ../../bin/sentinel-a ./cmd/sentinel-a/)"
    echo "  Binary will be available via the synced folder on next vagrant provision"
    # Create placeholder so auditd plugin conf is still registered
    touch /usr/local/bin/sentinel-a-placeholder
fi

# 6. Register sentinel-a as an audispd plugin
echo "--- Registering audispd plugin ---"
# Determine plugin directory (Ubuntu 22.04 uses /etc/audit/plugins.d)
if [ -d /etc/audit/plugins.d ]; then
    PLUGIN_DIR=/etc/audit/plugins.d
elif [ -d /etc/audisp/plugins.d ]; then
    PLUGIN_DIR=/etc/audisp/plugins.d
else
    # Create it (newer auditd installations)
    mkdir -p /etc/audit/plugins.d
    PLUGIN_DIR=/etc/audit/plugins.d
fi

cat > "${PLUGIN_DIR}/sentinel.conf" << 'EOF'
active = yes
direction = out
path = /usr/local/bin/sentinel-a
args = audit-consume
type = builtin
format = string
EOF
echo "✓ audispd plugin registered at ${PLUGIN_DIR}/sentinel.conf"

# 7. Restart auditd to activate the plugin configuration
echo "--- Restarting auditd ---"
service auditd restart || systemctl restart auditd || true
echo "✓ auditd restarted"

# 8. Create hardened systemd service for sentinel-a
echo "--- Creating systemd sentinel.service ---"
cat > /etc/systemd/system/sentinel.service << 'EOF'
[Unit]
Description=Canary Sentinel-A Daemon
Documentation=https://github.com/canary/cadoc
After=network.target auditd.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/sentinel-a --config /opt/sentinel/config/sentinel.yaml
Restart=on-failure
RestartSec=5s
User=root

# Hardening
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
ReadWritePaths=/var/lib/canary /tmp

# Capabilities for network admin, resource control, and auditd interaction
CapabilityBoundingSet=CAP_NET_ADMIN CAP_SYS_RESOURCE CAP_AUDIT_CONTROL CAP_AUDIT_WRITE
AmbientCapabilities=CAP_NET_ADMIN CAP_SYS_RESOURCE CAP_AUDIT_CONTROL CAP_AUDIT_WRITE

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sentinel-a

[Install]
WantedBy=multi-user.target
EOF

# 9. Create secure state directory for mTLS credentials
mkdir -p /var/lib/canary
chmod 700 /var/lib/canary

# 10. Reload systemd (register new service unit)
systemctl daemon-reload
echo "✓ systemd sentinel.service registered"
echo "  NOTE: Service NOT started — awaits Join Token from bootstrap sequence"
echo "  Start with: systemctl start sentinel (after receiving Join Token)"

echo ""
echo "=== Sentinel provisioning complete ==="
echo "To bootstrap sentinel-a, run on the host:"
echo "  ./test-env/verify-multinode.sh"
