// canary-system/src/pvc_watchdog/cmd/operator/main.go
// PVC Watchdog Operator — watches VolumeSnapshot and Pod events for policy violations.
// Derived from: pvc-watchdog/SKILL.md

package main

import (
	"flag"
	"os"

	snapshotv1 "github.com/kubernetes-csi/external-snapshotter/client/v6/apis/volumesnapshot/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	"github.com/your-org/canary/pvc-operator/internal/config"
	"github.com/your-org/canary/pvc-operator/internal/controller"
)

var scheme = runtime.NewScheme()

func init() {
	utilruntime.Must(corev1.AddToScheme(scheme))
	utilruntime.Must(snapshotv1.AddToScheme(scheme))
}

func main() {
	configPath := flag.String("config", "/etc/canary/watchdog.yaml", "Path to config file")
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseDevMode(false)))
	log := ctrl.Log.WithName("pvc-operator")

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Error(err, "unable to load config")
		os.Exit(1)
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:           scheme,
		LeaderElection:   true,
		LeaderElectionID: "canary-pvc-watchdog-leader",
	})
	if err != nil {
		log.Error(err, "unable to start manager")
		os.Exit(1)
	}

	// Register VolumeSnapshot reconciler
	if err := (&controller.VolumeSnapshotReconciler{
		Client: mgr.GetClient(),
		Config: cfg,
	}).SetupWithManager(mgr); err != nil {
		log.Error(err, "unable to create VolumeSnapshot controller")
		os.Exit(1)
	}

	// Register Pod reconciler
	if err := (&controller.PodReconciler{
		Client: mgr.GetClient(),
		Config: cfg,
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
