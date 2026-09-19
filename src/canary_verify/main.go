// canary-system/src/canary_verify/main.go
// Independent verification agent for the Canary System.
// Runs as 'canary-verify' user, zero capabilities.
// Monitors sentinel-a, sentinel-b, Vector, and Tetragon policy state.

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

type Config struct {
	WebhookURL      string
	Hostname        string
	SentinelBinaryA string
	SentinelBinaryB string
}

func main() {
	cfg := Config{
		WebhookURL:      os.Getenv("CANARY_WEBHOOK_URL"),
		Hostname:        os.Getenv("HOSTNAME"),
		SentinelBinaryA: "/opt/sentinel/bin/sentinel-a",
		SentinelBinaryB: "/opt/sentinel/bin/sentinel-b",
	}

	if cfg.WebhookURL == "" {
		log.Fatal("CANARY_WEBHOOK_URL is required")
	}

	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	log.Println("Verifier agent started")

	// Run immediately on start
	runChecks(cfg)

	for range ticker.C {
		runChecks(cfg)
	}
}

func runChecks(cfg Config) {
	anomalies := make([]string, 0)

	// 1. Check if processes are running
	expectedProcs := []string{"canary-sentinel-a", "canary-sentinel-b", "vector"}
	for _, proc := range expectedProcs {
		if !isProcessRunning(proc) {
			anomalies = append(anomalies, fmt.Sprintf("%s is not running", proc))
		}
	}

	// 2. Check Tetragon policy
	if !isTetragonPolicyLoaded("sentinel-self-protection") {
		anomalies = append(anomalies, "Tetragon tracing policy 'sentinel-self-protection' not loaded")
	}

	// 3. Check binary hashes on disk
	binaries := map[string]string{
		"sentinel-a": cfg.SentinelBinaryA,
		"sentinel-b": cfg.SentinelBinaryB,
	}
	
	for name, path := range binaries {
		hash, err := hashFile(path)
		if err != nil {
			anomalies = append(anomalies, fmt.Sprintf("failed to hash %s: %v", name, err))
			continue
		}
		
		// In production, we'd verify this against the immutable log via API.
		// For the agent, we just report the current hash. If it changes unexpectedly,
		// the detection engine fires BINARY_TAMPERED.
		log.Printf("Hash of %s: %s", name, hash)
	}

	// 4. Report results
	if len(anomalies) > 0 {
		payload := map[string]interface{}{
			"type":      "VERIFIER_ANOMALY",
			"host":      cfg.Hostname,
			"anomalies": anomalies,
			"ts":        time.Now().UTC().Format(time.RFC3339Nano),
		}
		postWebhook(cfg.WebhookURL, payload)
	} else {
		payload := map[string]interface{}{
			"type": "VERIFIER_HEARTBEAT",
			"host": cfg.Hostname,
			"ts":   time.Now().UTC().Format(time.RFC3339Nano),
		}
		postWebhook(cfg.WebhookURL, payload)
	}
}

func isProcessRunning(name string) bool {
	// Simple lookup via pgrep since verifier runs unprivileged
	cmd := exec.Command("pgrep", "-f", name)
	err := cmd.Run()
	return err == nil
}

func isTetragonPolicyLoaded(policyName string) bool {
	// Unprivileged check via tetra CLI
	cmd := exec.Command("tetra", "tracingpolicy", "list")
	out, err := cmd.Output()
	if err != nil {
		log.Printf("Failed to list tetragon policies: %v", err)
		return false
	}
	return strings.Contains(string(out), policyName)
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func postWebhook(url string, payload map[string]interface{}) {
	body, _ := json.Marshal(payload)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("Webhook post failed: %v", err)
		return
	}
	defer resp.Body.Close()
	log.Printf("Posted %s (status %d)", payload["type"], resp.StatusCode)
}
