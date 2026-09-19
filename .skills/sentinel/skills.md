---
name: sentinel
description: Guidelines and instructions for working with the sentinel component
---

# Sentinel Component

## Overview
The `sentinel` component operates as a primary monitor, focusing on core node or cluster-level security checks and data gathering tasks. It is written in Go.

## Structure
- `cmd/`: Primary entrypoints and application executables.
- `internal/`: Internal business logic encapsulating the periodic checks.

## Build and Run
- Built and tested with the standard Go CLI (`go build`, `go test`).
- Uses `Dockerfile.sentinel` for container packaging.

## Guidelines
- Keep checks running asynchronously to avoid single points of latency.
- Provide the component with the minimum RBAC privilege required to run checks.
- Treat crashes securely, logging issues, and deferring recovery logic wherever possible.
