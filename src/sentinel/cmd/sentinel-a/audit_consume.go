//go:build linux
// +build linux

package main

import (
	"bufio"
	"fmt"
	"log"
	"net"
	"os"
	"time"

	"github.com/elastic/go-libaudit/auparse"
	"github.com/your-org/canary/sentinel/internal/auditmon"
)

// runAuditConsumer runs as a child of audispd, reading from stdin
// and forwarding aggregated events to the main Sentinel process.
func runAuditConsumer() {
	log.Println("[audit-consume] Starting audispd plugin worker...")

	// 1. Initialize Aggregator with 2s timeout and 10k buffer
	agg := auditmon.NewAggregator(2*time.Second, 10000)

	// 2. Dial the main Sentinel process
	// We use a Unix socket for low-latency IPC.
	// The main process will listen on /run/canary/audit.sock
	var conn net.Conn
	var err error
	for i := 0; i < 10; i++ {
		conn, err = net.Dial("unix", "/run/canary/audit.sock")
		if err == nil {
			break
		}
		time.Sleep(1 * time.Second)
	}
	if err != nil {
		log.Fatalf("[audit-consume] Failed to connect to main sentinel: %v", err)
	}
	defer conn.Close()

	// 3. Consume from Aggregator and forward to main process
	go func() {
		for event := range agg.Events() {
			// In a real implementation, we would binary-encode or JSON-encode here.
			// For this phase, we'll send a simple ping-back or forward the ID.
			fmt.Fprintf(conn, "EVENT %s %s %d %s\n", event.ID, event.Confidence, event.PID, event.Path)
		}
	}()

	// 4. Read from Stdin (audispd pipe)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		// 11.03: Use the correct Parse signature. Passing 0 as the type 
		// allows the parser to extract the actual type (SYSCALL, PATH, etc.)
		// directly from the type= prefix in the audit line.
		rec, err := auparse.Parse(0, line)
		if err != nil {
			continue
		}
		agg.ProcessRecord(rec)
	}

	if err := scanner.Err(); err != nil {
		log.Fatalf("[audit-consume] Stdin error: %v", err)
	}
}
