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
	"syscall"
	"time"

	"github.com/your-org/canary/sentinel/internal/auditmon"
	"github.com/your-org/canary/sentinel/internal/auth"
	"github.com/your-org/canary/sentinel/internal/config"
	"github.com/your-org/canary/sentinel/internal/deployer_daemon"
	"github.com/your-org/canary/sentinel/internal/ingestclient"
	"github.com/your-org/canary/sentinel/internal/selfmon"
	"github.com/your-org/canary/sentinel/internal/signer"
	"github.com/your-org/canary/sentinel/internal/sysutil"
)

func main() {
	// 0. Subcommand routing — MUST come before flag.Parse().
	// audispd invokes this binary with "audit-consume" as argv[1].
	// No flags are parsed or needed in this path.
	if len(os.Args) >= 2 && os.Args[1] == "audit-consume" {
		runAuditConsumer()
		return
	}

	devMode := flag.Bool("dev", false, "Run in development mode (skips auth/ingestion bootstrap)")
	configPath := flag.String("config", "/opt/sentinel/config/sentinel.yaml", "Path to sentinel config")
	joinToken := flag.String("join-token", "", "Initial vault bootstrap token")

	// Canary Deployer subsystem flags
	deployerProfile := flag.String("deployer-profile", "", "Canary profile (app-server, db-server, etc.)")
	deployerConfigDir := flag.String("deployer-config", "/opt/canary/config", "Path to canary profile configs")
	deployerTemplateDir := flag.String("deployer-templates", "/opt/sentinel/templates", "Path to canary templates")
	deployerInterval := flag.Int("deployer-interval", 3600, "Base canary rotation interval (seconds)")
	deployerMaxJitter := flag.Int("deployer-max-jitter", 1800, "Max random jitter for rotation (seconds)")
	flag.Parse()

	log.Println("=== SENTINEL-A DAEMON BOOTING ===")

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Resolve State Directory (Managed by systemd StateDirectory=canary)
	stateDir := os.Getenv("STATE_DIRECTORY")
	if stateDir == "" {
		stateDir = "/var/lib/canary"
	}

	// 1. Initialize Ingestion Client and Signer based on Mode
	var ic *ingestclient.Client
	var s *signer.Signer
	var tlsConfig *tls.Config
	var signerKey string

	ctx := context.Background()

	if *devMode {
		log.Println("[DEV] Running in development mode - using mock ingest")
		// In dev mode, we just need A key. We use the local env var.
		s, err = signer.New(os.Getenv("SENTINEL_LOCAL_KEY"))
		if err != nil {
			log.Fatalf("Signer init failed: %v", err)
		}
		ic = ingestclient.New(cfg.Watchdog.IngestionURL, nil)
	} else {
		// --- PRODUCTION BOOTSTRAP ---
		// 1a. Resolve Join Token (CLI flag takes precedence over env var)
		if *joinToken == "" {
			*joinToken = os.Getenv("SENTINEL_JOIN_TOKEN")
		}

		var certCA, certClient []byte
		if *joinToken != "" {
			// --- FRESH BOOTSTRAP PATH ---
			// Contact the Ingestion Service to exchange the Join Token for an mTLS
			// credential package. The Ingestion Service brokers all Vault interaction;
			// the Sentinel never contacts Vault directly during enrollment.
			log.Printf("[boot] No persisted credentials found. Running initial bootstrap with Join Token.")
			caCert, clientCert, renewalToken, sk, err := auth.BootstrapFromIngestionService(
				ctx,
				cfg.Watchdog.IngestionURL,
				*joinToken,
				stateDir,
			)
			if err != nil {
				log.Fatalf("[boot] Bootstrap failed: %v", err)
			}
			signerKey = sk

			// Persist the public certs and the renewal token to disk.
			// Private key remains ONLY in process memory.
			if err := sysutil.PersistPublicCerts(stateDir, caCert, clientCert); err != nil {
				log.Fatalf("[boot] Failed to persist certificates: %v", err)
			}
			if err := sysutil.PersistRenewalToken(stateDir, renewalToken); err != nil {
				log.Fatalf("[boot] Failed to persist renewal token: %v", err)
			}

			log.Printf("[boot] Initial bootstrap successful.")

			// Build TLS config from in-memory private key + fetched public certs.
			tlsConfig, err = sysutil.BuildTLSConfigFromBytes(caCert, clientCert, auth.InMemoryClientKey)
			if err != nil {
				log.Fatalf("[boot] Failed to build TLS config from bootstrap credentials: %v", err)
			}
		} else {
			// --- RECOVERY PATH (restart without join token) ---
			log.Printf("[boot] No join token — attempting credential renewal from Ingestion Service")
			caCert, _, err := sysutil.LoadPersistedCerts(stateDir)
			if err != nil {
				log.Fatalf("[boot] Missing required certs and no join token provided. Cannot start.")
			}
			
			renewalToken, err := sysutil.LoadRenewalToken(stateDir)
			if err != nil {
				log.Fatalf("[boot] Missing renewal token. Re-bootstrap with join token required.")
			}

			// Build a temporary TLS config from persisted certs to authenticate the server.
			// Note: private key is gone; we pass nil for client cert/key.
			// The Ingestion Service identifies us by the X-Client-Cert-CN header
			// and authenticates us via the X-Renewal-Token.
			tempTLS, err := sysutil.BuildTLSConfigFromBytes(caCert, nil, nil)
			if err != nil {
				log.Fatalf("[boot] Failed to load CA cert for TLS recovery: %v", err)
			}

			clientID := cfg.ClientID
			if clientID == "" {
				log.Fatalf("[boot] cfg.ClientID is required for credential renewal — set client_id in config")
			}

			// Recover the private key, new certs, and new Signer Key from Ingestion Service
			newCACert, newClientCert, newRenewalToken, sk, err := auth.RecoverFromIngestionService(
				ctx,
				cfg.Watchdog.IngestionURL,
				tempTLS,
				clientID,
				renewalToken,
			)
			if err != nil {
				log.Fatalf("[boot] Credential renewal failed — re-bootstrap with a new join token is required: %v", err)
			}
			signerKey = sk

			// Persist the refreshed certs and token
			if err := sysutil.PersistPublicCerts(stateDir, newCACert, newClientCert); err != nil {
				log.Fatalf("[boot] Failed to persist refreshed certificates: %v", err)
			}
			if err := sysutil.PersistRenewalToken(stateDir, newRenewalToken); err != nil {
				log.Fatalf("[boot] Failed to persist refreshed renewal token: %v", err)
			}

			log.Printf("[boot] Credential renewal successful.")

			// Build final TLS config from renewed private key (now in InMemoryClientKey).
			tlsConfig, err = sysutil.BuildTLSConfigFromBytes(newCACert, newClientCert, auth.InMemoryClientKey)
			if err != nil {
				log.Fatalf("[boot] Failed to build TLS config from renewed credentials: %v", err)
			}

			// Persist refreshed public certs.
			if err := sysutil.PersistPublicCerts(stateDir, certCA, certClient); err != nil {
				log.Printf("[boot] Warning: failed to persist renewed certificates: %v", err)
			}
			log.Println("[boot] Credential renewal successful ✓")
		}

		s, err = signer.New(signerKey)
		if err != nil {
			log.Fatalf("Signer init failed: %v", err)
		}

		ic = ingestclient.New(cfg.Watchdog.IngestionURL, tlsConfig)

		// Start background identity renewal loop (The "Rachet")
		// Rotates mTLS certs, tokens, and signer keys every 6 hours while the process is running.
		auth.RunIdentityRenewalLoop(ctx, cfg.Watchdog.IngestionURL, stateDir, cfg.ClientID, func(newTLS *tls.Config, newSignerKey string) {
			ic.UpdateTLSConfig(newTLS)
			// Hot-swap the signer key
			newS, err := signer.New(newSignerKey)
			if err != nil {
				log.Printf("[auth] Warning: failed to create new signer from rotated key: %v", err)
			} else {
				s = newS
				log.Printf("[auth] Signer key hot-swapped successfully")
			}
		})
	}


	// Self-test signing removed (flag deleted by user)

	// 2. Runtime Binary Verification (Skip in dev for speed)
	if _, _, err := sysutil.VerifySelfIntegrity("sentinel-a"); err != nil {
		if !*devMode {
			sendOOBAlert(ctx, ic, cfg.OOBAlert.URL, map[string]interface{}{
				"type": "BINARY_TAMPERED",
				"host": os.Getenv("HOSTNAME"),
			})
			log.Fatalf("Integrity verification failed: %v", err)
		}
		log.Printf("[DEV] Binary integrity warning (ignored in dev): %v", err)
	}

	// Initialize maintenance ticket verifier (fetch pubkey from Broker — held in memory only)
	var ticketVerifier *auth.Verifier
	if !*devMode {
		log.Printf("Fetching maintenance pubkey from Ingestion Broker...")

		pubKeyStr, err := auth.GetMaintenanceKey(ctx, ic)
		if err != nil {
			log.Printf("Warning: failed to fetch maintenance pubkey from Broker: %v — ticket auth disabled", err)
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
		log.Println("[DEV] Skipping maintenance pubkey fetch (Vault/Broker disabled in dev)")
	}

	// Fail closed: verify Ingestion LB is reachable before starting (Skip in dev)
	if !*devMode {
		if err := verifyIngestionWithRetry(ctx, ic, cfg.Watchdog.IngestionURL); err != nil {
			log.Fatalf("Ingestion Service unreachable — failing closed: %v", err)
		}
	} else {
		log.Println("[DEV] Skipping ingestion reachability check")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup

	// Write PID file — ensure directory exists first.
	const pidDir = "/run/canary"
	const pidFile = pidDir + "/sentinel-a.pid"
	if err := os.MkdirAll(pidDir, 0700); err != nil {
		log.Printf("Warning: could not create PID directory %s: %v", pidDir, err)
	} else if err := os.WriteFile(pidFile, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0644); err != nil {
		log.Printf("Warning: could not write PID file %s: %v", pidFile, err)
	} else {
		log.Printf("PID file written: %s (pid=%d)", pidFile, os.Getpid())
	}

	// 2. Start Self-Monitoring & Health Management
	auditMgr := auditmon.NewAuditctlManager("canary")
	auditMgr.ClearAll() // Flush any stale rules from previous runs
	if err := selfmon.Start(ctx, os.Getpid(), s, ic, auditMgr); err != nil {
		log.Printf("Auditd self-monitor not available: %v. Starting /proc fallback...", err)
		go selfmon.PollProc(ctx, os.Getpid(), s, ic)
	}

	var ipcServer *auditmon.Server
	// Start Auditmon IPC Server (If in Auditd mode)
	if selfmon.DetectEnvironment() == selfmon.EnvAuditd {
		ipcServer = auditmon.NewServer()
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := ipcServer.Start(ctx, "/run/canary/audit.sock", func(event *auditmon.AuditEvent) {
				log.Printf("[auditmon] Received event from consumer: id=%s path=%s op=%s", event.ID, event.Path, event.Op)
				// Handler: Sign and ship the audit event
				log.Printf("[auditmon] Signing event for path=%s", event.Path)

				eventType := "SENTINEL_FILE_TAMPER"
				switch event.Op {
				case "READ":
					eventType = "SENTINEL_FILE_READ"
				case "OPEN":
					eventType = "SENTINEL_FILE_OPEN"
				case "WRITE":
					eventType = "SENTINEL_FILE_WRITE"
				case "RENAME":
					eventType = "SENTINEL_FILE_MOVE"
				case "DELETE":
					eventType = "SENTINEL_FILE_DELETE"
				case "CHMOD":
					eventType = "SENTINEL_FILE_ATTR_CHANGE"
				case "CHOWN":
					eventType = "SENTINEL_FILE_OWNER_CHANGE"
				case "TRUNCATE":
					eventType = "SENTINEL_FILE_TRUNCATE"
				}

				auditMap := map[string]interface{}{
					"type":       eventType,
					"op":         event.Op,
					"audit_id":   event.ID,
					"pid":        event.PID,
					"path":       event.Path,
					"confidence": string(event.Confidence),
				}
				if event.DestPath != "" {
					auditMap["dest_path"] = event.DestPath
				}

				envelope, _, err := s.SignEvent(auditMap)
				if err != nil {
					log.Printf("[auditmon] Failed to sign tamper event: %v — skipping", err)
					return
				}
				payload, err := signer.MarshalEnvelope(envelope)
				if err != nil {
					log.Printf("[auditmon] Failed to marshal tamper envelope (path=%s): %v — skipping", event.Path, err)
					return
				}
				log.Printf("[auditmon] Posting tamper alert to ingestion service...")
				if err := ic.Post(ctx, payload); err != nil {
					log.Printf("[auditmon] Failed to post tamper alert: %v", err)
				} else {
					log.Printf("[auditmon] Tamper alert posted successfully!")
				}
			}); err != nil {
				log.Printf("[auditmon] Socket server error: %v", err)
			}
		}()
	}

	// 3. Drop capabilities after all initializations
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
	envelope, _, err := s.SignEvent(capEvent)
	if err != nil {
		log.Printf("[boot] Failed to sign capability proof: %v — skipping", err)
	} else if payload, err := signer.MarshalEnvelope(envelope); err != nil {
		log.Printf("[boot] Failed to marshal capability proof envelope: %v — skipping", err)
	} else if err := ic.Post(ctx, payload); err != nil {
		log.Printf("[boot] Failed to emit initial capability proof: %v", err)
	}

	// 5. Start internal Canary Deployer subsystem
	if *deployerProfile != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			deployer_daemon.StartDaemon(ctx, *deployerProfile, *deployerConfigDir, *deployerTemplateDir, *deployerInterval, *deployerMaxJitter, s, ic, func(paths []string) {
				b, _ := json.Marshal(paths)
				msg := "SET_MAP " + string(b)
				log.Printf("[boot] Broadcasting new canary map to workers: %s", msg)
				if ipcServer != nil {
					ipcServer.BroadcastControlMessage(msg)
				}
				// Dynamically register kernel audit watches for the new canaries!
				log.Printf("[boot] Registering live kernel audit rules for %d canary paths...", len(paths))
				auditMgr.ClearAll() // Clear old watch rules first to prevent leakage
				for _, path := range paths {
					if err := auditMgr.AddWatch(path); err != nil {
						log.Printf("[boot] Warning: failed to register audit watch for %s: %v", path, err)
					}
				}
			})
		}()
	}

	// Phase 1: Sentinel-B is not shipped. The heartbeat server and peer
	// monitor are disabled to avoid false SENTINEL_DOWN alerts.
	// Uncomment when Sentinel-B is deployed.
	//
	// wg.Add(1)
	// go func() {
	// 	defer wg.Done()
	// 	if err := heartbeat.Serve(ctx, cfg.Watchdog.PeerSocket+"-a", "sentinel-a"); err != nil {
	// 		log.Printf("Heartbeat server error: %v", err)
	// 	}
	// }()
	//
	// wg.Add(1)
	// go func() {
	// 	defer wg.Done()
	// 	heartbeat.MonitorPeer(ctx, cfg.Watchdog.PeerSocket+"-b",
	// 		time.Duration(cfg.Watchdog.HeartbeatIntervalSeconds)*time.Second,
	// 		time.Duration(cfg.Watchdog.AlertThresholdSeconds)*time.Second,
	// 		cfg.OOBAlert.URL,
	// 	)
	// }()

	// 5. Start Kill Switch Poller (requires signed ticket from Broker)
	wg.Add(1)
	go func() {
		defer wg.Done()
		pollKillSwitch(ctx, cancel, cfg, s, ic, ticketVerifier, stateDir)
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
					"id":             "sentinel-a",
				}
				envelope, _, err := s.SignEvent(event)
				if err != nil {
					log.Printf("[selfmon] Failed to sign heartbeat event: %v", err)
					continue
				}
				payload, err := signer.MarshalEnvelope(envelope)
				if err != nil {
					log.Printf("[heartbeat] Failed to marshal heartbeat envelope: %v — skipping", err)
					continue
				}

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

	log.Printf("Shutting down (signal: %v)", sig)

	cancel()
	wg.Wait()
}

// verifyIngestionWithRetry checks that the ingestion service is reachable and healthy
// before the Sentinel daemon enters its main event loop.
//
// Strategy:
//   - Exponential backoff: 1s → 2s → 4s → 8s → ... capped at 30s per sleep
//   - Total retry window capped at 10 minutes from first attempt
//   - Requires HTTP 200 or 204 response (connectivity alone is not sufficient)
//   - Tries /health endpoint; falls back to base URL on 404
func verifyIngestionWithRetry(ctx context.Context, ic *ingestclient.Client, baseURL string) error {
	const maxElapsed = 10 * time.Minute
	const initialDelay = 1 * time.Second
	const maxDelay = 30 * time.Second

	baseUrlClean := strings.TrimSuffix(strings.TrimRight(baseURL, "/"), "/ingest")
	healthURL := baseUrlClean + "/health"
	deadline := time.Now().Add(maxElapsed)
	delay := initialDelay
	attempt := 0

	for {
		attempt++
		err := checkIngestionEndpoint(ctx, ic.HTTPClient(), healthURL)
		if err == nil {
			log.Printf("[boot] Ingestion service reachable after %d attempt(s)", attempt)
			return nil
		}

		log.Printf("[boot] Ingestion check attempt %d failed: %v", attempt, err)

		if time.Now().After(deadline) {
			return fmt.Errorf("ingestion service unreachable after %s: %w", maxElapsed, err)
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("ingestion check cancelled: %w", ctx.Err())
		case <-time.After(delay):
		}

		delay *= 2
		if delay > maxDelay {
			delay = maxDelay
		}
	}
}

// checkIngestionEndpoint performs a single GET to the given URL and validates the status code.
func checkIngestionEndpoint(ctx context.Context, hc *http.Client, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}

	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return fmt.Errorf("unexpected status: %s", resp.Status)
}

func pollKillSwitch(ctx context.Context, cancel context.CancelFunc, cfg *config.Config, s *signer.Signer, ic *ingestclient.Client, verifier *auth.Verifier, stateDir string) {
	oobUrl := cfg.OOBAlert.URL
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Fetch signed killswitch ticket from Ingestion Service via mTLS
			ticketStr, err := auth.GetKillSwitch(ctx, ic)
			if err != nil {
				log.Printf("[killswitch] Polling failed: %v", err)
				continue 
			}

			if ticketStr == "" {
				continue // No active killswitch
			}

			ticketJSON := []byte(strings.TrimSpace(ticketStr))

			// Verify the signed ticket cryptographically
			if verifier == nil {
				log.Println("Kill switch ticket found but no verifier configured — ignoring")
				continue
			}

			ticket, err := verifier.VerifyFromJSON(ticketJSON, auth.ActionKillSwitch)
			if err != nil {
				log.Printf("KILL SWITCH TICKET REJECTED: %v", err)
				sendOOBAlert(ctx, ic, oobUrl, map[string]interface{}{
					"type":  "INVALID_KILLSWITCH_TICKET",
					"error": err.Error(),
					"host":  os.Getenv("HOSTNAME"),
				})
				continue
			}

			log.Printf("Kill switch AUTHORIZED: issuer=%s nonce=%s", ticket.Issuer, ticket.Nonce)

			// Start inotify fallback (If systemd available)
			if sysutil.IsCommandAvailable("systemctl") {
				if err := exec.Command("systemctl", "start", "canary-inotify-watcher").Run(); err != nil {
					log.Printf("[killswitch] Failed to start canary-inotify-watcher: %v (non-fatal)", err)
				}
			} else {
				log.Println("[INFO] systemctl not found — skipping inotify fallback start")
			}

			// Emit signed events
			sendOOBAlert(ctx, ic, oobUrl, map[string]interface{}{
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
			envelope, _, err := s.SignEvent(degEvent)
			if err != nil {
				log.Printf("[boot] Failed to sign degradation event: %v", err)
			} else if payload, err := signer.MarshalEnvelope(envelope); err != nil {
				log.Printf("[killswitch] Failed to marshal DEGRADED envelope: %v — skipping", err)
			} else if err := ic.Post(ctx, payload); err != nil {
				log.Printf("[killswitch] Failed to emit DEGRADED event: %v", err)
			}

			log.Println("KILL SWITCH TRIGGERED — SHUTTING DOWN")
			cancel() // triggers graceful shutdown
			return
		}
	}
}

// sendOOBAlert fires a JSON alert to the OOB webhook using the shared ingest client transport.
// It accepts a context so it can be cancelled during shutdown.
func sendOOBAlert(ctx context.Context, ic *ingestclient.Client, url string, payload map[string]interface{}) {
	payload["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[oob] Failed to marshal alert payload: %v", err)
		return
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		log.Printf("[oob] Failed to create OOB request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := ic.HTTPClient().Do(req)
	if err != nil {
		log.Printf("[oob] OOB alert delivery failed: %v", err)
		return
	}
	resp.Body.Close()
}
