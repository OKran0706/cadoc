// canary-system/src/sentinel/cmd/sentinel-a/main.go
// Sentinel-A: Primary event collector, signer, and shipper.
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
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/your-org/canary/sentinel/internal/auth"
	"github.com/your-org/canary/sentinel/internal/config"
	"github.com/your-org/canary/sentinel/internal/heartbeat"
	"github.com/your-org/canary/sentinel/internal/selfmon"
	"github.com/your-org/canary/sentinel/internal/signer"
	"github.com/your-org/canary/sentinel/internal/sysutil"
	"github.com/your-org/canary/sentinel/internal/vault"

	"github.com/segmentio/kafka-go"
)

// authorizedShutdown is set to 1 when a valid maintenance ticket has been processed.
// SIGTERM/SIGINT handlers check this to decide whether shutdown is authorized.
var authorizedShutdown int32

func main() {
	configPath := flag.String("config", "/opt/sentinel/config/sentinel.yaml", "Path to sentinel config")
	testSign := flag.Bool("test-sign", false, "Sign a test event and exit")
	authTicketJSON := flag.String("auth-ticket-json", "", "Raw JSON string of the signed authorization ticket for maintenance")
	authAction := flag.String("action", "", "Action to authorize: SHUTDOWN, REDEPLOY, DEREGISTER, KILLSWITCH_ACTIVATE")
	flag.Parse()

	// 0. Initialize Vault Client
	vaultClient, err := vault.New()
	if err != nil {
		log.Fatalf("Failed to initialize Vault client: %v", err)
	}

	// 0. Unwrap Vault Token (Approach 3 - One-Time Response Wrapping)
	// This ensures we have a valid VAULT_TOKEN in memory without storing it on disk.
	if err := sysutil.UnwrapVaultToken(vaultClient, "VAULT_WRAPPED_TOKEN_A", "Sentinel-A"); err != nil {
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
	if expected, actual, err := sysutil.VerifySelfIntegrity("sentinel-a"); err != nil {
		sendOOBAlert(cfg.OOBAlert.URL, map[string]interface{}{
			"type":   "BINARY_TAMPERED",
			"binary": "sentinel-a",
			"error":  fmt.Sprintf("expected %s got %s", expected, actual),
			"host":   os.Getenv("HOSTNAME"),
		})
		log.Fatalf("Integrity verification failed: %v", err)
	}

	// Initialize signer
	s, err := signer.New(cfg.Signing)
	if err != nil {
		log.Fatalf("Failed to initialize signer: %v", err)
	}

	if *testSign {
		envelope, _ := s.SignEvent(map[string]interface{}{"test": "event"})
		fmt.Printf("Signed test event: %s ✓\n", envelope["signature"])
		os.Exit(0)
	}

	// Initialize maintenance ticket verifier (fetch pubkey from Vault — held in memory only)
	var ticketVerifier *auth.Verifier
	log.Printf("Fetching maintenance pubkey from Vault: %s field=%s",
		cfg.Maintenance.VaultPath, cfg.Maintenance.VaultField)
	
	pubKeyStr, err := vaultClient.GetSecretField(cfg.Maintenance.VaultPath, cfg.Maintenance.VaultField)
	if err != nil {
		log.Printf("Warning: failed to fetch maintenance pubkey from Vault: %v — ticket auth disabled", err)
	} else {
		tv, err := auth.NewVerifierFromBytes([]byte(pubKeyStr))
		if err != nil {
			log.Printf("Warning: maintenance verifier init failed: %v", err)
		} else {
			ticketVerifier = tv
			log.Printf("Maintenance ticket verifier initialized (key_id=%s, in-memory only)", tv.KeyID())
		}
	}

	// Handle --auth-ticket-json: process a maintenance ticket before normal startup
	if *authTicketJSON != "" {
		if ticketVerifier == nil {
			log.Fatal("Cannot process auth ticket: maintenance verifier not initialized")
		}
		if *authAction == "" {
			log.Fatal("--action is required when using --auth-ticket-json")
		}
		ticket, err := ticketVerifier.VerifyFromJSON([]byte(*authTicketJSON), auth.Action(*authAction))
		if err != nil {
			log.Fatalf("AUTH TICKET REJECTED: %v", err)
		}
		log.Printf("AUTH TICKET ACCEPTED: action=%s target=%s issuer=%s",
			ticket.Action, ticket.Target, ticket.Issuer)

		// Mark shutdown as authorized
		atomic.StoreInt32(&authorizedShutdown, 1)

		// Write a run-file so canary-verify knows maintenance is active
		maintFile := "/run/canary/maintenance.active"
		maintData, _ := json.Marshal(map[string]string{
			"action":  string(ticket.Action),
			"exp":     ticket.ExpiresAt,
			"issuer":  ticket.Issuer,
		})
		os.WriteFile(maintFile, maintData, 0644)
		defer os.Remove(maintFile)

		// Emit MAINTENANCE_AUTHORIZED event to Kafka
		maintEvent := map[string]interface{}{
			"type":   "MAINTENANCE_AUTHORIZED",
			"action": string(ticket.Action),
			"issuer": ticket.Issuer,
			"nonce":  ticket.Nonce,
		}
		authEnvelope, _ := s.SignEvent(maintEvent)
		authPayload, _ := signer.MarshalEnvelope(authEnvelope)

		// Must emit before anything else
		tmpWriter := &kafka.Writer{
			Addr:      kafka.TCP(cfg.Telemetry.KafkaBrokers...),
			Topic:     cfg.Telemetry.Topic,
			Balancer:  &kafka.LeastBytes{},
			Transport: kafkaTransport,
		}
		tmpWriter.WriteMessages(context.Background(), kafka.Message{Value: authPayload})
		tmpWriter.Close()

		if auth.Action(*authAction) == auth.ActionShutdown || auth.Action(*authAction) == auth.ActionDeregister {
			log.Printf("Authorized %s — exiting cleanly", *authAction)
			os.Exit(0)
		}
		// For REDEPLOY, continue startup with the authorized flag set
	}

	// Fail closed: verify Kafka is reachable before starting
	if err := verifyKafka(cfg.Telemetry.KafkaBrokers); err != nil {
		log.Fatalf("Kafka unreachable — failing closed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup

	// Write PID file
	if err := os.WriteFile("/run/canary/sentinel-a.pid", []byte(fmt.Sprintf("%d", os.Getpid())), 0644); err != nil {
		log.Printf("Warning: could not write PID file: %v", err)
	}

	// Start Kafka writer
	writer := &kafka.Writer{
		Addr:      kafka.TCP(cfg.Telemetry.KafkaBrokers...),
		Topic:     cfg.Telemetry.Topic,
		Balancer:  &kafka.LeastBytes{},
		Transport: kafkaTransport,
	}
	defer writer.Close()

	// 2. Start eBPF self-monitor (applies Tetragon TracingPolicy)
	// Must happen BEFORE capabilities are dropped (needs CAP_BPF, CAP_SYS_ADMIN)
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := selfmon.Start(ctx, os.Getpid(), s, writer); err != nil {
			log.Printf("Self-monitor error (falling back to /proc polling): %v", err)
			selfmon.PollProc(ctx, os.Getpid(), s, writer)
		}
	}()

	// Give Tetragon policy a moment to apply
	time.Sleep(1 * time.Second)

	// 3. Drop capabilities
	if err := sysutil.DropCapabilitiesAfterInit(); err != nil {
		log.Fatalf("Failed to drop capabilities: %v", err)
	}

	// 4. Emit capability proof event
	capEvent := map[string]interface{}{
		"type":        "SENTINEL_CAPABILITY_SET",
		"effective":   []string{"CAP_NET_ADMIN"},
		"permitted":   []string{"CAP_NET_ADMIN"},
		"inheritable": []string{},
	}
	envelope, _ := s.SignEvent(capEvent)
	payload, _ := signer.MarshalEnvelope(envelope)
	writer.WriteMessages(ctx, kafka.Message{Value: payload})

	// Start heartbeat server (sentinel-b will connect to this)
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := heartbeat.Serve(ctx, cfg.Watchdog.PeerSocket+"-a", "sentinel-a"); err != nil {
			log.Printf("Heartbeat server error: %v", err)
		}
	}()

	// Start peer heartbeat checker (monitors sentinel-b)
	wg.Add(1)
	go func() {
		defer wg.Done()
		heartbeat.MonitorPeer(ctx, cfg.Watchdog.PeerSocket+"-b",
			time.Duration(cfg.Watchdog.HeartbeatIntervalSeconds)*time.Second,
			time.Duration(cfg.Watchdog.AlertThresholdSeconds)*time.Second,
			cfg.OOBAlert.URL,
		)
	}()

	// 5. Start Kill Switch Poller (requires signed ticket from Vault)
	wg.Add(1)
	go func() {
		defer wg.Done()
		pollKillSwitch(ctx, cfg.OOBAlert.URL, s, writer, ticketVerifier, vaultClient)
	}()

	// Main event loop: emit heartbeats and collect events from local sources
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
					"type":           "SENTINEL_HEARTBEAT",
					"source_process": "sentinel-a",
				}
				envelope, _ := s.SignEvent(event)
				payload, _ := signer.MarshalEnvelope(envelope)
				if err := writer.WriteMessages(ctx, kafka.Message{Value: payload}); err != nil {
					log.Printf("Kafka write error: %v", err)
				}
			}
		}
	}()

	// Wait for termination signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	sig := <-sigCh

	// Check if shutdown was authorized via a signed ticket
	if atomic.LoadInt32(&authorizedShutdown) == 0 {
		// UNAUTHORIZED shutdown — emit P1 alert before dying
		log.Printf("UNAUTHORIZED SHUTDOWN DETECTED: signal=%v", sig)
		unauthorizedEvent := map[string]interface{}{
			"type":   "UNAUTHORIZED_SHUTDOWN",
			"signal": sig.String(),
		}
		envelope, _ := s.SignEvent(unauthorizedEvent)
		payload, _ := signer.MarshalEnvelope(envelope)
		writer.WriteMessages(context.Background(), kafka.Message{Value: payload})

		// Also send OOB alert (bypasses Kafka in case Kafka is compromised)
		sendOOBAlert(cfg.OOBAlert.URL, map[string]interface{}{
			"type":   "UNAUTHORIZED_SHUTDOWN",
			"signal": sig.String(),
			"host":   os.Getenv("HOSTNAME"),
		})
	} else {
		log.Println("Authorized shutdown — exiting cleanly")
	}

	cancel()
	wg.Wait()
}

func verifyKafka(brokers []string) error {
	for _, broker := range brokers {
		conn, err := net.DialTimeout("tcp", broker, 5*time.Second)
		if err != nil {
			continue
		}
		conn.Close()
		return nil
	}
	return fmt.Errorf("no Kafka broker reachable from %v", brokers)
}

func pollKillSwitch(ctx context.Context, oobUrl string, s *signer.Signer, writer *kafka.Writer, verifier *auth.Verifier, vc *vault.Client) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Fetch signed killswitch ticket from Vault via API
			ticketStr, err := vc.GetSecretField("secret/canary/control", "killswitch_ticket")
			if err != nil {
				continue // No ticket in Vault — normal operation
			}

			ticketJSON := []byte(strings.TrimSpace(ticketStr))
			if len(ticketJSON) == 0 {
				continue
			}

			// Verify the signed ticket cryptographically
			if verifier == nil {
				log.Println("Kill switch ticket found but no verifier configured — ignoring")
				continue
			}

			ticket, err := verifier.VerifyFromJSON(ticketJSON, auth.ActionKillSwitch)
			if err != nil {
				log.Printf("KILL SWITCH TICKET REJECTED: %v", err)
				// Emit alert: someone put an invalid ticket in Vault
				sendOOBAlert(oobUrl, map[string]interface{}{
					"type":   "INVALID_KILLSWITCH_TICKET",
					"error":  err.Error(),
					"host":   os.Getenv("HOSTNAME"),
				})
				continue
			}

			log.Printf("Kill switch AUTHORIZED: issuer=%s nonce=%s", ticket.Issuer, ticket.Nonce)

			// Mark shutdown as authorized
			atomic.StoreInt32(&authorizedShutdown, 1)

			// 1. Unload Tetragon
			exec.Command("kubectl", "delete", "tracingpolicy", "--all", "-n", "canary-system").Run()

			// 2. Start inotify fallback
			exec.Command("systemctl", "start", "canary-inotify-watcher").Run()

			// 3. Emit signed events
			oobEvent := map[string]interface{}{
				"type":   "SENTINEL_KILL_SWITCH_ACTIVATED",
				"issuer": ticket.Issuer,
				"host":   os.Getenv("HOSTNAME"),
			}
			sendOOBAlert(oobUrl, oobEvent)

			degEvent := map[string]interface{}{
				"type":            "SENTINEL_DEGRADED",
				"monitoring_mode": "inotify",
				"coverage":        "canary_files_only",
				"reason":          "Authorized kill switch",
				"issuer":          ticket.Issuer,
			}
			envelope, _ := s.SignEvent(degEvent)
			payload, _ := signer.MarshalEnvelope(envelope)
			writer.WriteMessages(ctx, kafka.Message{Value: payload})

			// 4. Stop sentinels (requires systemctl, which is a platform dependency not removed)
			// Note: We keep systemctl calls here as they manage process lifecycle, not secrets.
			// However, in a containerized version, this would be a graceful exit signal.
			// exec.Command("systemctl", "stop", "canary-sentinel-a", "canary-sentinel-b").Run()
			log.Println("KILL SWITCH TRIGGERED — SHUTTING DOWN")
			os.Exit(0)
		}
	}
}

func sendOOBAlert(url string, payload map[string]interface{}) {
	payload["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	body, _ := json.Marshal(payload)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}

