---
name: pvc_watchdog
description: Guidelines and instructions for working with the pvc_watchdog component
---

# PVC Watchdog Component

## Overview
The `pvc_watchdog` component (typically packaged as `pvc-operator`) monitors Persistent Volume Claims (PVC) within a Kubernetes cluster to detect anomalies or capacity thresholds. It is built in Go.

## Structure
- `cmd/`: CLI, application commands, and entrypoints.
- `internal/`: Core watchdog logic, API watchers, and Kubernetes client code.

## Build and Run
- Uses standard Go toolchain (`go build`).
- Build natively into a container using `Dockerfile.pvc-operator`.

## Guidelines
- Utilize the official `client-go` library for all internal Kubernetes API interactions.
- Cache Kubernetes resources utilizing informers to help minimize load on the K8s API server.
- Ensure contexts are used properly for graceful shutdown without leaking watchers or go-routines.
