// canary-system/src/sentinel/cmd/sentinel-a/main.go
// Sentinel-A: Primary event collector, signer, and shipper.
// Derived from: sentinel-daemon/SKILL.md

package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
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
	"github.com/your-org/canary/sentinel/internal/deployer_daemon"
	"github.com/your-org/canary/sentinel/internal/ingestclient"
	"github.com/your-org/canary/sentinel/internal/selfmon"
	"github.com/your-org/canary/sentinel/internal/signer"
	"github.com/your-org/canary/sentinel/internal/sysutil"
	"github.com/your-org/canary/sentinel/internal/vault"
	"github.com/your-org/canary/sentinel/internal/auditmon" // 11.05: Added auditmon
)

// authorizedShutdown is set to 1 when a valid maintenance ticket has been processed.
// SIGTERM/SIGINT handlers check this to decide whether shutdown is authorized.
var authorizedShutdown int32

func main() {
	devMode := flag.Bool("dev", false, "Run in development mode (skips auth/ingestion bootstrap)")
	configPath := flag.String("config", "/opt/sentinel/config/sentinel.yaml", "Path to sentinel config")
	joinToken := flag.String("join-token", "", "Initial vault bootstrap token")
	testSign := flag.Bool("test-sign", false, "Sign a test event and exit")
	authTicketJSON := flag.String("auth-ticket-json", "", "Raw JSON string of the signed authorization ticket for maintenance")
	authAction := flag.String("action", "", "Action to authorize: SHUTDOWN, REDEPLOY, DEREGISTER, KILLSWITCH_ACTIVATE")

	// Canary Deployer subsystem flags
	deployerProfile := flag.String("deployer-profile", "", "Canary profile (app-server, db-server, etc.)")
	deployerConfigDir := flag.String("deployer-config", "/opt/canary/config", "Path to canary profile configs")
	deployerTemplateDir := flag.String("deployer-templates", "/opt/sentinel/templates", "Path to canary templates")
	deployerInterval := flag.Int("deployer-interval", 3600, "Base canary rotation interval (seconds)")
	deployerMaxJitter := flag.Int("deployer-max-jitter", 1800, "Max random jitter for rotation (seconds)")
	flag.Parse()

	// 0. Subcommand Check (audispd plugin mode)
	if len(os.Args) >= 2 && os.Args[1] == "audit-consume" {
		runAuditConsumer()
		return
	}

	log.Println("=== SENTINEL-A DAEMON BOOTING (MERGED VERSION) ===")

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// 0. Resolve State Directory (Managed by systemd StateDirectory=canary)
	stateDir := os.Getenv("STATE_DIRECTORY")
	if stateDir == "" {
		stateDir = "/var/lib/canary"
	}

	// 1. Initialize Ingestion Client and Signer based on Mode
	var ic *ingestclient.Client
	var s *signer.Signer
	var vaultClient *vault.Client
	var tlsConfig *tls.Config
	
	ctx := context.Background()

	if *devMode {
		log.Println("[DEV] Running in development mode - using local signing and mock ingest")
		s, err = signer.New(cfg.Signing, nil)
		if err != nil {
			log.Fatalf("Signer init failed: %v", err)
		}
		// Mock ingest client (or local-only)
		ic = ingestclient.New(cfg.Watchdog.IngestionURL, nil) 
	} else {
		// --- PRODUCTION BOOTSTRAP ---
		// 1a. Resolve Vault Token
		if *joinToken == "" {
			*joinToken = os.Getenv("SENTINEL_JOIN_TOKEN")
		}

		// 1b. Initialize Vault Client
		vaultClient, err = vault.New()
		if err != nil {
			log.Fatalf("Failed to initialize Vault client: %v", err)
		}

		if *joinToken != "" {
			// Fresh bootstrap path
			vaultClient.SetToken(*joinToken)
			if err := sysutil.UnwrapVaultToken(vaultClient, *joinToken, "Sentinel-A"); err != nil {
				log.Printf("Vault unwrapping: %v (skipping if session already active)", err)
			}
		} else {
			// Recovery path (No join token — attempting cert-based recovery)
			if !auth.IsProvisioned() {
				log.Println("No join token — attempting cert-based recovery...")
				if err := auth.EnsureCertificates(ctx, cfg.Watchdog.IngestionURL); err != nil {
					log.Fatalf("Authentication failure: %v", err)
				}
			}
			
			// Initial mTLS recovery
			if _, _, err := sysutil.LoadPersistedCerts(stateDir); err != nil {
				log.Fatalf("No certificates found in %s — cannot authenticate: %v", stateDir, err)
			}
		}

		// 1c. Load Final TLS Configuration
		var certCA, certClient []byte
		log.Println("Loading final TLS session credentials from Vault...")
		for i := 0; i < 10; i++ {
			tlsConfig, certCA, certClient, err = sysutil.LoadTLSConfig(cfg.Telemetry, vaultClient, *joinToken == "")
			if err == nil {
				break
			}
			log.Printf("Awaiting secrets in Vault (attempt %d/10): %v", i+1, err)
			time.Sleep(5 * time.Second)
		}
		if err != nil {
			log.Fatalf("Failed to initialize final TLS session: %v", err)
		}

		// 1d. Persist State (Public Only)
		if *joinToken != "" {
			_ = sysutil.PersistPublicCerts(stateDir, certCA, certClient)
		}

		// 1e. Finalize Client Initialization
		_ = vaultClient.SetTLSConfig(tlsConfig)
		s, err = signer.New(cfg.Signing, vaultClient)
		if err != nil {
			log.Fatalf("Signer init failed: %v", err)
		}

		ic = ingestclient.New(cfg.Watchdog.IngestionURL, tlsConfig)
	}

	if *testSign && s != nil {
		envelope, _ := s.SignEvent(map[string]interface{}{"test": "event"})
		fmt.Printf("Signed test event: %s ✓\n", envelope["signature"])
		os.Exit(0)
	}

	// 2. Runtime Binary Verification (Skip in dev for speed)
	if _, _, err := sysutil.VerifySelfIntegrity("sentinel-a"); err != nil {
		if !*devMode {
			sendOOBAlert(cfg.OOBAlert.URL, map[string]interface{}{
				"type": "BINARY_TAMPERED",
				"host": os.Getenv("HOSTNAME"),
			})
			log.Fatalf("Integrity verification failed: %v", err)
		}
		log.Printf("[DEV] Binary integrity warning (ignored in dev): %v", err)
	}

	if *testSign {
		envelope, _ := s.SignEvent(map[string]interface{}{"test": "event"})
		fmt.Printf("Signed test event: %s ✓\n", envelope["signature"])
		os.Exit(0)
	}

	// Initialize maintenance ticket verifier (fetch pubkey from Vault — held in memory only)
	var ticketVerifier *auth.Verifier
	if !*devMode {
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
	} else {
		log.Println("[DEV] Skipping maintenance pubkey fetch (Vault disabled in dev)")
	}

	// Handle --auth-ticket-json: process a maintenance ticket before normal startup
	if *authTicketJSON != "" {
		processMaintenanceTicket(context.Background(), *authTicketJSON, *authAction, ticketVerifier, s, ic, cfg)
	}

	// Fail closed: verify Ingestion LB is reachable before starting (Skip in dev)
	if !*devMode {
		if err := verifyIngestion(cfg.Watchdog.IngestionURL, tlsConfig); err != nil {
			log.Fatalf("Ingestion Service unreachable — failing closed: %v", err)
		}
	} else {
		log.Println("[DEV] Skipping ingestion reachability check")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup

	// Write PID file
	if err := os.WriteFile("/run/canary/sentinel-a.pid", []byte(fmt.Sprintf("%d", os.Getpid())), 0644); err != nil {
		log.Printf("Warning: could not write PID file: %v", err)
	}

	// 2. Start eBPF/Audit self-monitor
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := selfmon.Start(ctx, os.Getpid(), s, ic); err != nil {
			log.Printf("Self-monitor error (falling back to /proc polling): %v", err)
			selfmon.PollProc(ctx, os.Getpid(), s, ic)
		}
	}()

	// 11.05: Start Auditmon IPC Server (If in Auditd mode)
	if selfmon.DetectEnvironment() == selfmon.EnvAuditd {
		auditMgr := auditmon.NewAuditctlManager("canary")
		
		// Start health monitor
		wg.Add(1)
		go func() {
			defer wg.Done()
			auditmon.MonitorHealth(ctx, auditMgr, 30*time.Second, func(event auditmon.SubsystemEvent, details map[string]interface{}) {
				log.Printf("[main] Auditd health event: %s", event)
				
				// Map to Kafka event type
				eventType := "SENTINEL_AUDITD_HEALTH"
				if event == auditmon.EventAuditdFailed {
					eventType = "SENTINEL_AUDITD_FAILED"
				} else if event == auditmon.EventAuditdRecovered {
					eventType = "SENTINEL_AUDITD_RECOVERED"
				}

				healthMap := map[string]interface{}{
					"type":  eventType,
					"event": string(event),
				}
				for k, v := range details {
					healthMap[k] = v
				}

				envelope, _ := s.SignEvent(healthMap)
				payload, _ := signer.MarshalEnvelope(envelope)
				if err := ic.Post(ctx, payload); err != nil {
					log.Printf("[main] Failed to post health alert: %v", err)
				}
			})
		}()

		// Start IPC Server
		wg.Add(1)
		go func() {
			defer wg.Done()
			auditmon.StartServer(ctx, "/run/canary/audit.sock", func(event *auditmon.AuditEvent) {
				// Handler: Sign and ship the audit event
				auditMap := map[string]interface{}{
					"type":       "SENTINEL_FILE_TAMPER",
					"audit_id":   event.ID,
					"pid":        event.PID,
					"path":       event.Path,
					"confidence": string(event.Confidence),
				}
				envelope, _ := s.SignEvent(auditMap)
				payload, _ := signer.MarshalEnvelope(envelope)
				if err := ic.Post(ctx, payload); err != nil {
					log.Printf("[auditmon] Failed to post tamper alert: %v", err)
				}
			})
		}()
	}

	// drop capabilities after all initializations

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
	if err := ic.Post(ctx, payload); err != nil {
		log.Printf("Failed to emit initial capability proof: %v", err)
	}

	// 5. Start internal Canary Deployer subsystem
	if *deployerProfile != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			deployer_daemon.StartDaemon(ctx, *deployerProfile, *deployerConfigDir, *deployerTemplateDir, *deployerInterval, *deployerMaxJitter, s, ic)
		}()
	}

	// Phase 1: Sentinel-B is not shipped. The heartbeat server and peer
	// monitor are disabled to avoid false SENTINEL_DOWN alerts.
	// Uncomment when Sentinel-B is deployed.
	//
	// // Start heartbeat server (sentinel-b will connect to this)
	// wg.Add(1)
	// go func() {
	// 	defer wg.Done()
	// 	if err := heartbeat.Serve(ctx, cfg.Watchdog.PeerSocket+"-a", "sentinel-a"); err != nil {
	// 		log.Printf("Heartbeat server error: %v", err)
	// 	}
	// }()
	//
	// // Start peer heartbeat checker (monitors sentinel-b)
	// wg.Add(1)
	// go func() {
	// 	defer wg.Done()
	// 	heartbeat.MonitorPeer(ctx, cfg.Watchdog.PeerSocket+"-b",
	// 		time.Duration(cfg.Watchdog.HeartbeatIntervalSeconds)*time.Second,
	// 		time.Duration(cfg.Watchdog.AlertThresholdSeconds)*time.Second,
	// 		cfg.OOBAlert.URL,
	// 	)
	// }()

	// 5. Start Kill Switch Poller (requires signed ticket from Vault)
	wg.Add(1)
	go func() {
		defer wg.Done()
		pollKillSwitch(ctx, cfg, s, ic, ticketVerifier, vaultClient, stateDir)
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
					"id":             "sentinel-a", // Explicit ID for indexing
				}
				envelope, _ := s.SignEvent(event)
				payload, _ := signer.MarshalEnvelope(envelope)

				if err := ic.Post(ctx, payload); err != nil {
					log.Printf("Heartbeat ingestion error: %v", err)
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
		env, _ := s.SignEvent(unauthorizedEvent)
		p, _ := signer.MarshalEnvelope(env)
		// Try to emit before dying (best effort)
		_ = ic.Post(context.Background(), p)

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

func verifyIngestion(url string, tc *tls.Config) error {
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: tc,
		},
	}
	resp, err := client.Get(url) // Basic check (might return 405, but confirms connectivity)
	if err != nil {
		return fmt.Errorf("ingestion check: %w", err)
	}
	defer resp.Body.Close()
	return nil
}

func pollKillSwitch(ctx context.Context, cfg *config.Config, s *signer.Signer, ic *ingestclient.Client, verifier *auth.Verifier, vc *vault.Client, stateDir string) {
	oobUrl := cfg.OOBAlert.URL
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
				if strings.Contains(err.Error(), "403") {
					log.Println("Vault token expired (403). Attempting refresh...")
					if err := refreshVaultAccess(cfg, vc, stateDir); err != nil {
						log.Printf("Vault recovery failed: %v", err)
					}
				}
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
				sendOOBAlert(oobUrl, map[string]interface{}{
					"type":   "INVALID_KILLSWITCH_TICKET",
					"error":  err.Error(),
					"host":   os.Getenv("HOSTNAME"),
				})
				continue
			}

			log.Printf("Kill switch AUTHORIZED: issuer=%s nonce=%s", ticket.Issuer, ticket.Nonce)
			atomic.StoreInt32(&authorizedShutdown, 1)


			// 2. Start inotify fallback (If systemd available)
			if sysutil.IsCommandAvailable("systemctl") {
				exec.Command("systemctl", "start", "canary-inotify-watcher").Run()
			} else {
				log.Println("[INFO] systemctl not found — skipping inotify fallback start")
			}

			// 3. Emit signed events
			sendOOBAlert(oobUrl, map[string]interface{}{
				"type":   "SENTINEL_KILL_SWITCH_ACTIVATED",
				"issuer": ticket.Issuer,
				"host":   os.Getenv("HOSTNAME"),
			})

			degEvent := map[string]interface{}{
				"type":            "SENTINEL_DEGRADED",
				"monitoring_mode": "inotify",
				"coverage":        "canary_files_only",
				"reason":          "Authorized kill switch",
				"issuer":          ticket.Issuer,
			}
			envelope, _ := s.SignEvent(degEvent)
			payload, _ := signer.MarshalEnvelope(envelope)
			if err := ic.Post(ctx, payload); err != nil {
				log.Printf("Failed to emit DEGRADED event during killswitch: %v", err)
			}

			log.Println("KILL SWITCH TRIGGERED — SHUTTING DOWN")
			os.Exit(0)
		}
	}
}

// refreshVaultAccess performs mTLS re-authentication and refreshes the in-memory TLS config.
func refreshVaultAccess(cfg *config.Config, vc *vault.Client, stateDir string) error {
	// Attempt to login using the certificates already on disk (requires mTLS config to be set)
	_, err := vc.LoginWithCert()
	if err != nil {
		return fmt.Errorf("vault login with cert: %w", err)
	}

	log.Println("Vault re-authenticated successfully ✓ — requesting fresh credentials")

	// Now that we have a valid token, request fresh TLS config into memory
	// diskFallback=false because we want fresh assets from Vault
	tlsConfig, _, _, err := sysutil.LoadTLSConfig(cfg.Telemetry, vc, false)
	if err != nil {
		return fmt.Errorf("refresh TLS assets: %w", err)
	}

	if tlsConfig != nil {
		if err := vc.SetTLSConfig(tlsConfig); err != nil {
			return fmt.Errorf("apply new TLS config: %w", err)
		}
	}

	return nil
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

func processMaintenanceTicket(ctx context.Context, ticketJSONStr, actionStr string, verifier *auth.Verifier, s *signer.Signer, ic *ingestclient.Client, cfg *config.Config) {
	if verifier == nil {
		log.Fatal("Cannot process auth ticket: maintenance verifier not initialized")
	}
	if actionStr == "" {
		log.Fatal("--action is required when using --auth-ticket-json")
	}
	ticket, err := verifier.VerifyFromJSON([]byte(ticketJSONStr), auth.Action(actionStr))
	if err != nil {
		log.Fatalf("AUTH TICKET REJECTED: %v", err)
	}
	log.Printf("AUTH TICKET ACCEPTED: action=%s target=%s issuer=%s",
		ticket.Action, ticket.Target, ticket.Issuer)

	// 1. Mark shutdown/lifecycle operation as authorized
	atomic.StoreInt32(&authorizedShutdown, 1)

	// 2. Write a run-file so monitoring systems know maintenance is active
	maintFile := "/run/canary/maintenance.active"
	maintData, _ := json.Marshal(map[string]string{
		"action": string(ticket.Action),
		"exp":    ticket.ExpiresAt,
		"issuer": ticket.Issuer,
	})
	_ = os.WriteFile(maintFile, maintData, 0644)

	// 3. Emit MAINTENANCE_AUTHORIZED event to Ingestion Service
	maintEvent := map[string]interface{}{
		"type":   "MAINTENANCE_AUTHORIZED",
		"action": string(ticket.Action),
		"issuer": ticket.Issuer,
		"nonce":  ticket.Nonce,
	}
	authEnvelope, _ := s.SignEvent(maintEvent)
	authPayload, _ := signer.MarshalEnvelope(authEnvelope)

	// Must emit before proceeding/exiting
	if err := ic.Post(context.Background(), authPayload); err != nil {
		log.Printf("Failed to emit maintenance authorization: %v", err)
	}

	if auth.Action(actionStr) == auth.ActionShutdown || auth.Action(actionStr) == auth.ActionDeregister {
		log.Printf("Authorized %s — exiting cleanly", actionStr)
		os.Exit(0)
	}
	// For REDEPLOY or other ongoing maintenance, control returns to main()
}

