//go:build linux
// +build linux

package auditmon

import (
	"bufio"
	"context"
	"log"
	"net"
	"os"
	"strings"
	"sync"
)

var (
	workersMu sync.Mutex
	workers   = make(map[net.Conn]bool)
)

// StartServer listens on a Unix socket for events forwarded by the audit consumer plugin.
func StartServer(ctx context.Context, socketPath string, handler func(event *AuditEvent)) error {
	// Clean up existing socket
	os.Remove(socketPath)

	lc := net.ListenConfig{}
	listener, err := lc.Listen(ctx, "unix", socketPath)
	if err != nil {
		return err
	}
	defer listener.Close()

	if err := os.Chmod(socketPath, 0660); err != nil {
		log.Printf("[auditmon] Warning: failed to chmod socket: %v", err)
	}

	log.Printf("[auditmon] Unix socket server listening on %s", socketPath)

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				select {
				case <-ctx.Done():
					return
				default:
					continue
				}
			}
			workersMu.Lock()
			workers[conn] = true
			workersMu.Unlock()
			go handleConnection(ctx, conn, handler)
		}
	}()

	<-ctx.Done()
	return nil
}

// BroadcastControlMessage sends a control command to all connected workers.
func BroadcastControlMessage(msg string) {
	workersMu.Lock()
	defer workersMu.Unlock()
	
	payload := []byte(msg + "\n")
	for conn := range workers {
		_, err := conn.Write(payload)
		if err != nil {
			log.Printf("[auditmon] Failed to send control message to worker: %v", err)
			conn.Close()
			delete(workers, conn)
		}
	}
}

func handleConnection(ctx context.Context, conn net.Conn, handler func(event *AuditEvent)) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		// Simple protocol for now: EVENT <ID> <CONFIDENCE> <PID> <PATH>
		parts := strings.SplitN(line, " ", 5)
		if len(parts) < 5 || parts[0] != "EVENT" {
			continue
		}

		event := &AuditEvent{
			ID:         parts[1],
			Confidence: Confidence(parts[2]),
			PID:        0, // Parse from parts[3]
			Path:       parts[4],
		}
		
		handler(event)
	}
}
