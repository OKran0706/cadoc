// canary-system/src/canary_deployer/cmd/rotator/main.go
// Canary file rotator — replaces existing canary files on a jittered schedule.
// Derived from: file-canary-engine/SKILL.md

package main

import (
	"crypto/rand"
	"encoding/json"
	"flag"
	"log"
	"math/big"
	"os"
	"time"

	"github.com/your-org/canary/deployer/internal/deployer"
)

func main() {
	profileName := flag.String("profile", "auto", "Server profile name")
	configDir := flag.String("config-dir", "/opt/canary/config", "Path to config directory")
	templateDir := flag.String("template-dir", "/opt/canary/templates", "Path to templates directory")
	maxJitterSec := flag.Int("max-jitter", 3600, "Maximum random sleep before rotating (seconds)")
	flag.Parse()

	// Random jitter to prevent predictable rotation windows
	if *maxJitterSec > 0 {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(*maxJitterSec)))
		jitter := time.Duration(n.Int64()) * time.Second
		log.Printf("Sleeping %v before rotation (jitter)", jitter)
		time.Sleep(jitter)
	}

	// Auto-detect profile if needed
	if *profileName == "auto" {
		detected, err := deployer.DetectProfile(*configDir)
		if err != nil {
			log.Fatalf("Auto-profile detection failed: %v", err)
		}
		*profileName = detected
	}

	// Load current canary map
	mapPath := *configDir + "/canary-map.json"
	mapData, err := os.ReadFile(mapPath)
	if err != nil {
		log.Fatalf("Failed to read canary map: %v", err)
	}

	var currentMap deployer.CanaryMap
	if err := json.Unmarshal(mapData, &currentMap); err != nil {
		log.Fatalf("Failed to parse canary map: %v", err)
	}

	// Load profile
	profile, err := deployer.LoadProfile(*configDir, *profileName)
	if err != nil {
		log.Fatalf("Failed to load profile: %v", err)
	}

	// Step 1: Deploy new canary files (without removing old ones yet)
	newResults, err := deployer.Deploy(profile, *templateDir, false)
	if err != nil {
		log.Fatalf("Rotation deployment failed: %v", err)
	}
	log.Printf("Deployed %d new canary files", len(newResults))

	// Step 2: Remove old canary files
	removed := 0
	for _, old := range currentMap.Canaries {
		if err := os.Remove(old.Path); err != nil {
			log.Printf("Warning: could not remove old canary %s: %v", old.Path, err)
		} else {
			removed++
		}
	}
	log.Printf("Removed %d old canary files", removed)

	// Step 3: Write updated canary map
	updatedMap := deployer.CanaryMap{
		Version:     "1.0",
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Host:        currentMap.Host,
		Canaries:    newResults,
	}
	updatedData, _ := json.MarshalIndent(updatedMap, "", "  ")
	if err := os.WriteFile(mapPath, updatedData, 0644); err != nil {
		log.Fatalf("Failed to write updated canary map: %v", err)
	}

	log.Printf("Rotation complete: %d new canaries replacing %d old canaries", len(newResults), removed)
}
