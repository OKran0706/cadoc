#!/bin/sh
set -e

# 1. Install dependencies
apk add --no-cache jq curl

export VAULT_TOKEN=root
export VAULT_ADDR=http://vault:8200

echo "Waiting for vault API..."
while ! vault status > /dev/null 2>&1; do sleep 1; done

# 2. Setup Policy
echo "Creating Sentinel-A policy..."
vault policy write sentinel-a - <<EOF
path "secret/data/canary/sentinel-a" { capabilities = ["read"] }
path "secret/data/canary/signer" { capabilities = ["read"] }
path "secret/data/canary/control" { capabilities = ["read"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
path "sys/capabilities-self" { capabilities = ["update"] }
EOF

# 3. Provision Secrets
echo "Writing generated certificates into Vault KV..."
vault kv put secret/canary/sentinel-a \
    ca_cert=@/certs/ca.crt \
    client_cert=@/certs/client.crt \
    client_key=@/certs/client.key

echo "Seeding VM test client credentials for brokered bootstrap..."
vault kv put secret/canary/sentinels/test-client \
    ca_cert=@/certs/ca.crt \
    client_cert=@/certs/client.crt \
    client_key=@/certs/client.key
vault kv put secret/canary/sentinels/sentinel-node-staging \
    ca_cert=@/certs/ca.crt \
    client_cert=@/certs/client.crt \
    client_key=@/certs/client.key

echo "Generating Identity test signing key..."
vault kv put secret/canary/signer \
    private_key=49514eaf037920150d18e38d7ae9ef278631ed6263ebcf189912be7c87c0fa0a

echo "Generating Authority test control key..."
vault kv put secret/canary/control \
    auth_pubkey=0123456789abcdef0123456789abcdef
vault kv put secret/canary/maintenance \
    pubkey=0123456789abcdef0123456789abcdef

# 4. Generate Wrapped Token
echo "Generating WRAPPED JOIN TOKEN for Sentinel-A..."
WRAPPED_TOKEN=$(vault token create -policy=sentinel-a -wrap-ttl=10m -format=json | jq -r .wrap_info.token)
echo "$WRAPPED_TOKEN" > /certs/sentinel-a.token
chmod 644 /certs/sentinel-a.token

echo "Vault initialization complete. Wrapped token stored at /certs/sentinel-a.token"
