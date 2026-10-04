//go:build linux
// +build linux

package main

import (
	"bufio"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
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

	// 2. Start Stdin consumer in background
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			rec, err := auparse.Parse(0, line)
			if err != nil {
				continue
			}
			agg.ProcessRecord(rec)
		}
	}()

	// 3. Connect to main process with exponential backoff
	backoff := 1 * time.Second
	maxBackoff := 60 * time.Second

	for {
		log.Printf("[audit-consume] Attempting to connect to sentinel at /run/canary/audit.sock...")
		conn, err := net.Dial("unix", "/run/canary/audit.sock")
		if err != nil {
			log.Printf("[audit-consume] Connection failed: %v. Retrying in %v...", err, backoff)
			time.Sleep(backoff)
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}

		log.Println("[audit-consume] Connected to sentinel ✓")
		backoff = 1 * time.Second // Reset backoff on success

		handleSentinelConn(conn, agg)
	}
}

func handleSentinelConn(conn net.Conn, agg *auditmon.Aggregator) {
	defer conn.Close()
	errChan := make(chan error, 1)

	// A. Forward events to Sentinel
	go func() {
		for event := range agg.Events() {
			_, err := fmt.Fprintf(conn, "EVENT %s %s %d %s\n", event.ID, event.Confidence, event.PID, event.Path)
			if err != nil {
				errChan <- err
				return
			}
		}
	}()

	// B. Receive control messages from Sentinel (e.g. SET_MAP)
	go func() {
		scanner := bufio.NewScanner(conn)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "SET_MAP ") {
				paths := strings.Split(line[8:], ",")
				agg.SetWatchPaths(paths)
			}
		}
		if err := scanner.Err(); err != nil {
			errChan <- err
		} else {
			errChan <- fmt.Errorf("sentinel closed connection")
		}
	}()

	// Wait for any error
	err := <-errChan
	log.Printf("[audit-consume] IPC Error: %v. Reconnecting...", err)
}
