# Coding Conventions

## Language Standards
- **Go**: Follows standard Go project layout (`cmd/` for executables, `internal/` for private libraries). Uses Go modules (`go.mod` in `src/sentinel/`).
- **Python**: Modular layouts with `requirements.txt`.

## Configuration & Environment Variables
- Core components use the `CANARY_` prefix for standardizing environment variables:
  - `CANARY_KAFKA_BROKERS`
  - `CANARY_DB_CONN`
  - `CANARY_PAGERDUTY_KEY`
  - `CANARY_SLACK_WEBHOOK`

## Security Practices
- Strong requirement on **zero-disk architecture**.
- Code accessing sensitive keys/certs MUST fetch them dynamically via the internal `sysutil` package (which replaced legacy TPM/file-based paths).
- Components MUST adopt a "fail-closed" security posture.
