// canary-system/src/pvc_watchdog/internal/controller/snapshot.go
// VolumeSnapshot reconciler — detects unauthorized snapshots and allowlist violations.
// Derived from: pvc-watchdog/SKILL.md

package controller

import (
	"context"
	"fmt"
	"time"

	snapshotv1 "github.com/kubernetes-csi/external-snapshotter/client/v6/apis/volumesnapshot/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/your-org/canary/pvc-operator/internal/config"
)

// AlertLevel represents the severity of a canary alert.
type AlertLevel string

const (
	AlertLevelCritical AlertLevel = "CRITICAL"
	AlertLevelHigh     AlertLevel = "HIGH"
	AlertLevelMedium   AlertLevel = "MEDIUM"
)

// VolumeSnapshotReconciler watches VolumeSnapshot events for policy violations.
type VolumeSnapshotReconciler struct {
	client.Client
	Config *config.WatchdogConfig
}

// Reconcile checks a VolumeSnapshot against canary and allowlist policies.
func (r *VolumeSnapshotReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := ctrl.LoggerFrom(ctx)

	var snap snapshotv1.VolumeSnapshot
	if err := r.Get(ctx, req.NamespacedName, &snap); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// 1. Check if snapshot source is a canary PVC
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
			map[string]string{
				"service_account": sa,
				"namespace":       snap.Namespace,
				"snapshot":        snap.Name,
			})
	}

	// 3. Check snapshot time window
	if !r.isMaintenanceWindow(time.Now()) {
		r.alert(ctx, AlertLevelMedium, "OFF_WINDOW_SNAPSHOT",
			"VolumeSnapshot created outside approved maintenance window",
			map[string]string{
				"snapshot":  snap.Name,
				"namespace": snap.Namespace,
				"time":      time.Now().UTC().Format(time.RFC3339),
			})
	}

	log.V(1).Info("reconciled VolumeSnapshot", "name", snap.Name)
	return ctrl.Result{}, nil
}

// SetupWithManager registers this reconciler with the controller manager.
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
	// Check each allowlist entry for a matching window
	for _, entry := range r.Config.SnapshotAllowlist {
		for _, w := range entry.Windows {
			// Simple hour-based check (production would use cron parsing)
			if t.Hour() >= w.StartHour && t.Hour() < w.StartHour+w.DurationHours {
				return true
			}
		}
	}
	return false
}

func (r *VolumeSnapshotReconciler) alert(ctx context.Context, level AlertLevel, alertType, msg string, details map[string]string) {
	log := ctrl.LoggerFrom(ctx)
	log.Info("ALERT",
		"level", string(level),
		"type", alertType,
		"message", msg,
		"details", fmt.Sprintf("%v", details),
	)
	// In production: emit K8s Event and send to Kafka via sentinel
}
