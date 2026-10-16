# scripts/transfer-to-ec2.ps1
# Automates packaging and uploading Cadoc to an AWS EC2 instance using cadoc.pem

param (
    [Parameter(Mandatory=$true, Position=0)]
    [string]$Ec2Host,

    [Parameter(Mandatory=$false)]
    [string]$Ec2User = "ubuntu",

    [Parameter(Mandatory=$false)]
    [string]$KeyPath = "server-keys\cadoc.pem"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Cadoc EC2 Transfer Tool" -ForegroundColor Cyan
Write-Host " Target: $Ec2User@$Ec2Host" -ForegroundColor Cyan
Write-Host " Key:    $KeyPath" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

if (-not (Test-Path $KeyPath)) {
    Write-Error "Private key not found at $KeyPath. Please verify the key path."
    exit 1
}

# 1. Create deployment archive
$ArchiveName = "cadoc-ec2.tar.gz"
Write-Host "[+] Creating archive $ArchiveName..." -ForegroundColor Yellow

tar -czf $ArchiveName `
    --exclude="venv" `
    --exclude=".git" `
    --exclude="*.pyc" `
    --exclude="__pycache__" `
    --exclude="node_modules" `
    docker-compose.ec2.yml `
    .env.ec2.example `
    deploy `
    database `
    src

Write-Host "[+] Archive created successfully." -ForegroundColor Green

# 2. Upload archive to EC2
Write-Host "[+] Uploading $ArchiveName to EC2 ($Ec2Host)..." -ForegroundColor Yellow
scp -i $KeyPath -o StrictHostKeyChecking=no $ArchiveName "${Ec2User}@${Ec2Host}:~/"

Write-Host "[+] Extracting archive on remote host..." -ForegroundColor Yellow
ssh -i $KeyPath -o StrictHostKeyChecking=no "${Ec2User}@${Ec2Host}" "mkdir -p ~/cadoc && tar -xzf ~/$ArchiveName -C ~/cadoc && rm -f ~/$ArchiveName"

Write-Host "`nTransfer complete!" -ForegroundColor Green
Write-Host "------------------------------------------" -ForegroundColor Cyan
Write-Host "Now connect to your EC2 instance and run:" -ForegroundColor Yellow
Write-Host "  ssh -i $KeyPath ${Ec2User}@${Ec2Host}" -ForegroundColor White
Write-Host "  cd ~/cadoc" -ForegroundColor White
Write-Host "  sudo bash deploy/ec2-setup.sh" -ForegroundColor White
Write-Host "------------------------------------------" -ForegroundColor Cyan
