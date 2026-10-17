package deployer_daemon

import (
	"sync/atomic"
	"time"
)

// busyUntil is the unix-nano deadline until which audit events are considered self-inflicted.
var busyUntil atomic.Int64

// MarkBusy extends the "deployer is touching canary files" window to at least now+d.
// The audit handler drops events during this window: the deployer's own create/delete/read of
// decoys is reported by auditd as partial records (no PID), so a PID filter alone can't catch it.
// ponytail: costs a few seconds of blind spot around each rotation; narrow it by matching the
// exact paths being written if that gap matters.
func MarkBusy(d time.Duration) {
	until := time.Now().Add(d).UnixNano()
	for {
		cur := busyUntil.Load()
		if cur >= until || busyUntil.CompareAndSwap(cur, until) {
			return
		}
	}
}

// Busy reports whether the deployer's file activity window is open.
func Busy() bool { return time.Now().UnixNano() < busyUntil.Load() }
