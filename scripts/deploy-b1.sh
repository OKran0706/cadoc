#!/bin/bash
# ==============================================================================
# Cadoc - Azure B1s Free Tier Deployment Helper
# ==============================================================================

set -e

echo "🚀 Preparing Cadoc Stack for Azure B1s (Free Tier)..."

# 1. Run the bootstrap script to setup Swap and Docker
echo "Step 1: Running Azure bootstrap script..."
sudo bash scripts/deploy-azure.sh

# 2. Generate Self-Signed SSL Certificates
echo "Step 2: Generating Self-Signed SSL Certificates..."
mkdir -p deploy/certs
if [ ! -f deploy/certs/selfsigned.crt ]; then
    sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout deploy/certs/selfsigned.key \
      -out deploy/certs/selfsigned.crt \
      -subj "/C=US/ST=State/L=City/O=Cadoc/CN=$(curl -s ifconfig.me)"
    echo "âœ… SSL Certificates generated."
else
    echo "âœ“ SSL Certificates already exist. Skipping."
fi

# 3. Inform user about the stack
echo ""
echo "Step 3: Starting the lightweight stack (Nginx, Platform Service, Redis, Postgres)..." 

echo "Note: This stack is optimized for 1GB RAM by excluding Kafka/Zookeeper."
echo "The database will be automatically seeded with MOCK DATA from setup.sql and migrations."

# 3. Launch Docker Compose
docker compose -f docker-compose.azure-b1.yml up -d

echo ""
echo "✅ DEPLOYMENT STARTED!"
echo "------------------------------------------------------------------"
echo "Public API: http://$(curl -s ifconfig.me)"
echo "Health Check: http://$(curl -s ifconfig.me)/health"
echo "Admin Login: admin@cadoc.io / Password123!"
echo "------------------------------------------------------------------"
echo "Mock Data Details:"
echo "- Database: canarydb"
echo "- Schemas seeded: _internal_audit, _financial_archive, _system_config"
echo "- Check logs: docker-compose -f docker-compose.azure-b1.yml logs -f"
echo "------------------------------------------------------------------"
