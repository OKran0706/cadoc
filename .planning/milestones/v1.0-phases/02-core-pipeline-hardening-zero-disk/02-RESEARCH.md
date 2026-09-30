# Phase 2: Core Pipeline Hardening (Zero-Disk) - Research

## Objective
Investigate how to enforce strict zero-disk boundaries for Sentinel binaries and Python Detection Engine pipelines.

## Findings

### 1. Key Fetching Architecture (`--join-token`)
Currently, `sysutil.UnwrapVaultToken` in `src/sentinel/internal/sysutil/sysutil.go` depends heavily on `os.Getenv("VAULT_WRAPPED_TOKEN")`. Both `sentinel-a` and `sentinel-b` currently load these from the environment directly at boot. 

**Implementation Path:**
- Add `joinToken := flag.String("join-token", "", "Initial Vault token for startup")` to `sentinel-a/main.go` and `sentinel-b/main.go`.
- Plumb `joinToken` into a refactored `sysutil.UnwrapVaultToken` or bypass unwrapping if the token is passed directly and inject it cleanly using `vaultClient.SetToken()`.

### 2. Kafka Client Configuration (`sysutil.go`)
Currently, `LoadTLSConfig` in `sysutil.go` contains a fallback allowing certificate loads from the local filesystem:
```go
if filePath != "" {
	return os.ReadFile(filePath) // Violates Zero-Disk Policy
}
```
**Implementation Path:**
- Entirely strip out the file footprint fallback logic within `getCertData()` inside `sysutil.go`. If `vaultLoc` string isn't provided, it must strictly error out to ensure operations fail closed when disk caching is dynamically requested. 

### 3. Detection Engine Connections (`engine.py`)
The Python `DetectionEngine` currently connects using plaintext bootstrapping:
```python
consumer = KafkaConsumer(
    self.topic,
    bootstrap_servers=self.kafka_brokers,
    ...
)
```
**Implementation Path:**
- Import `hvac`.
- During `.start()`, securely log into Vault using `os.environ.get("VAULT_TOKEN")` (via `hvac.Client(url=vault_addr, token=vault_token)`).
- Read the Kafka TLS Client Certificates and CA strings from the `secret/canary/kafka` paths directly into python strings.
- Pass them as temporary `ssl_context` elements (using the `ssl` module `SSLContext.load_verify_locations(cadata=...)` payload passing mechanism, preventing any physical `.pem` footprint on the workers).

## Validation Architecture
- We must enforce that testing pipeline executes without `CANARY_CLIENT_CERT_FILE` configs set, otherwise operations should violently drop cleanly.
