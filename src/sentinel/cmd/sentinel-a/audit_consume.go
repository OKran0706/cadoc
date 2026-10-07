//go:build linux
// +build linux

package main

import (
	"bufio"
	"encoding/json"
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

	// 1. Initialize Aggregator with 2s timeout, 10k buffers, and 5k channel capacity
	agg := auditmon.NewAggregator(2*time.Second, 10000, 5000)

	// 2. Start Stdin consumer in background
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			rec, err := auparse.ParseLogLine(line)
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
	errChan := make(chan error, 2)
	stopForwarding := make(chan struct{})
	defer close(stopForwarding)

	// A. Forward events to Sentinel
	go func() {
		for {
			select {
			case event := <-agg.Events():
				b, err := json.Marshal(event)
				if err != nil {
					log.Printf("[audit-consume] Failed to marshal event: %v", err)
					continue
				}
				line := fmt.Sprintf("EVENT %s\n", string(b))
				log.Printf("[audit-consume-debug] Sending to socket: %q", line)
				_, err = fmt.Fprintf(conn, line)
				if err != nil {
					errChan <- err
					return
				}
			case <-stopForwarding:
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
				var paths []string
				if err := json.Unmarshal([]byte(line[8:]), &paths); err != nil {
					log.Printf("[audit-consume] Failed to unmarshal SET_MAP: %v", err)
					continue
				}
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
