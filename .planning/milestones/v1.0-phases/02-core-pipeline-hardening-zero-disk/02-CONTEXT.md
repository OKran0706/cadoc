# Phase 2: Core Pipeline Hardening (Zero-Disk) - Context

**Gathered:** April 1, 2026
**Status:** Ready for planning

<domain>
## Phase Boundary
Enforce a strict zero-disk policy across the Sentinel binaries, Kafka integrations, and the Python Detection Engine. Validate that all cryptographic material resides only in dynamic memory.
</domain>

<decisions>
## Implementation Decisions

### 1. Key Fetching Architecture
- **Decision:** Sentinel will bootstrap by fetching keys via a command-line flag: `--join-token` rather than relying exclusively on persistent environment variables.
- **Implication:** The Sentinel binary will read the token via `os.Args` initially to connect to Vault, grab its long-lived credentials into memory, and proceed.

### 2. Kafka Go Client Configuration
- **Decision:** The Kafka TLS configuration will use entirely dynamic memory allocations.
- **Implication:** We will avoid file-loading wrappers (which expect disk files) and parse the certificates dynamically into an `x509.CertPool` directly from the raw Vault HTTP JSON responses using the Sentinel's `sysutil` package.

### 3. Detection Engine Connections
- **Decision:** Utilize `hvac` (HashiCorp Vault API Client) inside the Python layer.
- **Implication:** The Python detection engine will import credentials directly into memory arrays when initializing the event consumer loop, avoiding disk-based credential caching.
</decisions>

<canonical_refs>
## Canonical References
- `.planning/phases/01-secure-onboarding-api/01-CONTEXT.md` — Sentinel onboarding commands
- `.planning/codebase/CONVENTIONS.md` — Sentinel Zero-disk principles
- `.planning/codebase/ARCHITECTURE.md` — Upstream architecture paths
</canonical_refs>

<specifics>
## Specific Ideas
- Replace any file operations (`os.ReadFile` or `ioutil.ReadFile`) natively inside `src/sentinel` with raw `[]byte` payload parsing for all TLS certificates and connection strings!
</specifics>

<deferred>
## Deferred Ideas
- None.
</deferred>
