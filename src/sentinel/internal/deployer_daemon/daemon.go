// canary-system/src/sentinel/internal/deployer_daemon/daemon.go
// Internal deployer daemon for Sentinel-A.

package deployer_daemon

import (
	"context"
	"crypto/rand"
	"log"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/your-org/canary/sentinel/internal/deployer"
	"github.com/your-org/canary/sentinel/internal/ingestclient"
	"github.com/your-org/canary/sentinel/internal/signer"
)

// StartDaemon runs the continuous canary deployment and rotation loop.
func StartDaemon(ctx context.Context, profileName, configDir, templateDir string, intervalSec, maxJitterSec int, s *signer.Signer, ic *ingestclient.Client) {
	profile, err := deployer.LoadProfile(configDir, profileName)
	if err != nil {
		log.Printf("Deployer Daemon: failed to load profile %s: %v", profileName, err)
		return
	}

	log.Printf("Canary Deployer Daemon started (Profile: %s, Mode: In-Memory)", profileName)

	// 1. One-time brute-force cleanup on startup to remove orphans from previous runs
	log.Println("Deployer Daemon: performing startup cleanup of orphaned canaries...")
	removeOldCanariesBruteForce(profile)

	var activeCanaries []deployer.CanaryEntry

	for {
		select {
		case <-ctx.Done():
			log.Println("Canary Deployer Daemon stopping...")
			return
		default:
			// 2. Remove previous canaries using in-memory state
			for _, c := range activeCanaries {
				_ = os.Remove(c.Path)
			}

			// 3. Deploy New Canaries
			newCanaries, err := deployer.Deploy(profile, templateDir, false)
			if err != nil {
				log.Printf("Deployer Daemon: error during deployment: %v", err)
			} else {
				activeCanaries = newCanaries

				// 4. Build and Emit the Map Event
				canaryMap := deployer.CanaryMap{
					Version:     "1.2",
					GeneratedAt: time.Now().UTC().Format(time.RFC3339),
					Host:        hostname(),
					Canaries:    newCanaries,
				}
				event := map[string]interface{}{
					"type": "CANARY_MAP_DEPLOYED",
					"map":  canaryMap,
				}

				envelope, _ := s.SignEvent(event)
				payload, _ := signer.MarshalEnvelope(envelope)

				if err := ic.Post(ctx, payload); err != nil {
					log.Printf("Deployer Daemon: failed to emit map: %v", err)
				} else {
					log.Printf("Deployer Daemon: rotated %d canaries. Signed map sent to Ingestion Service.", len(newCanaries))
				}
			}

			// 5. Sleep with Jitter
			jitter, _ := rand.Int(rand.Reader, big.NewInt(int64(maxJitterSec)))
			sleepDur := time.Duration(intervalSec+int(jitter.Int64())) * time.Second
			select {
			case <-time.After(sleepDur):
			case <-ctx.Done():
				return
			}
		}
	}
}

func removeOldCanariesBruteForce(profile *deployer.Profile) {
	for _, target := range profile.TargetDirectories {
		files, err := os.ReadDir(target.Path)
		if err != nil {
			continue
		}
		for _, file := range files {
			if file.IsDir() {
				continue
			}
			filePath := filepath.Join(target.Path, file.Name())
			// Only read small chunk to check for marker
			f, err := os.Open(filePath)
			if err != nil {
				continue
			}
			buf := make([]byte, 4096)
			n, _ := f.Read(buf)
			f.Close()

			if n > 0 && strings.Contains(string(buf[:n]), "__CANARY_ID__=") {
				_ = os.Remove(filePath)
			}
		}
	}
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}
