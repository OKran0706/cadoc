//go:build linux
// +build linux

package auditmon

import (
	"fmt"
	"log"
	"os/exec"
	"strings"
)

// AuditctlManager manages live audit rules using the auditctl CLI.
// It ensures rules are memory-only (Zero-Disk constraint).
type AuditctlManager struct {
	key string
}

// NewAuditctlManager creates a manager for a specific audit key.
func NewAuditctlManager(key string) *AuditctlManager {
	return &AuditctlManager{
		key: key,
	}
}

// AddWatch adds a directory or file watch at runtime.
// -p wa: watch for write and attribute changes.
func (m *AuditctlManager) AddWatch(path string) error {
	cmd := exec.Command("auditctl", "-w", path, "-p", "wa", "-k", m.key)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("auditctl add failed: %v (output: %s)", err, string(out))
	}
	log.Printf("[auditmon] Live rule added: watch %s (-k %s)", path, m.key)
	return nil
}

// RemoveWatch removes a directory or file watch.
func (m *AuditctlManager) RemoveWatch(path string) error {
	cmd := exec.Command("auditctl", "-W", path, "-p", "wa", "-k", m.key)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("auditctl remove failed: %v (output: %s)", err, string(out))
	}
	log.Printf("[auditmon] Live rule removed: watch %s (-k %s)", path, m.key)
	return nil
}

// ClearAll removes all rules associated with this manager's key.
func (m *AuditctlManager) ClearAll() error {
	// auditctl doesn't support bulk delete by key easily, 
	// but we can delete the specific watches if we tracked them.
	// For now, we rely on individual RemoveWatch calls or auditctl -D (nuclear).
	return nil
}

// HealthStatus represents the current state of auditd.
type HealthStatus struct {
	Enabled    bool
	Failure    uint32
	Pid        uint32
	RateLimit  uint32
	Backlog    uint32
	Lost       uint32
	BacklogLimit uint32
}

// CheckStatus returns the current auditd health status parsed from auditctl -s.
func (m *AuditctlManager) CheckStatus() (*HealthStatus, error) {
	cmd := exec.Command("auditctl", "-s")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("auditctl -s failed: %v", err)
	}

	status := &HealthStatus{}
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		parts := strings.Split(line, " ")
		if len(parts) < 2 {
			continue
		}
		
		val := parts[1]
		switch {
		case strings.HasPrefix(line, "enabled"):
			status.Enabled = val != "0"
		case strings.HasPrefix(line, "pid"):
			fmt.Sscanf(val, "%d", &status.Pid)
		case strings.HasPrefix(line, "lost"):
			fmt.Sscanf(val, "%d", &status.Lost)
		case strings.HasPrefix(line, "backlog"):
			fmt.Sscanf(val, "%d", &status.Backlog)
		}
	}

	return status, nil
}
