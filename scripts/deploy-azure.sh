#!/bin/bash
# ==============================================================================
# Cadoc - Azure B1s Free Tier VM Bootstrap & Deployment Script
# ==============================================================================
# This script automates the setup of a 100% free Azure B1s (1GB RAM) VM by:
# 1. Configuring a 2GB SSD swap file to prevent Out of Memory (OOM) crashes.
# 2. Installing Docker and Docker-Compose.
# 3. Setting up appropriate user groups and directory structures.
# ==============================================================================

set -e

# Harmonious Sleek Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0;35m' # Purple accent
CLEAR='\033[0m'

echo -e "${CYAN}==================================================================${CLEAR}"
echo -e "${NC}          🚀 CADOC TELEMETRY STACK - AZURE DEPLOYMENT BOOTSTRAP${CLEAR}"
echo -e "${CYAN}==================================================================${CLEAR}"

# 1. Verify Sudo privileges
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}❌ Please run this script with sudo privileges:${CLEAR}"
  echo -e "   sudo bash $0"
  exit 1
fi

# 2. Check and Configure Swap Space (Crucial for B1s 1GB RAM)
echo -e "\n${BLUE}[Step 1/4] Checking and configuring virtual swap memory...${CLEAR}"
if [ -f /swapfile ]; then
  echo -e "${GREEN}✓ Swap file already exists. Skipping allocation.${CLEAR}"
else
  echo -e "${CYAN}Allocating 2 GB SSD swap space...${CLEAR}"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  # Persist across VM restarts
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo -e "${GREEN}✓ 2 GB swap space successfully allocated and enabled!${CLEAR}"
fi
free -h

# 3. Update repositories and Install Docker & Docker-Compose V2
echo -e "\n${BLUE}[Step 2/4] Installing Docker and Docker-Compose V2...${CLEAR}"
apt-get update -y
apt-get install -y docker.io docker-compose-v2

# Start and enable Docker daemon
systemctl start docker
systemctl enable docker
echo -e "${GREEN}✓ Docker & Docker-Compose V2 successfully installed and active!${CLEAR}"

# 4. User Group Management
echo -e "\n${BLUE}[Step 3/4] Configuring user permissions...${CLEAR}"
# Get the non-root username who invoked sudo
REAL_USER=${SUDO_USER:-$USER}
if [ "$REAL_USER" != "root" ]; then
  usermod -aG docker "$REAL_USER"
  echo -e "${GREEN}✓ Added user '${REAL_USER}' to the docker group.${CLEAR}"
else
  echo -e "${CYAN}Note: Running as root user. Skipping user group config.${CLEAR}"
fi

# 5. Boot Complete
echo -e "\n${CYAN}==================================================================${CLEAR}"
echo -e "${GREEN}🎉 VM PREPARATION COMPLETELY SUCCESSFUL!${CLEAR}"
echo -e "${CYAN}==================================================================${CLEAR}"
echo -e "${NC}Next Steps to Launch Cadoc Stack:${CLEAR}"
echo -e " 1. Log out of the VM and SSH back in to apply Docker group permissions:"
echo -e "    ${CYAN}exit${CLEAR}"
echo -e " 2. Navigate to your Cadoc directory:"
echo -e "    ${CYAN}cd ~/cadoc${CLEAR} (or wherever you uploaded the codebase)"
echo -e " 3. Spin up the entire multi-node Telemetry stack in the background:"
echo -e "    ${CYAN}docker-compose up -d${CLEAR}"
echo -e "=================================================================="
