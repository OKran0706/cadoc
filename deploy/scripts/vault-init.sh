#!/bin/sh
set -e

echo "=========================================="
echo " Cadoc Vault Initialization & PKI Setup"
echo "=========================================="

export VAULT_ADDR="${VAULT_ADDR:-http://vault:8200}"
export VAULT_TOKEN="${VAULT_TOKEN:-cadoc_vault_dev_root_token}"

echo "[+] Waiting for Vault at ${VAULT_ADDR} to be ready..."
RETRIES=30
until vault status > /dev/null 2>&1 || [ $RETRIES -eq 0 ]; do
    echo "  - Vault status code: $?. Retrying in 2s ($RETRIES attempts left)..."
    sleep 2
    RETRIES=$((RETRIES - 1))
done

if [ $RETRIES -eq 0 ]; then
    echo "[!] Error: Vault did not become ready in time."
    exit 1
fi
echo "[+] Vault is unsealed and responsive."

# 1. Enable and configure KV v2 engine
echo "[+] Ensuring KV v2 secrets engine is mounted at secret/..."
vault secrets enable -path=secret kv-v2 2>/dev/null || true

# 2. Setup Vault Access Policies
echo "[+] Writing Sentinel & Ingestion policies..."

# Sentinel-A policy
vault policy write sentinel-a - << 'EOF'
path "secret/data/canary/*" { capabilities = ["read"] }
path "secret/data/canary/sentinel-a" { capabilities = ["read"] }
path "secret/data/canary/signer" { capabilities = ["read"] }
path "secret/data/canary/control" { capabilities = ["read"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
path "sys/capabilities-self" { capabilities = ["update"] }
path "sys/wrapping/unwrap" { capabilities = ["update"] }
EOF

# General Sentinel policy (legacy single-node fallback)
vault policy write sentinel-policy - << 'EOF'
path "secret/data/canary/*" { capabilities = ["read"] }
path "sys/wrapping/unwrap" { capabilities = ["update"] }
EOF

# Multi-Tenant Scoped Sentinel Policy (Path Templating)
# Prevents Sentinel A from reading Sentinel B or another tenant's keys
vault policy write canary-tenant-sentinel - << 'EOF'
path "secret/data/canary/tenants/{{identity.entity.metadata.company_slug}}/sentinels/{{identity.entity.metadata.sentinel_id}}/*" {
  capabilities = ["read"]
}
path "secret/data/canary/tenants/{{identity.entity.metadata.company_slug}}/shared/*" {
  capabilities = ["read"]
}
path "auth/token/lookup-self" { capabilities = ["read"] }
path "sys/capabilities-self" { capabilities = ["update"] }
path "sys/wrapping/unwrap" { capabilities = ["update"] }
EOF

# Ingestion Service policy
vault policy write ingestion-service - << 'EOF'
path "secret/data/canary/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "pki/issue/sentinel-agent" { capabilities = ["create", "update"] }
path "pki/certs" { capabilities = ["list"] }
path "pki/revoke" { capabilities = ["create", "update"] }
EOF

# 3. Setup PKI Engine
echo "[+] Configuring Vault PKI engine..."
vault secrets enable pki 2>/dev/null || true
vault secrets tune -max-lease-ttl=87600h pki || true

# If CA certificates exist in /certs, import them; otherwise generate root CA
if [ -f "/certs/ca.key" ] && [ -f "/certs/ca.crt" ]; then
    echo "[+] Importing existing CA certificate bundle from /certs..."
    cat /certs/ca.key /certs/ca.crt > /tmp/ca-bundle.pem
    vault write pki/config/ca pem_bundle=@/tmp/ca-bundle.pem || true
    rm -f /tmp/ca-bundle.pem
else
    echo "[+] Generating internal Root CA in Vault PKI..."
    vault write pki/root/generate/internal common_name="Cadoc Canary Root CA" ttl=87600h || true
fi

echo "[+] Setting PKI URLs..."
vault write pki/config/urls \
    issuing_certificates="${VAULT_ADDR}/v1/pki/ca" \
    crl_distribution_points="${VAULT_ADDR}/v1/pki/crl" || true

echo "[+] Creating Sentinel-Agent PKI role..."
vault write pki/roles/sentinel-agent \
    allowed_domains="canary.local" \
    allow_subdomains=true \
    max_ttl="720h" \
    generate_lease=true || true

# 4. Provision Initial Secrets
echo "[+] Seeding initial canary secrets in Vault KV..."

# Ed25519 telemetry signing key (64 hex characters)
vault kv put secret/canary/signer \
    private_key=49514eaf037920150d18e38d7ae9ef278631ed6263ebcf189912be7c87c0fa0a || true

# Authority control & maintenance verification keys
vault kv put secret/canary/control \
    auth_pubkey=0123456789abcdef0123456789abcdef || true

vault kv put secret/canary/maintenance \
    pubkey=0123456789abcdef0123456789abcdef \
    ed25519_pubkey=0123456789abcdef0123456789abcdef || true

# Optional seeded Sentinel credentials if certs exist
if [ -f "/certs/ca.crt" ] && [ -f "/certs/client.crt" ] && [ -f "/certs/client.key" ]; then
    echo "[+] Seeding initial client certs into Vault KV..."
    vault kv put secret/canary/sentinel-a \
        ca_cert=@/certs/ca.crt \
        client_cert=@/certs/client.crt \
        client_key=@/certs/client.key || true
    vault kv put secret/canary/sentinels/test-client \
        ca_cert=@/certs/ca.crt \
        client_cert=@/certs/client.crt \
        client_key=@/certs/client.key || true
fi

echo "=========================================="
echo " Vault initialization & PKI setup complete!"
echo "=========================================="
