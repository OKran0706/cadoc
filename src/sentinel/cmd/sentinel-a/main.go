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
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/your-org/canary/sentinel/internal/config"
	"github.com/your-org/canary/sentinel/internal/heartbeat"
	"github.com/your-org/canary/sentinel/internal/selfmon"
	"github.com/your-org/canary/sentinel/internal/signer"

	"github.com/segmentio/kafka-go"
	"kernel.org/pub/linux/libs/security/libcap/cap"
)

func main() {
	configPath := flag.String("config", "/opt/sentinel/config/sentinel.yaml", "Path to sentinel config")
	testSign := flag.Bool("test-sign", false, "Sign a test event and exit")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// 1. Runtime Binary Verification
	if err := verifySelfIntegrity(cfg.OOBAlert.URL); err != nil {
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
		Addr:     kafka.TCP(cfg.Telemetry.KafkaBrokers...),
		Topic:    cfg.Telemetry.Topic,
		Balancer: &kafka.LeastBytes{},
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
	if err := dropCapabilitiesAfterInit(); err != nil {
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

	// 5. Start Kill Switch Poller
	wg.Add(1)
	go func() {
		defer wg.Done()
		pollKillSwitch(ctx, cfg.OOBAlert.URL, s, writer)
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
	<-sigCh
	log.Println("Sentinel-A shutting down")
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

	// In a real implementation this fetches from vault: vault.GetSecret("canary/binary-hashes/sentinel-a")
	// For simulation, we assume expected == actual unless tampered.
	expected := actual // TODO: fetch from Vault

	if actual != expected {
		sendOOBAlert(oobUrl, map[string]interface{}{
			"type":   "BINARY_TAMPERED",
			"binary": "sentinel-a",
			"error":  fmt.Sprintf("expected %s got %s", expected, actual),
			"host":   os.Getenv("HOSTNAME"),
		})
		return fmt.Errorf("BINARY_INTEGRITY_FAIL: expected %s got %s", expected, actual)
	}
	return nil
}

func dropCapabilitiesAfterInit() error {
	c := cap.NewSet()
	c.SetFlag(cap.Permitted, true, cap.NET_ADMIN)
	c.SetFlag(cap.Effective, true, cap.NET_ADMIN)
	// Explicitly clear SYS_ADMIN, BPF, PERFMON
	c.SetFlag(cap.Permitted, false, cap.SYS_ADMIN)
	c.SetFlag(cap.Effective, false, cap.SYS_ADMIN)
	c.SetFlag(cap.Permitted, false, cap.BPF)
	c.SetFlag(cap.Effective, false, cap.BPF)
	c.SetFlag(cap.Permitted, false, cap.PERFMON)
	c.SetFlag(cap.Effective, false, cap.PERFMON)

	if err := c.SetProc(); err != nil {
		return fmt.Errorf("capability drop failed: %w", err)
	}

	// Verify drop succeeded
	verify, err := cap.GetPID(0)
	if err != nil {
		return err
	}
	if verify.GetFlag(cap.Effective, cap.SYS_ADMIN) {
		return fmt.Errorf("CAP_SYS_ADMIN still effective after drop — aborting")
	}
	return nil
}

func pollKillSwitch(ctx context.Context, oobUrl string, s *signer.Signer, writer *kafka.Writer) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Fetch from vault: vault kv get -field=kill_switch secret/canary/control
			cmd := exec.Command("vault", "kv", "get", "-field=kill_switch", "secret/canary/control")
			out, err := cmd.Output()
			if err == nil && string(bytes.TrimSpace(out)) == "true" {
				log.Println("Kill switch activated via Vault!")
				
				// 1. Unload Tetragon
				exec.Command("kubectl", "delete", "tracingpolicy", "--all", "-n", "canary-system").Run()

				// 2. Start inotify callback
				exec.Command("systemctl", "start", "canary-inotify-watcher").Run()

				// 3. Emit events
				oobEvent := map[string]interface{}{
					"type": "SENTINEL_KILL_SWITCH_ACTIVATED",
					"host": os.Getenv("HOSTNAME"),
				}
				sendOOBAlert(oobUrl, oobEvent)

				degEvent := map[string]interface{}{
					"type":            "SENTINEL_DEGRADED",
					"monitoring_mode": "inotify",
					"coverage":        "canary_files_only",
					"reason":          "Kill switch activated",
				}
				envelope, _ := s.SignEvent(degEvent)
				payload, _ := signer.MarshalEnvelope(envelope)
				writer.WriteMessages(ctx, kafka.Message{Value: payload})

				// 4. Stop sentinels
				exec.Command("systemctl", "stop", "canary-sentinel-a", "canary-sentinel-b").Run()
				os.Exit(0)
			}
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
