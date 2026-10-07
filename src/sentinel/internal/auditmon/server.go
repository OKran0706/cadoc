//go:build linux
// +build linux

package auditmon

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"net"
	"strings"
	"sync"
	"time"
	"github.com/your-org/canary/sentinel/internal/sysutil"
)

var (
	workersMu     sync.Mutex
	workers       = make(map[net.Conn]bool)
	currentMapMsg string // H-01: cached latest SET_MAP for replay on reconnect
)

// StartServer listens on a Unix socket for events forwarded by the audit consumer plugin.
func StartServer(ctx context.Context, socketPath string, handler func(event *AuditEvent)) error {
	listener, err := sysutil.ListenUnix(ctx, socketPath, 0660)
	if err != nil {
		return err
	}
	defer listener.Close()

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
			// H-01: Replay current canary map to newly connected worker immediately.
			if currentMapMsg != "" {
				payload := []byte(currentMapMsg + "\n")
				if _, err := conn.Write(payload); err != nil {
					log.Printf("[auditmon] Failed to replay map to new worker: %v", err)
					conn.Close()
					delete(workers, conn)
					workersMu.Unlock()
					continue
				}
				log.Printf("[auditmon] Replayed canary map to new worker (%d bytes)", len(payload))
			}
			workersMu.Unlock()
			go handleConnection(ctx, conn, handler)
		}
	}()

	<-ctx.Done()
	return nil
}

// BroadcastControlMessage sends a control command to all connected workers.
// For SET_MAP messages, the message is also cached for replay on new connections.
func BroadcastControlMessage(msg string) {
	workersMu.Lock()
	defer workersMu.Unlock()

	// H-01: Cache SET_MAP for replay on new connections.
	if strings.HasPrefix(msg, "SET_MAP ") {
		currentMapMsg = msg
	}

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
	log.Printf("[auditmon-debug] New connection from consumer: %v", conn.RemoteAddr())
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	for {
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		if !scanner.Scan() {
			break
		}
		line := scanner.Text()
		log.Printf("[auditmon-debug] Raw IPC line: %q", line)
		if line == "" {
			continue
		}

		// Protocol: EVENT <JSON_OBJECT>
		parts := strings.SplitN(line, " ", 2)
		if len(parts) < 2 || parts[0] != "EVENT" {
			continue
		}

		event := &AuditEvent{}
		if err := json.Unmarshal([]byte(parts[1]), event); err != nil {
			log.Printf("[auditmon] Failed to unmarshal event: %v", err)
			continue
		}
		
		handler(event)
	}
}
