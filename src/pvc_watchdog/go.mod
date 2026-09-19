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
