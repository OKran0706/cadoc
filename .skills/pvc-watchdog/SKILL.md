---
name: pvc-watchdog
description: "Use this skill for Kubernetes PVC and VolumeSnapshot monitoring. Covers: canary PVC provisioning, DaemonSet deployment, VolumeSnapshot allowlist enforcement, cross-node access detection, and eBPF-based volume read tracking. Assumes Kubernetes 1.26+ and Falco or Tetragon installed on nodes."
depends_on: sentinel-daemon/SKILL.md
---

# PVC / Storage Watchdog

## Overview

The PVC watchdog monitors Kubernetes persistent storage for unauthorized access. It operates at two levels:
1. **Kubernetes API level** — watches `VolumeSnapshot`, `PersistentVolumeClaim`, and `Pod` objects for policy violations.
2. **Node kernel level** — uses eBPF probes on each node to detect read/write access to canary files on mounted PVCs.

**Language: Go** — Kubernetes operator built with `sigs.k8s.io/controller-runtime`.

---

## Go Module

```
module github.com/your-org/canary/pvc-operator

go 1.26

require (
    sigs.k8s.io/controller-runtime                          v0.17.2
    k8s.io/client-go                                        v0.29.2
    k8s.io/api                                              v0.29.2
    k8s.io/apimachinery                                     v0.29.2
    github.com/kubernetes-csi/external-snapshotter/client/v6 v6.3.0
    gopkg.in/yaml.v3                                         v3.0.1
)
```

---

## Directory Layout

```
pvc-watchdog/
├── helm/
│   ├── Chart.yaml
│   ├── values.yaml
│   └── templates/
│       ├── daemonset.yaml          # Node-level eBPF watcher
│       ├── operator-deployment.yaml # K8s API-level watcher (Go binary)
│       ├── rbac.yaml
│       ├── canary-pvc.yaml         # Canary PVC definition
│       └── network-policy.yaml
├── config/
│   ├── snapshot-allowlist.yaml     # Approved service accounts for snapshots
│   ├── mount-baseline.yaml         # Known-good pod→PVC mount patterns
│   └── falco-rules-pvc.yaml
└── scripts/
    ├── bootstrap-canary-pvc.sh     # Seeds canary PVC with decoy files
    └── verify-watchdog.sh          # Health check script
```

---

## Canary PVC Provisioning

Create a dedicated canary PVC in each monitored namespace. No application pod should ever have a legitimate reason to mount it.

```yaml
# helm/templates/canary-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: canary-storage
  namespace: {{ .Values.namespace }}
  labels:
    canary-system/role: "decoy"
    canary-system/managed: "true"
  annotations:
    canary-system/description: "DO NOT MOUNT — automated monitoring asset"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: {{ .Values.storageClass }}
  resources:
    requests:
      storage: 1Gi  # Small — contains only decoy files
```

Seed the canary PVC with decoy files after provisioning:

```bash
# scripts/bootstrap-canary-pvc.sh
# Runs a one-shot Job that mounts the canary PVC and plants decoy files

kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: canary-pvc-seeder
  namespace: ${NAMESPACE}
spec:
  template:
    spec:
      serviceAccountName: canary-seeder  # minimal RBAC — only this PVC
      containers:
        - name: seeder
          image: canary-deployer:latest
          command: ["/opt/canary/bin/canary-deployer", "--profile", "k8s-pvc"]
          volumeMounts:
            - name: canary-vol
              mountPath: /canary-data
      volumes:
        - name: canary-vol
          persistentVolumeClaim:
            claimName: canary-storage
      restartPolicy: Never
EOF
```

---

## Kubernetes API Operator (Go / controller-runtime)

The operator watches the cluster API for policy-violating events. Deploy as a `Deployment` (not a DaemonSet) — one replica per cluster is sufficient. Leader election is enabled.

### RBAC

```yaml
# helm/templates/rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: canary-pvc-watchdog
rules:
  - apiGroups: ["snapshot.storage.k8s.io"]
    resources: ["volumesnapshots", "volumesnapshotcontents"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims", "pods", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create"]  # for emitting canary alert events into K8s event stream
```

### Operator Scaffolding (controller-runtime)

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	snapshotv1 "github.com/kubernetes-csi/external-snapshotter/client/v6/apis/volumesnapshot/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
)

var scheme = runtime.NewScheme()

func init() {
	utilruntime.Must(corev1.AddToScheme(scheme))
	utilruntime.Must(snapshotv1.AddToScheme(scheme))
}

func main() {
	var configPath string
	flag.StringVar(&configPath, "config", "/etc/canary/watchdog.yaml", "Path to config file")
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseDevMode(false)))
	log := ctrl.Log.WithName("pvc-operator")

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:           scheme,
		LeaderElection:   true,
		LeaderElectionID: "canary-pvc-watchdog-leader",
	})
	if err != nil {
		log.Error(err, "unable to start manager")
		os.Exit(1)
	}

	// Register reconcilers
	if err := (&VolumeSnapshotReconciler{
		Client: mgr.GetClient(),
		Config: loadConfig(configPath),
	}).SetupWithManager(mgr); err != nil {
		log.Error(err, "unable to create VolumeSnapshot controller")
		os.Exit(1)
	}

	if err := (&PodReconciler{
		Client: mgr.GetClient(),
		Config: loadConfig(configPath),
	}).SetupWithManager(mgr); err != nil {
		log.Error(err, "unable to create Pod controller")
		os.Exit(1)
	}

	log.Info("starting pvc-operator")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		log.Error(err, "manager exited with error")
		os.Exit(1)
	}
}
```

### VolumeSnapshot Reconciler

```go
package main

import (
	"context"
	"fmt"
	"time"

	snapshotv1 "github.com/kubernetes-csi/external-snapshotter/client/v6/apis/volumesnapshot/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type VolumeSnapshotReconciler struct {
	client.Client
	Config *WatchdogConfig
}

func (r *VolumeSnapshotReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := ctrl.LoggerFrom(ctx)

	var snap snapshotv1.VolumeSnapshot
	if err := r.Get(ctx, req.NamespacedName, &snap); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// 1. Check if snapshot source PVC is the canary PVC
	if snap.Spec.Source.PersistentVolumeClaimName != nil &&
		*snap.Spec.Source.PersistentVolumeClaimName == "canary-storage" {
		r.alert(ctx, AlertLevelCritical, "CANARY_PVC_SNAPSHOT",
			"VolumeSnapshot created from canary PVC",
			map[string]string{
				"snapshot":  snap.Name,
				"namespace": snap.Namespace,
			})
		return ctrl.Result{}, nil
	}

	// 2. Check if requesting service account is in the allowlist
	sa := snap.Annotations["serviceaccount"]
	if !r.isApprovedSnapshotter(sa, snap.Namespace) {
		r.alert(ctx, AlertLevelHigh, "UNAUTHORIZED_SNAPSHOT",
			"VolumeSnapshot by unapproved service account",
			map[string]string{"service_account": sa})
	}

	// 3. Check snapshot time window (reject outside maintenance windows)
	if !r.isMaintenanceWindow(time.Now()) {
		r.alert(ctx, AlertLevelMedium, "OFF_WINDOW_SNAPSHOT",
			"VolumeSnapshot created outside approved maintenance window", nil)
	}

	log.V(1).Info("reconciled VolumeSnapshot", "name", snap.Name)
	return ctrl.Result{}, nil
}

func (r *VolumeSnapshotReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&snapshotv1.VolumeSnapshot{}).
		Complete(r)
}

func (r *VolumeSnapshotReconciler) isApprovedSnapshotter(sa, ns string) bool {
	for _, entry := range r.Config.SnapshotAllowlist {
		if entry.ServiceAccount == sa && entry.Namespace == ns {
			return true
		}
	}
	return false
}

func (r *VolumeSnapshotReconciler) isMaintenanceWindow(t time.Time) bool {
	for _, entry := range r.Config.SnapshotAllowlist {
		for _, w := range entry.Windows {
			if w.Contains(t) {
				return true
			}
		}
	}
	return false
}

func (r *VolumeSnapshotReconciler) alert(ctx context.Context, level AlertLevel, alertType, msg string, details map[string]string) {
	log := ctrl.LoggerFrom(ctx)
	log.Info("ALERT", "level", level, "type", alertType, "message", msg, "details", details)
	// Also emit K8s Event and send to Kafka via sentinel
}
```

### Pod Reconciler

```go
package main

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type PodReconciler struct {
	client.Client
	Config *WatchdogConfig
}

func (r *PodReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var pod corev1.Pod
	if err := r.Get(ctx, req.NamespacedName, &pod); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	for _, vol := range pod.Spec.Volumes {
		if vol.PersistentVolumeClaim == nil {
			continue
		}
		pvcName := vol.PersistentVolumeClaim.ClaimName

		// Alert on any pod mounting the canary PVC
		if pvcName == "canary-storage" {
			r.alert(ctx, AlertLevelCritical, "CANARY_PVC_MOUNTED",
				"Pod mounted the canary PVC",
				map[string]string{"pod": pod.Name, "namespace": pod.Namespace})
		}

		// Alert on mount combinations not in the baseline
		baseline := r.Config.MountBaseline
		key := fmt.Sprintf("%s/%s", pod.Labels["app"], pvcName)
		if _, ok := baseline[key]; !ok {
			r.alert(ctx, AlertLevelMedium, "UNEXPECTED_PVC_MOUNT",
				"Pod mounted a PVC not in its historical baseline",
				map[string]string{"pod": pod.Name, "pvc": pvcName})
		}
	}
	return ctrl.Result{}, nil
}

func (r *PodReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1.Pod{}).
		Complete(r)
}

func (r *PodReconciler) alert(ctx context.Context, level AlertLevel, alertType, msg string, details map[string]string) {
	log := ctrl.LoggerFrom(ctx)
	log.Info("ALERT", "level", level, "type", alertType, "message", msg, "details", details)
}
```

---

## Kernel Layer Policy

This component does not write, compile, or load custom eBPF C programs. All kernel-level instrumentation is delegated to Tetragon (preferred) or Falco (fallback). These projects are:

- Maintained by dedicated security teams (Cilium, Falco community)
- Covered by bug bounty programs
- Subject to regular third-party security audits
- Verified against the kernel eBPF verifier on every release

**Our codebase contains zero lines of eBPF C. Our kernel attack surface is limited to the Tetragon/Falco versions we deploy.**

---

## Node-Level Monitoring (DaemonSet)

```yaml
# helm/templates/daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: canary-pvc-node-watcher
  namespace: canary-system
spec:
  selector:
    matchLabels:
      app: canary-pvc-node-watcher
  template:
    metadata:
      labels:
        app: canary-pvc-node-watcher
    spec:
      hostPID: true          # Required for process enrichment
      hostNetwork: true      # Required for out-of-band alert path
      serviceAccountName: canary-pvc-watchdog
      tolerations:
        - operator: Exists   # Run on all nodes including control plane
      containers:
        - name: watcher
          image: tetragon:latest
          securityContext:
            privileged: true
            capabilities:
              add: ["SYS_ADMIN", "BPF", "PERFMON"]
          volumeMounts:
            - name: sys
              mountPath: /sys
            - name: bpffs
              mountPath: /sys/fs/bpf
            - name: canary-config
              mountPath: /etc/canary
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
      volumes:
        - name: sys
          hostPath: { path: /sys }
        - name: bpffs
          hostPath: { path: /sys/fs/bpf, type: Directory }
        - name: canary-config
          configMap: { name: canary-pvc-config }
```

### Tetragon TracingPolicy for PVC Canary Detection

Deployed on every node to monitor filesystem reads of canary files on mounted PVCs. No custom kprobe C programs — Tetragon handles all kernel instrumentation:

```yaml
# /etc/tetragon/policies/canary-pvc-watch.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: canary-pvc-access
spec:
  kprobes:
    - call: "vfs_read"
      syscall: false
      args:
        - index: 0
          type: "file"    # captures file path as raw bytes
      # No selectors — all vfs_read events on kubelet volume paths
      # are captured to the ring buffer. Path matching against
      # canary-map.json happens in the Go userspace reader.
```

```bash
# Apply on each node (or via Helm chart ConfigMap)
tetra tracingpolicy apply /etc/tetragon/policies/canary-pvc-watch.yaml
```

The PVC operator's Go userspace reader filters raw `vfs_read` events against known canary PVC paths from `canary-map.json`. All path matching, exclusions, and bulk-read detection happen in Go — never in eBPF.

---

## VolumeSnapshot Allowlist

```yaml
# config/snapshot-allowlist.yaml
allowlist:
  - service_account: "velero"
    namespace: "velero"
    reason: "Backup system"
    windows:
      - cron: "0 2 * * *"  # Daily at 02:00 UTC
        duration_minutes: 120

  - service_account: "db-backup-operator"
    namespace: "database"
    reason: "Database backup operator"
    windows:
      - cron: "0 3 * * 0"  # Weekly Sunday 03:00 UTC
        duration_minutes: 180

# Any VolumeSnapshot not matching the above triggers an alert
```

---

## Mount Baseline

Maintain a learned baseline of which `app` labels mount which PVCs. The operator auto-learns this over 14 days on first deploy, then locks:

```yaml
# config/mount-baseline.yaml
# Auto-generated — do not edit manually
# Regenerate with: canary-watchdog baseline --regenerate --days 14

version: "2025-01-15"
locked: true
mounts:
  "api-server/postgres-data": { approved: true, first_seen: "2024-09-01" }
  "worker/uploads-vol": { approved: true, first_seen: "2024-09-01" }
  "migration-job/postgres-data": { approved: true, first_seen: "2024-10-15" }
```

---

## Network Policy (Canary Namespace Isolation)

```yaml
# helm/templates/network-policy.yaml
# Deny all traffic to/from the canary namespace except from the watchdog DaemonSet

apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: canary-namespace-isolation
  namespace: canary-system
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: canary-pvc-node-watcher
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: canary-sentinel
      ports:
        - port: 9443   # sentinel ingest port
```

---

## Health Check

```bash
# scripts/verify-watchdog.sh

echo "=== PVC Watchdog Health Check ==="

# 1. DaemonSet ready on all nodes
DESIRED=$(kubectl get ds -n canary-system canary-pvc-node-watcher -o jsonpath='{.status.desiredNumberScheduled}')
READY=$(kubectl get ds -n canary-system canary-pvc-node-watcher -o jsonpath='{.status.numberReady}')
[ "$DESIRED" == "$READY" ] && echo "✓ DaemonSet: $READY/$DESIRED ready" || echo "✗ DaemonSet: $READY/$DESIRED — investigate"

# 2. Operator running
kubectl get pod -n canary-system -l app=canary-pvc-operator --field-selector=status.phase=Running -q \
  && echo "✓ Operator pod running" || echo "✗ Operator pod not running"

# 3. Canary PVC exists and is bound
kubectl get pvc -n production canary-storage -o jsonpath='{.status.phase}' | grep -q Bound \
  && echo "✓ Canary PVC bound" || echo "✗ Canary PVC not bound"

# 4. Trigger test: mount canary PVC in a test pod and read a canary file
# Expected: alert fires within 10 seconds
kubectl run canary-test --image=busybox --rm -it \
  --overrides='{"spec":{"volumes":[{"name":"c","persistentVolumeClaim":{"claimName":"canary-storage"}}],"containers":[{"name":"canary-test","image":"busybox","command":["cat","/canary/pg_dump_prod.sql.gz"],"volumeMounts":[{"name":"c","mountPath":"/canary"}]}]}}' \
  -- cat /canary/pg_dump_prod.sql.gz
sleep 10
grep "CANARY_PVC_ACCESS" /var/log/canary/sentinel.log | tail -1 \
  && echo "✓ Canary PVC access alert fired" || echo "✗ No alert — check Falco/Tetragon rules"
```

---

## Dependencies

- Kubernetes 1.26+ (VolumeSnapshot GA)
- `snapshot.storage.k8s.io/v1` CRD installed
- Falco >= 0.36 OR Tetragon >= 0.11 on all nodes
- Helm 3.x (deployment)
- Go 1.26+ (build only — operator is a static binary)
- `sigs.k8s.io/controller-runtime` v0.17+ (K8s operator framework)
- `github.com/kubernetes-csi/external-snapshotter/client/v6` (VolumeSnapshot types)
- `k8s.io/client-go` (Kubernetes API client)
- `velero` or equivalent backup system must be listed in the allowlist before deployment
- Sentinel daemon running on all nodes

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| DaemonSet pods in `Pending` | Node taints blocking scheduling | Add tolerations matching node taints |
| VolumeSnapshot events not firing | Wrong API version installed | Verify `snapshot.storage.k8s.io/v1` CRD is present |
| Canary PVC in `Pending` state | StorageClass not found | Update `values.yaml` with correct `storageClass` |
| False positive on Velero backup | Velero not in allowlist | Add `velero` SA to `snapshot-allowlist.yaml` and reload |
