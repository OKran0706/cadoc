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
			go handleConnection(ctx, conn, handler)
		}
	}()

	<-ctx.Done()
	return nil
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
