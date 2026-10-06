#!/bin/bash
set -euo pipefail

echo "=== Provisioning Sentinel VM ==="

# Install dependencies
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y auditd audispd-plugins curl jq

# Disable default auditd rules
echo "-D" > /etc/audit/audit.rules

# Create required directories for Sentinel
mkdir -p /opt/sentinel/config
mkdir -p /var/lib/canary
mkdir -p /run/canary

# Create dev config for testing without Vault
cat <<EOF > /opt/sentinel/config/sentinel.yaml
watchdog:
  ingestion_url: "http://192.168.56.1:8080/events"
signing:
  key_source: "local"
EOF


# We assume sentinel-a binary has been built and copied to /vagrant/ by the host
# since /vagrant is synced by default
if [ -f "/vagrant/sentinel-a" ]; then
    cp /vagrant/sentinel-a /usr/local/bin/sentinel-a
    chmod +x /usr/local/bin/sentinel-a
else
    echo "Warning: sentinel-a binary not found in /vagrant. You must build and copy it."
fi

# Register audispd plugin
echo "[*] Registering Sentinel as audispd plugin..."
PLUGIN_DIR="/etc/audisp/plugins.d"
if [ ! -d "$PLUGIN_DIR" ]; then PLUGIN_DIR="/etc/audit/plugins.d"; fi
mkdir -p "$PLUGIN_DIR"

cat <<EOF > "$PLUGIN_DIR/sentinel.conf"
active = yes
direction = out
path = /usr/local/bin/sentinel-a
args = audit-consume
type = builtin
format = string
EOF

# Restart auditd to pick up the new plugin
service auditd restart

# Setup systemd service for sentinel-a
cat <<EOF > /etc/systemd/system/sentinel.service
[Unit]
Description=Sentinel-A Daemon
After=network.target auditd.service

[Service]
Type=simple
Environment=SENTINEL_LOCAL_KEY=0000000000000000000000000000000000000000000000000000000000000001
ExecStart=/usr/local/bin/sentinel-a --config /opt/sentinel/config/sentinel.yaml -dev
Restart=always

# Hardening
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=CAP_NET_ADMIN CAP_SYS_RESOURCE CAP_AUDIT_CONTROL CAP_AUDIT_WRITE
AmbientCapabilities=CAP_NET_ADMIN CAP_SYS_RESOURCE CAP_AUDIT_CONTROL CAP_AUDIT_WRITE
NoNewPrivileges=yes
StateDirectory=canary
RuntimeDirectory=canary

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sentinel.service

echo "=== Provisioning Complete ==="
