# 🚀 Deploying Cadoc Sentinel Dashboard to Google Cloud Run

This repository is hardened and verified for deployment to **Google Cloud Run**.

---

## 📋 Security-Hardened Deployment Artifacts

1. [Dockerfile](file:///Dockerfile):
   - Multi-stage build pinned to immutable `node:20.18.0-alpine3.20`.
   - Runs strictly as non-root user `nextjs:nodejs` (UID 1001).
   - Minimal attack surface via Next.js `standalone` mode (~120MB).
2. [next.config.ts](file:///next.config.ts):
   - Injects comprehensive security response headers:
     - `Content-Security-Policy` (CSP)
     - `Strict-Transport-Security` (HSTS)
     - `X-Frame-Options: DENY` (Anti-clickjacking)
     - `X-Content-Type-Options: nosniff` (Anti-MIME sniffing)
     - `Referrer-Policy: strict-origin-when-cross-origin`
     - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
3. [src/app/api/v1/[...path]/route.ts](file:///src/app/api/v1/[...path]/route.ts):
   - Gated reverse proxy: rejects unauthenticated requests with `401 Unauthorized` before reaching the backend.
   - Strips sensitive bearer tokens from URL query strings before proxying.
4. [.dockerignore](file:///dockerignore): Excludes `node_modules`, `.next`, `.git`, and test files from the build context.

---

## 🛠️ Method 1: Deploy with `gcloud` CLI (Recommended)

### Step 1: Login & Configure GCP Project
```bash
gcloud auth login
gcloud config set project YOUR_GCP_PROJECT_ID
```

### Step 2: (Optional Best Practice) Create a Dedicated Service Account
```bash
gcloud iam service-accounts create sentinel-dashboard-sa \
  --description="Unprivileged service account for Sentinel Dashboard on Cloud Run" \
  --display-name="Sentinel Dashboard SA"
```

### Step 3: Deploy to Cloud Run
Run the hardened deployment command from the project root:

```bash
gcloud run deploy sentinel-dashboard \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --concurrency 80 \
  --timeout 30s \
  --ingress internal-and-cloud-load-balancing \
  --service-account sentinel-dashboard-sa@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars NEXT_PUBLIC_API_URL="https://ec2-3-89-18-5.compute-1.amazonaws.com",ALLOW_SELF_SIGNED_CERTS="true"
```

> **Ingress & WAF Hardening Notice:**
> - When deploying behind an External HTTP(S) Application Load Balancer and Google Cloud Armor WAF, use `--ingress internal-and-cloud-load-balancing` so direct access to `*.run.app` URLs is blocked.
> - For standalone / sandbox testing without a Google Cloud Load Balancer, omit the `--ingress` flag (defaults to `all`).


> **Note on TLS & Self-Signed Certificates:**
> In staging/demo environments where the EC2 backend uses self-signed certificates, pass `ALLOW_SELF_SIGNED_CERTS="true"`.
> In production environments with a valid public CA certificate (Let's Encrypt / DigiCert), omit this flag to enforce strict TLS certificate validation.

---

## 🌐 Method 2: Deploy from Google Cloud Console

1. Push this repository to **GitHub** or **GitLab**.
2. Open the [Google Cloud Run Console](https://console.cloud.google.com/run).
3. Click **Create Service**.
4. Choose **Continuously deploy from a repository**.
5. Select your repository and branch (`main`).
6. Build configuration: Select **Dockerfile** (path: `Dockerfile`).
7. Under **Container, Networking, Security**:
   - **Container Port:** `8080`
   - **Memory:** `512 MiB` (or `1 GiB`)
   - **Maximum instances:** `10`
   - **Service account:** `sentinel-dashboard-sa` (or default if testing)
   - **Environment variables:**
     - `NEXT_PUBLIC_API_URL` = `https://ec2-3-89-18-5.compute-1.amazonaws.com`
     - `ALLOW_SELF_SIGNED_CERTS` = `true` (for staging self-signed EC2 backend)
8. Under **Authentication**: Select **Allow unauthenticated invocations**.
9. Click **Create**.

---

## 🔍 Post-Deployment Security Checks

After deploying, verify the live service using these curl checks:

```bash
# 1. Verify Security Headers (HSTS, CSP, Frame Options)
curl -sI https://your-cloud-run-url.a.run.app | grep -Ei 'strict-transport-security|content-security-policy|x-frame-options|x-content-type-options'

# 2. Verify Proxy Auth Gate (Protected endpoint should return 401 Unauthorized)
curl -s -o /dev/null -w "%{http_code}\n" https://your-cloud-run-url.a.run.app/api/v1/servers/
# Expected Output: 401
```
