//go:build linux
// +build linux

package auditmon

import (
	"context"
	"fmt"
	"log"
	"time"
)

// SubsystemEvent represents a health event for the auditd subsystem.
type SubsystemEvent string

const (
	EventAuditdFailed    SubsystemEvent = "AUDITD_FAILED"
	EventAuditdRecovered SubsystemEvent = "AUDITD_RECOVERED"
	EventAuditdDegraded  SubsystemEvent = "AUDITD_DEGRADED"
)

// MonitorHealth periodically checks the auditd subsystem status.
// It triggers the callback when state changes or critical thresholds are hit.
func MonitorHealth(ctx context.Context, mgr *AuditctlManager, interval time.Duration, callback func(event SubsystemEvent, details map[string]interface{})) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	lastState := true // Assume healthy at start
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			status, err := mgr.CheckStatus()
			
			currentState := (err == nil && status.Enabled && status.Pid > 0)
			
			if currentState != lastState {
				if !currentState {
					callback(EventAuditdFailed, map[string]interface{}{
						"error": fmt.Sprintf("%v", err),
					})
				} else {
					callback(EventAuditdRecovered, nil)
				}
				lastState = currentState
			}

			// Check for degraded state (e.g. lost events)
			if status != nil && status.Lost > 0 {
				callback(EventAuditdDegraded, map[string]interface{}{
					"lost_events": status.Lost,
				})
			}
		}
	}
}
