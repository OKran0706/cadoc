// canary-system/src/sentinel/internal/heartbeat/heartbeat.go
// Mutual heartbeat via Unix domain sockets.
// Derived from: sentinel-daemon/SKILL.md

package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"
)

// Serve starts a heartbeat listener on the given Unix socket path.
// Incoming connections receive a JSON ACK with process identity.
func Serve(ctx context.Context, socketPath, selfName string) error {
	os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("heartbeat listen: %w", err)
	}

	go func() {
		<-ctx.Done()
		listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				continue
			}
		}
		go func(c net.Conn) {
			defer c.Close()
			ack := map[string]interface{}{
				"process": selfName,
				"ts":      time.Now().UTC().Format(time.RFC3339Nano),
				"status":  "alive",
				"pid":     os.Getpid(),
			}
			json.NewEncoder(c).Encode(ack)
		}(conn)
	}
}

// CheckPeer dials the peer's Unix socket and verifies it responds within timeout.
func CheckPeer(peerSocket string, timeout time.Duration) error {
	conn, err := net.DialTimeout("unix", peerSocket, timeout)
	if err != nil {
		return fmt.Errorf("peer unreachable: %w", err)
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(timeout))
	var ack map[string]interface{}
	if err := json.NewDecoder(conn).Decode(&ack); err != nil {
		return fmt.Errorf("peer heartbeat decode: %w", err)
	}
	if ack["status"] != "alive" {
		return fmt.Errorf("peer reports non-alive status: %v", ack["status"])
	}
	return nil
}

// MonitorPeer continuously checks a peer and fires an OOB alert if the peer
// is unresponsive for longer than the threshold.
func MonitorPeer(ctx context.Context, peerSocket string, interval, threshold time.Duration, oobURL string) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	missingSince := time.Time{}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := CheckPeer(peerSocket, interval); err != nil {
				if missingSince.IsZero() {
					missingSince = time.Now()
				}
				if time.Since(missingSince) > threshold {
					log.Printf("SENTINEL_DOWN: peer at %s unreachable for %v", peerSocket, time.Since(missingSince))
					sendOOBAlert(oobURL, peerSocket, time.Since(missingSince))
					missingSince = time.Time{}
				}
			} else {
				if !missingSince.IsZero() {
					log.Printf("HEARTBEAT_OK: peer at %s recovered", peerSocket)
				}
				missingSince = time.Time{}
			}
		}
	}
}

func sendOOBAlert(url, peer string, downDuration time.Duration) {
	payload := map[string]interface{}{
		"type":          "SENTINEL_DOWN",
		"peer":          peer,
		"down_duration": downDuration.String(),
		"ts":            time.Now().UTC().Format(time.RFC3339Nano),
	}
	body, _ := json.Marshal(payload)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("OOB alert failed: %v", err)
		return
	}
	resp.Body.Close()
}
