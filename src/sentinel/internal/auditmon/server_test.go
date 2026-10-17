//go:build linux

package auditmon

import (
	"context"
	"net"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestDeleteArgs(t *testing.T) {
	cases := map[string][]string{
		"-w /etc/app -p rwa -k sys-integrity":                  {"-W", "/etc/app", "-p", "rwa", "-k", "sys-integrity"},
		"-a always,exit -F arch=b64 -S openat -k sys-integrity": {"-d", "-a", "always,exit", "-F", "arch=b64", "-S", "openat", "-k", "sys-integrity"},
	}
	for line, want := range cases {
		if got := deleteArgs(line); !reflect.DeepEqual(got, want) {
			t.Errorf("deleteArgs(%q) = %v, want %v", line, got, want)
		}
	}
}

func TestDisconnectedWorkerIsForgottenAndIdleWorkerKept(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "audit.sock")
	srv := NewServer()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.Start(ctx, sock, func(*AuditEvent) {})

	var idle, gone net.Conn
	var err error
	for i := 0; i < 50; i++ { // wait for the listener
		if idle, err = net.Dial("unix", sock); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()
	if gone, err = net.Dial("unix", sock); err != nil {
		t.Fatal(err)
	}
	gone.Close()

	count := func() int { srv.workersMu.Lock(); defer srv.workersMu.Unlock(); return len(srv.workers) }
	deadline := time.Now().Add(2 * time.Second)
	for count() != 1 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := count(); n != 1 {
		t.Fatalf("workers = %d, want 1 (the disconnected one must be removed, the idle one kept)", n)
	}
}
