package deployer_daemon

import (
	"testing"
	"time"
)

func TestBusyWindow(t *testing.T) {
	busyUntil.Store(0)
	if Busy() {
		t.Fatal("should not be busy initially")
	}
	MarkBusy(200 * time.Millisecond)
	if !Busy() {
		t.Fatal("should be busy right after MarkBusy")
	}
	MarkBusy(10 * time.Millisecond) // a shorter mark must not shrink the window
	time.Sleep(50 * time.Millisecond)
	if !Busy() {
		t.Fatal("window must not shrink")
	}
	time.Sleep(250 * time.Millisecond)
	if Busy() {
		t.Fatal("window should have closed")
	}
}
