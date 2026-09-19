// canary-system/src/pvc_watchdog/internal/controller/pod.go
// Pod reconciler — detects unauthorized PVC mounts and baseline deviations.
// Derived from: pvc-watchdog/SKILL.md

package controller

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	corev1 "k8s.io/api/core/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/your-org/canary/pvc-operator/internal/config"
)

// PodReconciler watches Pod events for unauthorized PVC mounts.
type PodReconciler struct {
	client.Client
	Config *config.WatchdogConfig
}

// Reconcile checks a Pod's volume mounts against canary and baseline policies.
func (r *PodReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := ctrl.LoggerFrom(ctx)

	var pod corev1.Pod
	if err := r.Get(ctx, req.NamespacedName, &pod); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Skip pods that haven't been scheduled yet
	if pod.Spec.NodeName == "" {
		return ctrl.Result{}, nil
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
				map[string]string{
					"pod":       pod.Name,
					"namespace": pod.Namespace,
					"node":      pod.Spec.NodeName,
				})
		}

		// Alert on mount combinations not in the baseline
		appLabel := pod.Labels["app"]
		if appLabel == "" {
			appLabel = pod.Labels["app.kubernetes.io/name"]
		}
		baselineKey := fmt.Sprintf("%s/%s", appLabel, pvcName)

		if _, ok := r.Config.MountBaseline[baselineKey]; !ok && r.Config.BaselineLocked {
			r.alert(ctx, AlertLevelMedium, "UNEXPECTED_PVC_MOUNT",
				"Pod mounted a PVC not in its historical baseline",
				map[string]string{
					"pod":       pod.Name,
					"pvc":       pvcName,
					"namespace": pod.Namespace,
					"app_label": appLabel,
				})
		}
	}

	log.V(1).Info("reconciled Pod", "name", pod.Name)
	return ctrl.Result{}, nil
}

// SetupWithManager registers this reconciler with the controller manager.
func (r *PodReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := r.deployTetragonPolicy(); err != nil {
		return fmt.Errorf("deploy tetragon policy: %w", err)
	}

	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1.Pod{}).
		Complete(r)
}

func (r *PodReconciler) deployTetragonPolicy() error {
	const tmpl = `
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: pvc-watchdog-reads
  namespace: canary-system
spec:
  kprobes:
  - call: "vfs_read"
    syscall: false
    args:
    - index: 0
      type: "file"
    - index: 1
      type: "char_buf"
    - index: 2
      type: "size_t"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Prefix"
        values:
        - "/var/lib/kubelet/pods/"
      matchActions:
      - action: Post
`

	f, err := os.CreateTemp("", "pvc-tetragon-*.yaml")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())

	if _, err := f.Write([]byte(tmpl)); err != nil {
		return err
	}
	f.Close()

	cmd := exec.Command("kubectl", "apply", "-f", f.Name())
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("kubectl apply failed: %v\nOutput: %s", err, string(out))
	}
	return nil
}

func (r *PodReconciler) alert(ctx context.Context, level AlertLevel, alertType, msg string, details map[string]string) {
	log := ctrl.LoggerFrom(ctx)
	log.Info("ALERT",
		"level", string(level),
		"type", alertType,
		"message", msg,
		"details", fmt.Sprintf("%v", details),
	)
}
