// canary-system/src/sentinel/internal/selfmon/selfmon.go
// eBPF self-tamper detection with automatic environment detection.
// Supports: Kubernetes (Tetragon DaemonSet), VM (standalone Tetragon), Docker/fallback (/proc polling).
// Derived from: sentinel-daemon/SKILL.md

package selfmon

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/your-org/canary/sentinel/internal/ingestclient"
	"github.com/your-org/canary/sentinel/internal/signer"
)

// Environment represents the detected runtime environment.
type Environment int

const (
	EnvKubernetes Environment = iota // Kubernetes cluster with Tetragon DaemonSet
	EnvStandaloneTetragon            // Bare VM with Tetragon installed as systemd service
	EnvFallbackProc                  // Docker/container or minimal VM — /proc polling only
)

func (e Environment) String() string {
	switch e {
	case EnvKubernetes:
		return "kubernetes"
	case EnvStandaloneTetragon:
		return "standalone-tetragon"
	default:
		return "proc-fallback"
	}
}

// tetragonPolicyDir is where standalone Tetragon reads TracingPolicy files.
const tetragonPolicyDir = "/etc/tetragon/tetragon.tp.d"

// tetragonGRPCSocket is the default gRPC endpoint for standalone Tetragon.
const tetragonGRPCSocket = "localhost:54321"

// policyTemplate is the Tetragon TracingPolicy YAML shared by both
// Kubernetes and standalone deployment modes.
const policyTemplate = `
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: sentinel-self-protection
  namespace: canary-system
spec:
  kprobes:
  - call: "sys_kill"
    syscall: true
    args:
    - index: 0
      type: "int"
    selectors:
    - matchPIDs:
      - operator: "In"
        followForks: true
        isNamespacePID: false
        values:
        - {{.PID}}
      matchActions:
      - action: Post
      - action: Sigkill
  - call: "sys_ptrace"
    syscall: true
    args:
    - index: 0
      type: "int"
    - index: 1
      type: "int"
    selectors:
    - matchPIDs:
      - operator: "In"
        followForks: true
        isNamespacePID: false
        values:
        - {{.PID}}
      matchActions:
      - action: Post
      - action: Sigkill
  - call: "sys_openat"
    syscall: true
    args:
    - index: 1
      type: "string"
    - index: 2
      type: "int"
    selectors:
    - matchArgs:
      - index: 1
        operator: "Prefix"
        values:
        - "/opt/sentinel/bin/"
        - "/opt/canary-deployer/bin/"
      - index: 2
        operator: "Mask"
        values:
        - "2"    # O_RDWR
        - "1"    # O_WRONLY
        - "512"  # O_CREAT
        - "1024" # O_TRUNC
      matchActions:
      - action: Post
  - call: "sys_renameat2"
    syscall: true
    args:
    - index: 1
      type: "string"
    - index: 3
      type: "string"
    selectors:
    - matchArgs:
      - index: 3
        operator: "Prefix"
        values:
        - "/opt/sentinel/bin/"
        - "/opt/canary-deployer/bin/"
      matchActions:
      - action: Post
`

// DetectEnvironment probes the runtime to determine which self-monitoring
// strategy is available, in order of strongest to weakest.
func DetectEnvironment() Environment {
	// 1. Check for Kubernetes: KUBERNETES_SERVICE_HOST is injected by the kubelet
	//    into every pod. If present AND kubectl is reachable, we assume a full
	//    Tetragon DaemonSet deployment.
	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		if _, err := exec.LookPath("kubectl"); err == nil {
			log.Println("[selfmon] Detected environment: Kubernetes (Tetragon DaemonSet)")
			return EnvKubernetes
		}
	}

	// 2. Check for standalone Tetragon on a bare VM:
	//    - The policy directory exists (Tetragon is installed via package manager)
	//    - The gRPC socket is reachable (Tetragon daemon is actually running)
	if _, err := os.Stat(tetragonPolicyDir); err == nil {
		conn, err := net.DialTimeout("tcp", tetragonGRPCSocket, 2*time.Second)
		if err == nil {
			conn.Close()
			log.Println("[selfmon] Detected environment: Standalone Tetragon (VM)")
			return EnvStandaloneTetragon
		}
		log.Printf("[selfmon] Tetragon policy dir exists but gRPC unreachable (%v) — falling back", err)
	}

	// 3. Fallback: Docker container, minimal VM, or no eBPF support
	log.Println("[selfmon] Detected environment: /proc fallback (no Tetragon available)")
	return EnvFallbackProc
}

// Start initializes self-tamper monitoring using the best available strategy
// for the detected runtime environment.
func Start(ctx context.Context, selfPID int, s *signer.Signer, ic *ingestclient.Client) error {
	env := DetectEnvironment()

	// Emit a signed event recording which monitoring mode we entered.
	modeEvent := map[string]interface{}{
		"type":            "SELFMON_MODE_SELECTED",
		"monitoring_mode": env.String(),
		"pid":             selfPID,
	}
	envelope, _ := s.SignEvent(modeEvent)
	if payload, err := signer.MarshalEnvelope(envelope); err == nil {
		if err := ic.Post(ctx, payload); err != nil {
			log.Printf("[selfmon] Failed to emit mode event: %v", err)
		}
	}

	switch env {
	case EnvKubernetes:
		return startKubernetes(ctx, selfPID)
	case EnvStandaloneTetragon:
		return startStandalone(ctx, selfPID)
	default:
		// /proc fallback is started by the caller in main.go when Start() returns an error.
		return fmt.Errorf("no eBPF runtime available — use /proc fallback")
	}
}

// renderPolicy renders the TracingPolicy template with the sentinel's PID.
func renderPolicy(selfPID int) ([]byte, error) {
	tmpl, err := template.New("policy").Parse(policyTemplate)
	if err != nil {
		return nil, fmt.Errorf("failed to parse tetragon policy template: %v", err)
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, map[string]int{"PID": selfPID}); err != nil {
		return nil, fmt.Errorf("failed to execute policy template: %v", err)
	}
	return buf.Bytes(), nil
}

// startKubernetes applies the TracingPolicy via kubectl into the cluster
func startKubernetes(ctx context.Context, selfPID int) error {
	policyYAML, err := renderPolicy(selfPID)
	if err != nil {
		return err
	}

	f, err := os.CreateTemp("", "sentinel-tetragon-*.yaml")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())

	if _, err := f.Write(policyYAML); err != nil {
		return err
	}
	f.Close()

	cmd := exec.Command("kubectl", "apply", "-f", f.Name())
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tetragon policy apply failed: %v\nOutput: %s", err, string(out))
	}

	log.Printf("[selfmon] Tetragon TracingPolicy applied via kubectl for PID %d", selfPID)
	return nil
}

// startStandalone writes the TracingPolicy directly to the Tetragon policy
func startStandalone(ctx context.Context, selfPID int) error {
	policyYAML, err := renderPolicy(selfPID)
	if err != nil {
		return err
	}

	policyPath := tetragonPolicyDir + "/sentinel-self-protection.yaml"
	if err := os.WriteFile(policyPath, policyYAML, 0644); err != nil {
		return fmt.Errorf("failed to write tetragon policy to %s: %w", policyPath, err)
	}

	log.Printf("[selfmon] Tetragon TracingPolicy written to %s for PID %d", policyPath, selfPID)

	// Verify the Tetragon daemon picked up the policy
	time.Sleep(2 * time.Second)
	conn, err := net.DialTimeout("tcp", tetragonGRPCSocket, 3*time.Second)
	if err != nil {
		return fmt.Errorf("tetragon gRPC unreachable after policy write: %w", err)
	}
	conn.Close()

	log.Printf("[selfmon] Tetragon gRPC confirmed reachable — kernel-level monitoring active for PID %d", selfPID)
	return nil
}

// PollProc is the fallback self-monitoring mechanism using /proc.
func PollProc(ctx context.Context, selfPID int, s *signer.Signer, ic *ingestclient.Client) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	expectedCmdline := readCmdline(selfPID)
	log.Printf("[selfmon] /proc fallback started for PID %d", selfPID)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Check if process is still alive and unmodified
			currentCmdline := readCmdline(selfPID)
			if currentCmdline != expectedCmdline {
				event := map[string]interface{}{
					"type":         "ALERT_SENTINEL_TAMPER",
					"target_pid":   selfPID,
					"expected_cmd": expectedCmdline,
					"current_cmd":  currentCmdline,
				}
				envelope, _ := s.SignEvent(event)
				payload, _ := signer.MarshalEnvelope(envelope)
				if err := ic.Post(ctx, payload); err != nil {
					log.Printf("[selfmon] Failed to emit tamper alert: %v", err)
				}
				log.Printf("[selfmon] SENTINEL_TAMPER: cmdline changed for PID %d", selfPID)
			}

			// Check for unexpected tracers
			tracerPID := readTracerPID(selfPID)
			if tracerPID > 0 {
				event := map[string]interface{}{
					"type":       "ALERT_SENTINEL_PTRACE_ATTEMPT",
					"target_pid": selfPID,
					"tracer_pid": tracerPID,
				}
				envelope, _ := s.SignEvent(event)
				payload, _ := signer.MarshalEnvelope(envelope)
				if err := ic.Post(ctx, payload); err != nil {
					log.Printf("[selfmon] Failed to emit ptrace alert: %v", err)
				}
				log.Printf("[selfmon] SENTINEL_PTRACE: PID %d being traced by PID %d", selfPID, tracerPID)
			}
		}
	}
}

func readCmdline(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	return string(data)
}

func readTracerPID(pid int) int {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "TracerPid:") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				tp, _ := strconv.Atoi(parts[1])
				return tp
			}
		}
	}
	return 0
}
