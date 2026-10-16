#!/bin/bash
# transfer-to-azure.sh
# Automates the transfer of required Cadoc files to an Azure VM via SFTP.
# This version fixes the "path canonicalization failed" error by creating all folders first.

# --- CONFIGURATION ---
REMOTE_USER="azureuser"
REMOTE_HOST="20.204.88.117"
DEST_ROOT="/home/azureuser/cadoc"

echo "🚀 Preparing folder structure and starting transfer..."

# Build SFTP batch commands
{
    echo "mkdir $DEST_ROOT"
    echo "mkdir $DEST_ROOT/scripts"
    echo "mkdir $DEST_ROOT/deploy"
    echo "mkdir $DEST_ROOT/deploy/nginx"
    echo "mkdir $DEST_ROOT/database"
    echo "mkdir $DEST_ROOT/src"
    echo "mkdir $DEST_ROOT/src/platform_service"
    
    echo "cd $DEST_ROOT"
    echo "put docker-compose.azure-b1.yml"
    
    echo "cd $DEST_ROOT/scripts"
    echo "put scripts/deploy-azure.sh"
    echo "put scripts/deploy-b1.sh"
    
    echo "cd $DEST_ROOT/deploy/nginx"
    echo "put deploy/nginx/azure-b1.conf"
    
    echo "cd $DEST_ROOT/database"
    echo "put -r database/."
    
    echo "cd $DEST_ROOT/src/platform_service"
    echo "put -r src/platform_service/."
    
    echo "bye"
} | sftp "$REMOTE_USER@$REMOTE_HOST"

echo "✅ Transfer Complete with proper structure!"
echo "Next Step: SSH into your VM and run:"
echo "cd ~/cadoc && sudo bash scripts/deploy-b1.sh"
