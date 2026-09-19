// canary-system/src/canary_deployer/cmd/deployer/main.go
// Canary file deployer — generates and plants high-fidelity decoy files.
// Derived from: file-canary-engine/SKILL.md

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/your-org/canary/deployer/internal/deployer"
)

func main() {
	profileName := flag.String("profile", "", "Server profile name (e.g., app-server, db-server, k8s-node)")
	autoProfile := flag.Bool("auto-profile", false, "Auto-detect profile from hostname")
	dryRun := flag.Bool("dry-run", false, "Show what would be created without writing files")
	configDir := flag.String("config-dir", "/opt/canary/config", "Path to config directory")
	templateDir := flag.String("template-dir", "/opt/canary/templates", "Path to templates directory")
	flag.Parse()

	if *autoProfile {
		detected, err := deployer.DetectProfile(*configDir)
		if err != nil {
			log.Fatalf("Auto-profile detection failed: %v", err)
		}
		*profileName = detected
		log.Printf("Auto-detected profile: %s", *profileName)
	}

	if *profileName == "" {
		log.Fatal("--profile or --auto-profile is required")
	}

	// Load profile
	profile, err := deployer.LoadProfile(*configDir, *profileName)
	if err != nil {
		log.Fatalf("Failed to load profile: %v", err)
	}

	// Deploy canary files
	results, err := deployer.Deploy(profile, *templateDir, *dryRun)
	if err != nil {
		log.Fatalf("Deployment failed: %v", err)
	}

	// Write canary map
	canaryMap := deployer.CanaryMap{
		Version:     "1.0",
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Host:        hostname(),
		Canaries:    results,
	}

	if *dryRun {
		fmt.Println("=== DRY RUN — no files written ===")
		out, _ := json.MarshalIndent(canaryMap, "", "  ")
		fmt.Println(string(out))
		return
	}

	mapPath := fmt.Sprintf("%s/canary-map.json", *configDir)
	mapData, _ := json.MarshalIndent(canaryMap, "", "  ")
	if err := os.WriteFile(mapPath, mapData, 0644); err != nil {
		log.Fatalf("Failed to write canary map: %v", err)
	}

	log.Printf("Deployed %d canary files (map written to %s)", len(results), mapPath)
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}
