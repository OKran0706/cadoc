#!/bin/bash
# test-env/setup-server.sh
# Provisioning script for VM 1 (canary-server, 192.168.56.11).
# Installs Docker + Docker Compose and launches the central telemetry
# control plane (Vault, Kafka, Redis, Ingestion Service, NGINX LB).

set -euo pipefail

echo "=== Provisioning canary-server (VM 1) ==="

# 0. Non-interactive apt installs
export DEBIAN_FRONTEND=noninteractive

# 1. Install system dependencies
echo "--- Installing dependencies ---"
apt-get update -q
apt-get install -y docker.io docker-compose curl jq net-tools ca-certificates

# 2. Enable Docker on boot and start daemon
echo "--- Enabling Docker ---"
systemctl enable docker
systemctl start docker

# Ensure the vagrant user can run docker (if exists)
if id "vagrant" &>/dev/null; then
    usermod -aG docker vagrant
fi

# 3. Verify Docker Compose is available
docker-compose --version || {
    echo "docker-compose not found — installing via pip fallback"
    apt-get install -y python3-pip
    pip3 install docker-compose
}

# 4. Wait for Docker to fully start
sleep 3

# 5. Launch the multi-node compose stack from the synced /vagrant directory
echo "--- Launching docker-compose-multinode.yml stack ---"
if [ -f /vagrant/docker-compose-multinode.yml ]; then
    cd /vagrant
    docker-compose -f docker-compose-multinode.yml up -d
    echo "✓ Docker Compose stack started"
else
    echo "⚠ docker-compose-multinode.yml not found in /vagrant — skipping stack launch"
    echo "  Ensure the synced folder is mounted and re-provision with: vagrant provision server"
fi

echo ""
echo "=== Server provisioning complete ==="
echo "Services running on:"
echo "  - Vault:             http://192.168.56.11:8200"
echo "  - Ingestion Service: http://192.168.56.11:8000"
echo "  - NGINX LB (mTLS):   https://192.168.56.11:8443"
echo "  - Kafka:             192.168.56.11:9092"
echo "  - Redis:             192.168.56.11:6379"
