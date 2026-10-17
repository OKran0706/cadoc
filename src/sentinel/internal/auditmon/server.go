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
	"github.com/your-org/canary/sentinel/internal/sysutil"
)

type Server struct {
	workersMu     sync.Mutex
	workers       map[net.Conn]bool
	currentMapMsg string
}

func NewServer() *Server {
	return &Server{
		workers: make(map[net.Conn]bool),
	}
}

// Start listens on a Unix socket for events forwarded by the audit consumer plugin.
// Security Model: Authentication is implicitly handled by the OS filesystem permissions.
// The socket directory (/run/canary) is set to 0700 and the socket to 0660, restricting
// access to the root user and the canary group.
func (s *Server) Start(ctx context.Context, socketPath string, handler func(event *AuditEvent)) error {
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
			s.workersMu.Lock()
			s.workers[conn] = true
			// H-01: Replay current canary map to newly connected worker immediately.
			if s.currentMapMsg != "" {
				payload := []byte(s.currentMapMsg + "\n")
				if _, err := conn.Write(payload); err != nil {
					log.Printf("[auditmon] Failed to replay map to new worker: %v", err)
					conn.Close()
					delete(s.workers, conn)
					s.workersMu.Unlock()
					continue
				}
				log.Printf("[auditmon] Replayed canary map to new worker (%d bytes)", len(payload))
			}
			s.workersMu.Unlock()
			go s.handleConnection(ctx, conn, handler)
		}
	}()

	<-ctx.Done()
	return nil
}

// BroadcastControlMessage sends a control command to all connected workers.
// For SET_MAP messages, the message is also cached for replay on new connections.
func (s *Server) BroadcastControlMessage(msg string) {
	s.workersMu.Lock()
	defer s.workersMu.Unlock()

	// H-01: Cache SET_MAP for replay on new connections.
	if strings.HasPrefix(msg, "SET_MAP ") {
		s.currentMapMsg = msg
	}

	payload := []byte(msg + "\n")
	for conn := range s.workers {
		_, err := conn.Write(payload)
		if err != nil {
			log.Printf("[auditmon] Failed to send control message to worker: %v", err)
			conn.Close()
			delete(s.workers, conn)
		}
	}
}

func (s *Server) handleConnection(ctx context.Context, conn net.Conn, handler func(event *AuditEvent)) {
	log.Printf("[auditmon-debug] New connection from consumer: %v", conn.RemoteAddr())
	defer func() {
		// Forget the worker, or every later broadcast logs a "closed network connection" error per dead peer.
		s.workersMu.Lock()
		delete(s.workers, conn)
		s.workersMu.Unlock()
		conn.Close()
	}()
	scanner := bufio.NewScanner(conn)
	// No read deadline: an idle consumer is normal (no decoy touched). The old 30s deadline made the
	// server drop a healthy consumer every 30s, and an event written during that reconnect was lost.
	// A dead peer shows up as EOF on a unix socket, so no timeout is needed.
	for {
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
