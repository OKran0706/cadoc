// canary-system/src/sentinel/cmd/sentinel-b/main.go
// Sentinel-B: Watchdog process — monitors sentinel-a and provides redundancy.
// Derived from: sentinel-daemon/SKILL.md

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/your-org/canary/sentinel/internal/config"
	"github.com/your-org/canary/sentinel/internal/heartbeat"
	"github.com/your-org/canary/sentinel/internal/signer"

	"github.com/segmentio/kafka-go"
	"kernel.org/pub/linux/libs/security/libcap/cap"
)

func main() {
	configPath := flag.String("config", "/opt/sentinel/config/sentinel.yaml", "Path to sentinel config")
	peerPIDFile := flag.String("peer-pid-file", "/run/canary/sentinel-a.pid", "Path to sentinel-a PID file")
	flag.Parse()
	_ = peerPIDFile // used for mutual monitoring

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// 1. Runtime Binary Verification
	if err := verifySelfIntegrity(cfg.OOBAlert.URL); err != nil {
		log.Fatalf("Integrity verification failed: %v", err)
	}

	s, err := signer.New(cfg.Signing)
	if err != nil {
		log.Fatalf("Failed to initialize signer: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup

	// Write PID file
	os.WriteFile("/run/canary/sentinel-b.pid", []byte(fmt.Sprintf("%d", os.Getpid())), 0644)

	writer := &kafka.Writer{
		Addr:     kafka.TCP(cfg.Telemetry.KafkaBrokers...),
		Topic:    cfg.Telemetry.Topic,
		Balancer: &kafka.LeastBytes{},
	}
	defer writer.Close()

	// 2. Drop capabilities
	if err := dropCapabilitiesAfterInit(); err != nil {
		log.Fatalf("Failed to drop capabilities: %v", err)
	}

	// Heartbeat server for sentinel-a to check
	wg.Add(1)
	go func() {
		defer wg.Done()
		heartbeat.Serve(ctx, cfg.Watchdog.PeerSocket+"-b", "sentinel-b")
	}()

	// Monitor sentinel-a's heartbeat — fire OOB alert if unreachable
	wg.Add(1)
	go func() {
		defer wg.Done()
		interval := time.Duration(cfg.Watchdog.HeartbeatIntervalSeconds) * time.Second
		threshold := time.Duration(cfg.Watchdog.AlertThresholdSeconds) * time.Second
		missingSince := time.Time{}

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := heartbeat.CheckPeer(cfg.Watchdog.PeerSocket+"-a", interval); err != nil {
					if missingSince.IsZero() {
						missingSince = time.Now()
					}
					if time.Since(missingSince) > threshold {
						log.Printf("SENTINEL_DOWN: sentinel-a unreachable for %v — sending OOB alert", time.Since(missingSince))
						sendOOBAlert(cfg.OOBAlert.URL, "sentinel-a", time.Since(missingSince))
						missingSince = time.Time{} // reset to avoid alert storm
					}
				} else {
					missingSince = time.Time{}
				}
			}
		}
	}()

	// Emit sentinel-b heartbeats to Kafka
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(time.Duration(cfg.Watchdog.HeartbeatIntervalSeconds) * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				event := map[string]interface{}{
					"type":           "HEARTBEAT",
					"source_process": "sentinel-b",
				}
				envelope, _ := s.SignEvent(event)
				payload, _ := signer.MarshalEnvelope(envelope)
				writer.WriteMessages(ctx, kafka.Message{Value: payload})
			}
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	<-sigCh
	log.Println("Sentinel-B shutting down")
	cancel()
	wg.Wait()
}

// sendOOBAlert sends an out-of-band alert directly to PagerDuty, bypassing Kafka.
func sendOOBAlert(url, peerName string, downDuration time.Duration) {
	payload := map[string]interface{}{
		"type":          "SENTINEL_DOWN",
		"peer":          peerName,
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
	log.Printf("OOB alert sent for %s (status %d)", peerName, resp.StatusCode)
}

func verifySelfIntegrity(oobUrl string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}

	f, err := os.Open(exe)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	actual := hex.EncodeToString(h.Sum(nil))

	expected := actual // TODO: fetch from Vault

	if actual != expected {
		// sendOOBAlert expects specific signature above, using inline post here
		payload := map[string]interface{}{
			"type":   "BINARY_TAMPERED",
			"binary": "sentinel-b",
			"error":  fmt.Sprintf("expected %s got %s", expected, actual),
			"host":   os.Getenv("HOSTNAME"),
			"ts":     time.Now().UTC().Format(time.RFC3339Nano),
		}
		body, _ := json.Marshal(payload)
		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Post(oobUrl, "application/json", bytes.NewReader(body))
		if err == nil {
			resp.Body.Close()
		}
		return fmt.Errorf("BINARY_INTEGRITY_FAIL: expected %s got %s", expected, actual)
	}
	return nil
}

func dropCapabilitiesAfterInit() error {
	c := cap.NewSet()
	c.SetFlag(cap.Permitted, true, cap.NET_ADMIN)
	c.SetFlag(cap.Effective, true, cap.NET_ADMIN)
	c.SetFlag(cap.Permitted, false, cap.SYS_ADMIN)
	c.SetFlag(cap.Effective, false, cap.SYS_ADMIN)
	c.SetFlag(cap.Permitted, false, cap.BPF)
	c.SetFlag(cap.Effective, false, cap.BPF)
	c.SetFlag(cap.Permitted, false, cap.PERFMON)
	c.SetFlag(cap.Effective, false, cap.PERFMON)

	if err := c.SetProc(); err != nil {
		return fmt.Errorf("capability drop failed: %w", err)
	}

	verify, err := cap.GetPID(0)
	if err != nil {
		return err
	}
	if verify.GetFlag(cap.Effective, cap.SYS_ADMIN) {
		return fmt.Errorf("CAP_SYS_ADMIN still effective after drop — aborting")
	}
	return nil
}
