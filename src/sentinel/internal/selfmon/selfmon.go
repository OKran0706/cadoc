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
	EnvAuditd       Environment = iota // VM with native Auditd support (audispd plugin)
	EnvFallbackProc                    // Docker/container or minimal VM — /proc polling only
)

func (e Environment) String() string {
	switch e {
	case EnvAuditd:
		return "auditd-native"
	default:
		return "proc-fallback"
	}
}

// DetectEnvironment probes the runtime to determine which self-monitoring
// strategy is available.
func DetectEnvironment() Environment {
	// 1. Check for native Auditd:
	//    The audit dispatcher directory exists (implies audispd is present)
	if _, err := os.Stat("/etc/audisp/plugins.d"); err == nil {
		log.Println("[selfmon] Detected environment: Native Auditd (audispd)")
		return EnvAuditd
	}

	// 2. Fallback: Docker container, minimal VM, or no eBPF support
	log.Println("[selfmon] Detected environment: /proc fallback (Auditd not available)")
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
	case EnvAuditd:
		log.Println("[selfmon] Native Auditd mode active — monitoring via audispd plugin")
		return nil // Server is started in main.go
	default:
		// /proc fallback is started by the caller in main.go when Start() returns an error.
		return fmt.Errorf("auditd runtime not available — use /proc fallback")
	}
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
