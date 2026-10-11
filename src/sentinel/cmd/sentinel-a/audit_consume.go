//go:build linux
// +build linux

package main

import (
	"bufio"
	"context"
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
		// Increase buffer capacity to 1MB to handle extremely large audit records
		buf := make([]byte, 64*1024)
		scanner.Buffer(buf, 1024*1024)
		
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

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errChan := make(chan error, 2)

	// A. Forward aggregated events to Sentinel daemon
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-agg.Events():
				if !ok {
					errChan <- fmt.Errorf("aggregator events channel closed")
					return
				}
				b, err := json.Marshal(event)
				if err != nil {
					log.Printf("[audit-consume] Failed to marshal event: %v", err)
					continue
				}
				line := fmt.Sprintf("EVENT %s\n", string(b))
				log.Printf("[audit-consume-debug] Sending to socket: %q", line)
				if _, err = fmt.Fprintf(conn, "%s", line); err != nil {
					errChan <- err
					return
				}
			}
		}
	}()

	// B. Receive control messages (SET_MAP) from Sentinel daemon
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

	// Wait for first error from either goroutine, then cancel both.
	// cancel() via defer cancels goroutine A via ctx.Done().
	// conn.Close() via defer unblocks goroutine B's scanner with an EOF.
	err := <-errChan
	log.Printf("[audit-consume] IPC Error: %v. Reconnecting...", err)
}

