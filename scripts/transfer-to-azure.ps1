# transfer-to-azure.ps1
# Automates the transfer of required Cadoc files to an Azure VM via SFTP.
# This version fixes the "path canonicalization failed" error by creating all folders first.

# --- CONFIGURATION ---
$REMOTE_USER = "azureuser"
$REMOTE_HOST = "20.204.88.117"
$DEST_ROOT = "/home/azureuser/cadoc"

# --- PROMPT FOR PASSWORD ---
$CRED = Get-Credential -UserName $REMOTE_USER -Message "Enter password for Azure VM ($REMOTE_HOST)"

Write-Host "🚀 Preparing folder structure and starting transfer..." -ForegroundColor Cyan

# 1. Generate SFTP commands
# We create EVERY folder explicitly to avoid "path canonicalization" errors.
$SFTP_COMMANDS = @"
mkdir $DEST_ROOT
mkdir $DEST_ROOT/scripts
mkdir $DEST_ROOT/deploy
mkdir $DEST_ROOT/deploy/nginx
mkdir $DEST_ROOT/database
mkdir $DEST_ROOT/src
mkdir $DEST_ROOT/src/platform_service

# Root files
cd $DEST_ROOT
put docker-compose.azure-b1.yml

# Scripts
cd $DEST_ROOT/scripts
put scripts/deploy-azure.sh
put scripts/deploy-b1.sh

# Nginx Config
cd $DEST_ROOT/deploy/nginx
put deploy/nginx/azure-b1.conf

# Database Migrations (Recursive)
# We upload into the folder we just created
cd $DEST_ROOT/database
put -r database/.

# Platform Service Code (Recursive)
cd $DEST_ROOT/src/platform_service
put -r src/platform_service/.

bye
"@

# 2. Execute SFTP
Write-Host "Please enter the password for $REMOTE_USER when prompted by SFTP:" -ForegroundColor Yellow
$SFTP_COMMANDS | sftp "$REMOTE_USER@$REMOTE_HOST"

Write-Host "`n✅ Transfer Complete with proper structure!" -ForegroundColor Green
Write-Host "Next Step: SSH into your VM and run:" -ForegroundColor Yellow
Write-Host "cd ~/cadoc && sudo bash scripts/deploy-b1.sh" -ForegroundColor Cyan
