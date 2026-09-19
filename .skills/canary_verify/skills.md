---
name: canary_verify
description: Guidelines and instructions for working with the canary_verify component
---

# Canary Verify Component

## Overview
The `canary_verify` component (often running as `chain-verifier`) is built in Go. It consumes canary-related events from Kafka to verify end-to-end processing and correctness.

## Structure
- `main.go`: The primary execution entrypoint.

## Environment Variables
- `CANARY_KAFKA_BROKERS`: List of Kafka brokers used for consuming events.

## Build and Run
- Uses standard Go toolchain (`go build main.go`).
- Built within Docker using `Dockerfile.verifier`.

## Guidelines
- Ensure robust Kafka consumer group management.
- Handle offsets securely to avoid duplicate or missed event processing.
- Keep dependencies minimal to reduce the footprint.
