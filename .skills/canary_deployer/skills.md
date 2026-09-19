---
name: canary_deployer
description: Guidelines and instructions for working with the canary_deployer component
---

# Canary Deployer Component

## Overview
The `canary_deployer` component handles the deployment and lifecycle management of canary workloads across the infrastructure. It is written in Go.

## Structure
- `cmd/`: Entrypoints and CLIs for the application.
- `internal/`: Core business logic, separated from the entrypoint.
- `templates/`: Templates for generating necessary deployment resources.

## Build and Run
- Use standard Go toolchain: `go build` and `go run`.
- Use `go test ./...` to execute unit tests.

## Guidelines
- Follow the standard Go project layout.
- Use explicit error checking; minimize or completely avoid panics.
- Document exported functions and types.
