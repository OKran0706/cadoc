# 🚀 Cadoc Azure B1s Deployment Guide

This guide covers the deployment of the Cadoc Platform Service to an **Azure B1s Free Tier VM** (1 vCPU, 1 GB RAM). The stack is optimized for low memory usage and includes Nginx (HTTPS/Rate Limiting), Platform Service (FastAPI), Redis, and Postgres (Pre-seeded with Mock Data).

---

## 🏗️ Phase 1: Azure VM Preparation

1.  **Create VM**: Launch an **Ubuntu 22.04 LTS** instance on the **B1s** tier.
2.  **Network Security Group (NSG)**: Open the following Inbound Ports:
    *   `22` (SSH)i want to transfer thing
    *   `80` (HTTP - for redirect)
    *   `443` (HTTPS - primary access)

---

## 📦 Phase 2: Local Transfer (From your Machine)

1.  **Configure**: Open `scripts/transfer-to-azure.sh` (or `.ps1`) and update `REMOTE_HOST` with your VM IP.
2.  **Execute**:
    ```bash
    # Linux/macOS
    ./scripts/transfer-to-azure.sh

    # Windows (PowerShell)
    .\scripts\transfer-to-azure.ps1
    ```

---

## 🔐 Phase 3: Server Configuration (On Azure VM)

1.  **SSH into VM**:
    ```bash
    ssh azureuser@your-vm-ip
    ```

2.  **Fix Directory Structure**:
    Ensure files are in their correct locations for the scripts to work:
    ```bash
    cd ~/cadoc
    mkdir -p scripts deploy/nginx src
    mv deploy-b1.sh deploy-azure.sh scripts/ 2>/dev/null
    mv azure-b1.conf deploy/nginx/ 2>/dev/null
    mv platform_service src/ 2>/dev/null
    ```

3.  **Fix Windows Line Endings (IMPORTANT)**:
    If you transferred files from Windows, run this to prevent `$'\r': command not found` errors:
    ```bash
    sudo apt-get update && sudo apt-get install -y dos2unix
    dos2unix scripts/*.sh
    dos2unix docker-compose.azure-b1.yml
    ```

4.  **Create `.env` file**:
    Run this command inside `~/cadoc` to generate secure, random credentials:
    ```bash
    cat <<EOF > .env
    # Database
    POSTGRES_DB=canarydb
    POSTGRES_USER=canary_admin
    POSTGRES_PASSWORD=$(openssl rand -hex 16)

    # Admin Account
    INITIAL_ADMIN_EMAIL=admin@cadoc.io
    INITIAL_ADMIN_PASSWORD=Password123! # Change this!

    # App Secrets
    JWT_SECRET=$(openssl rand -hex 32)
    BOOTSTRAP_JWT_SECRET=$(openssl rand -hex 32)
    EOF
    ```

---

## 🚀 Phase 4: Launch Deployment

Run the automated deployment helper:
```bash
cd ~/cadoc
sudo bash scripts/deploy-b1.sh
```
**This script will:**
*   Create a **2GB Swap file** (Essential to prevent 1GB RAM crashes).
*   Install **Docker & Docker-Compose**.
*   Generate **Self-Signed SSL Certificates** for HTTPS.
*   Start the stack and **Seed the database** with official mock data.

---

## ✅ Phase 5: Verification & Access

1.  **Health Check**: Open `https://<your-vm-ip>/health`
    *   *Note: Accept the browser SSL warning (Advanced -> Proceed).*
2.  **Admin Login**: `https://<your-vm-ip>/`
    *   **User**: `admin@cadoc.io`
    *   **Password**: (The one you set in `.env`)
3.  **Monitor Logs**:
    ```bash
    sudo docker-compose -f docker-compose.azure-b1.yml logs -f
    ```

---

## 🛡️ Security Features Applied
*   **Nginx Shield**: Rate limiting (10 req/s) and connection limiting (10 per IP).
*   **HTTPS**: Encrypted traffic via self-signed SSL.
*   **Secrets Management**: No hardcoded passwords in Git; all secrets managed via `.env`.
*   **Memory Protection**: 2GB SSD swap prevents OOM (Out of Memory) kills.
