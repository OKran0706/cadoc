# Coding Conventions

## Framework & Language Layout
- **Go**: Strict separation between `cmd/` for CLI execution points and `internal/` for logic. Internal packages like `config` and `sysutil` restrict public access to sensitive data functions.
- **Python**: Used exclusively as modular helpers in testing/tooling, managed via requirements.txt and Docker containers.

## Configuration Standards
- Strong adherence to environment variables prefixed with `CANARY_` for system boundaries (`CANARY_KAFKA_BROKERS`, `CANARY_DB_CONN`).

## Security Protocols
- **Zero-Disk enforcement**: Code must strictly prevent writing of keys, TLS certificates, or sensitive Vault responses to file streams locally.
- **Fail-Closed Policy**: Handlers must terminate or sever operation aggressively on failure—no degraded runtime permissions are allowed.
