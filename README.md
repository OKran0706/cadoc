# CADOC — Canary-Driven Operational Control

**Tripwires for your servers. Touch a decoy, get caught — with signed, tamper-proof evidence.**

Built for the BFSI track: *Intelligent Risk, Fraud & Financial Experiences*.

## The problem

Breaches at banks and insurers rarely start with a fraud model firing. They start with an attacker or rogue insider on a host quietly reading key files, KYC dumps and database backups. SIEMs bury that signal in thousands of low-confidence alerts, and a root-level attacker can edit the logs afterwards.

## The idea

CADOC plants **decoys** (fake SSH keys, config backups, DB dumps, credentials) on each server. No legitimate user or process ever touches them, so **any access is a high-confidence breach signal** with near-zero false positives.

## How it works

```
Linux auditd ─► Sentinel-A (Go) ─► Ingestion service ─► Platform API + Dashboard
 kernel events   reassemble records   verify Ed25519        multi-tenant, alerts,
                 sign each event      signature, store      forensics chat
                 drop privileges      liveness heartbeats
```

- **Sentinel-A** (`src/sentinel`): injects auditd rules live (nothing on disk to delete), reassembles fragmented kernel records into who/what/where/when events, signs them with Ed25519 and ships them over mTLS. It drops privileges after setup and raises a "self-harm" alert on unauthorised kill attempts.
- **Adaptive decoys** (`src/sentinel/internal/deployer`): a character n-gram language model trained on the target directory's own filenames generates decoy names that blend in. It runs on-box with no external model.
- **Ingestion + liveness** (`src/ingestion_service`): verifies signatures and tracks heartbeats, so a killed sentinel is itself an alert.
- **Detection engine** (`src/detection_engine`): Tier 1 fires instantly on canary hits. Tier 2 uses sliding windows for brute force and rapid exfiltration across hosts.
- **Platform service** (`src/platform_service`, FastAPI): multi-tenant projects, server fingerprinting, decoy lifecycle, dashboard API.
- **AI forensics chat**: ask "which programs touched decoys this week?" and an LLM drafts a SQL query. A `sqlglot` allow-list guard enforces single read-only `SELECT`s scoped to your project, and the model never touches the database.
- **Database canaries** (`src/db_canary`): fake schemas such as `_internal_audit` in PostgreSQL/MySQL, with an append-only alert table and automatic session revocation.
- **Response** (`src/alert_response`): Slack, PagerDuty, webhook, host quarantine, snapshot freeze, pod isolation.

## Why it matters for BFSI

- **Insider and APT detection** on core-banking, payment and SWIFT-adjacent hosts.
- **Non-repudiable evidence:** signed events and append-only alert tables support audit and regulatory reporting.
- **Cheap to deploy:** one static binary per host and no kernel modules.

## Run it

```bash
docker compose up -d                              # Kafka, Postgres, ingestion, detection engine
cd src/platform_service && pip install -r requirements.txt && uvicorn app.main:app --port 8000
# API docs: http://localhost:8000/docs
bash scripts/build-release.sh                     # build Sentinel-A (Go)
bash scripts/red-team-sim.sh                      # trigger decoy alerts end-to-end
```

Multi-node staging: `test-env/` (Vagrant, `generate-certs.ps1`). Production: see `DEPLOYMENT.md`, `DEPLOYMENT_AZURE.md` and `helm/`.

## Status

Server Sentinel, ingestion and platform API are deployed. Database canaries and automated response are implemented and in integration. See `BLUEPRINT.md` for architecture detail and roadmap (policy-driven canary placement, TPM 2.0 key storage).
