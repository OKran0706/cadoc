#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo " Cadoc Platform - EC2 (t4g.small) Setup"
echo "=========================================="

# 1. Swap space setup for t4g.small (2GB RAM)
if [ -f /proc/swaps ] && [ "$(wc -l < /proc/swaps)" -le 1 ]; then
    echo "[+] Configuring 2GB swap space for t4g.small stability..."
    if command -v fallocate >/dev/null 2>&1; then
        fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
    else
        dd if=/dev/zero of=/swapfile bs=1M count=2048
    fi
    chmod 600 /swapfile
    mkswap /swapfile 2>/dev/null || true
    swapon /swapfile 2>/dev/null || true
    if ! grep -q "/swapfile" /etc/fstab 2>/dev/null; then
        echo "/swapfile none swap sw 0 0" >> /etc/fstab 2>/dev/null || true
    fi
fi

# 2. Install Docker & Docker Compose if missing
if ! command -v docker >/dev/null 2>&1; then
    echo "[+] Installing Docker & Docker Compose..."
    apt-get update -y
    apt-get install -y docker.io docker-compose-v2
    systemctl start docker
    systemctl enable docker
fi

# 3. Ensure certs directory and PKI / SSL certificates exist
mkdir -p deploy/certs deploy/scripts
chmod +x deploy/scripts/vault-init.sh 2>/dev/null || true

# Public identity of this server (agents connect here on 443 only)
PUBLIC_HOST="${PUBLIC_HOST:-ec2-3-89-18-5.compute-1.amazonaws.com}"
PUBLIC_IP="${PUBLIC_IP:-3.89.18.5}"

# CA certificate for Canary PKI & mTLS (also signs the nginx server cert below)
if [ ! -f "deploy/certs/ca.crt" ] || [ ! -f "deploy/certs/ca.key" ]; then
    echo "[+] Generating Root CA certificate for Canary PKI & mTLS..."
    openssl req -new -x509 -days 3650 -nodes \
        -keyout deploy/certs/ca.key \
        -out deploy/certs/ca.crt \
        -subj "/CN=Canary CA/O=Cadoc" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign"
    chmod 600 deploy/certs/ca.key
    chmod 644 deploy/certs/ca.crt
fi

# Nginx server cert signed by the Canary CA with a SAN for the public host/IP.
# Agents trust only this CA (Vault issuing_ca), and Go requires a SAN match.
# Regenerated if missing, SAN-less (old self-signed cadoc.local), or host changed.
if [ ! -f "deploy/certs/selfsigned.crt" ] || [ ! -f "deploy/certs/selfsigned.key" ] \
   || ! openssl x509 -in deploy/certs/selfsigned.crt -noout -ext subjectAltName 2>/dev/null | grep -q "$PUBLIC_HOST"; then
    echo "[+] Generating CA-signed server certificate for ${PUBLIC_HOST} / ${PUBLIC_IP}..."
    openssl req -new -nodes -newkey rsa:2048 \
        -keyout deploy/certs/selfsigned.key \
        -out deploy/certs/server.csr \
        -subj "/O=Cadoc/CN=${PUBLIC_HOST}"
    printf 'subjectAltName=DNS:%s,IP:%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' \
        "$PUBLIC_HOST" "$PUBLIC_IP" > deploy/certs/server.ext
    openssl x509 -req -in deploy/certs/server.csr \
        -CA deploy/certs/ca.crt -CAkey deploy/certs/ca.key -CAcreateserial \
        -days 825 -extfile deploy/certs/server.ext \
        -out deploy/certs/selfsigned.crt
    rm -f deploy/certs/server.csr deploy/certs/server.ext
    chmod 600 deploy/certs/selfsigned.key
    chmod 644 deploy/certs/selfsigned.crt
fi

# Build the downloads dir nginx serves (installer + CA); binaries come from scripts/build-release.sh
mkdir -p deploy/downloads
cp -f deploy/certs/ca.crt deploy/downloads/ca.crt
[ -f scripts/install-sentinel.sh ] && cp -f scripts/install-sentinel.sh deploy/downloads/install-sentinel.sh

# 3. Check for .env file
if [ ! -f ".env" ]; then
    echo "[!] No .env file found. Creating from .env.ec2.example..."
    cp .env.ec2.example .env

    # Generate secure random secrets
    DB_PASS="$(openssl rand -hex 16)"
    JWT_SEC="$(openssl rand -hex 32)"
    BOOTSTRAP_SEC="$(openssl rand -hex 32)"
    VAULT_TOK="$(openssl rand -hex 16)"

    sed -i "s/generate_a_secure_db_password_here/${DB_PASS}/" .env
    sed -i "s/generate_a_secure_jwt_secret_here/${JWT_SEC}/" .env
    sed -i "s/generate_a_secure_bootstrap_secret_here/${BOOTSTRAP_SEC}/" .env
    sed -i "s/generate_a_secure_vault_token_here/${VAULT_TOK}/" .env
    echo "[+] Created new .env with secure database, JWT, and Vault credentials!"
fi

# Ensure PUBLIC_BASE_URL is set (used in the UI install command)
grep -q "^PUBLIC_BASE_URL=" .env || echo "PUBLIC_BASE_URL=https://${PUBLIC_HOST}" >> .env

# 4. Pull and build containers
echo "[+] Starting Cadoc services with docker compose..."
docker compose -f docker-compose.ec2.yml up -d --build

# Read generated/configured admin details from .env
ADMIN_EMAIL=$(grep '^INITIAL_ADMIN_EMAIL=' .env | cut -d '=' -f2- || echo "admin@cadoc.io")

echo "=========================================="
echo " Cadoc Platform deployed successfully!"
echo "------------------------------------------"
echo " Active Services:"
echo "  - Postgres:         127.0.0.1:5432"
echo "  - Redis:            127.0.0.1:6379"
echo "  - Redpanda:         127.0.0.1:9092"
echo "  - Vault (Dev):      127.0.0.1:8200"
echo "  - Platform UI/API:  https://${PUBLIC_HOST}/"
echo "  - Sentinel ingest:  https://${PUBLIC_HOST}/ingest (same port 443, mTLS by path)"
echo "  - Agent installer:  https://${PUBLIC_HOST}/install.sh"
echo "------------------------------------------"
echo " Initial Admin Login Credentials:"
echo " Email:    ${ADMIN_EMAIL}"
echo " Password: [Check .env file]"
echo "------------------------------------------"
echo " Check status: docker compose -f docker-compose.ec2.yml ps"
echo " View logs:    docker compose -f docker-compose.ec2.yml logs -f"
echo "=========================================="
