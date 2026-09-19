#!/bin/bash
# canary-system/scripts/preflight.sh
# Derived from: deployment/SKILL.md — Prerequisites Checklist

set -euo pipefail

PASS=0; FAIL=0

check() {
  local desc=$1; shift
  if "$@" &>/dev/null; then
    echo "✓ $desc"; ((PASS++))
  else
    echo "✗ $desc — FAILED"; ((FAIL++))
  fi
}

echo "=== Canary System Preflight Checks ==="

# Kernel
check "Kernel >= 5.8"          bash -c "[ $(uname -r | cut -d. -f1-2 | tr -d .) -ge 58 ]"
check "eBPF available"         test -d /sys/fs/bpf

# Tools
check "tetragon installed"     which tetragon
check "falco installed"        which falco
check "jq installed"           which jq
check "tpm2-tools installed"   which tpm2_getcap
check "kafkacat installed"     which kafkacat
check "python3 installed"      which python3

# Connectivity
check "Kafka reachable"        kafkacat -b "${CANARY_KAFKA_BROKERS:-kafka-0:9092}" -L -t canary-events
check "Remote log reachable"   curl -sf "${CANARY_REMOTE_LOG_ENDPOINT:-http://localhost:8080}/health"
check "Vault reachable"        vault status

# Kubernetes (skip if not K8s environment)
if command -v kubectl &>/dev/null; then
  check "K8s version >= 1.26"  bash -c "kubectl version --short 2>/dev/null | grep -q '1\.[2-9][6-9]'"
  check "VolumeSnapshot CRD"   kubectl get crd volumesnapshots.snapshot.storage.k8s.io
fi

echo ""
echo "Preflight: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
