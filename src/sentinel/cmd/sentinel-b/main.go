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
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/your-org/canary/sentinel/internal/config"
	"github.com/your-org/canary/sentinel/internal/heartbeat"
	"github.com/your-org/canary/sentinel/internal/signer"
	"github.com/your-org/canary/sentinel/internal/sysutil"
	"github.com/your-org/canary/sentinel/internal/vault"

	"github.com/segmentio/kafka-go"
)

func main() {
	configPath := flag.String("config", "/opt/sentinel/config/sentinel.yaml", "Path to sentinel config")
	peerPIDFile := flag.String("peer-pid-file", "/run/canary/sentinel-a.pid", "Path to sentinel-a PID file")
	joinToken := flag.String("join-token", "", "Initial vault bootstrap token")
	flag.Parse()
	_ = peerPIDFile // used for mutual monitoring

	// 0. Initialize Vault Client
	vaultClient, err := vault.New()
	if err != nil {
		log.Fatalf("Failed to initialize Vault client: %v", err)
	}

	if *joinToken != "" {
		vaultClient.SetToken(*joinToken)
	}

	// 0. Unwrap Vault Token
	if err := sysutil.UnwrapVaultToken(vaultClient, *joinToken, "Sentinel-B"); err != nil {
		log.Printf("Vault unwrapping: %v (skipping if VAULT_TOKEN already set or not needed)", err)
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	tlsConfig, err := sysutil.LoadTLSConfig(cfg.Telemetry, vaultClient)
	if err != nil {
		log.Fatalf("Failed to load TLS config: %v", err)
	}

	kafkaTransport := &kafka.Transport{
		TLS: tlsConfig,
	}

	// 1. Runtime Binary Verification
	if expected, actual, err := sysutil.VerifySelfIntegrity("sentinel-b"); err != nil {
		payload := map[string]interface{}{
			"type":   "BINARY_TAMPERED",
			"binary": "sentinel-b",
			"error":  fmt.Sprintf("expected %s got %s", expected, actual),
			"host":   os.Getenv("HOSTNAME"),
			"ts":     time.Now().UTC().Format(time.RFC3339Nano),
		}
		body, _ := json.Marshal(payload)
		client := &http.Client{Timeout: 10 * time.Second}
		if resp, reqErr := client.Post(cfg.OOBAlert.URL, "application/json", bytes.NewReader(body)); reqErr == nil {
			resp.Body.Close()
		}
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
		Addr:      kafka.TCP(cfg.Telemetry.KafkaBrokers...),
		Topic:     cfg.Telemetry.Topic,
		Balancer:  &kafka.LeastBytes{},
		Transport: kafkaTransport,
	}
	defer writer.Close()

	// 2. Drop capabilities
	if err := sysutil.DropCapabilitiesAfterInit(); err != nil {
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
