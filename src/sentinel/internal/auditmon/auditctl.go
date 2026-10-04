//go:build linux
// +build linux

package auditmon

import (
	"fmt"
	"log"
	"os/exec"
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

// CheckStatus returns the current auditd health status.
func (m *AuditctlManager) CheckStatus() (string, error) {
	cmd := exec.Command("auditctl", "-s")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
