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

	"github.com/your-org/canary/sentinel/internal/cleanup"
	"github.com/your-org/canary/sentinel/internal/deployer"
	"github.com/your-org/canary/sentinel/internal/ingestclient"
	"github.com/your-org/canary/sentinel/internal/signer"
)

// StartDaemon runs the continuous canary deployment and rotation loop.
func StartDaemon(ctx context.Context, profileName, configDir, templateDir string, intervalSec, maxJitterSec int, s *signer.Signer, ic *ingestclient.Client, onDeploy func([]string)) {
	profile, err := deployer.LoadProfile(configDir, profileName)
	if err != nil {
		log.Printf("Deployer Daemon: failed to load profile %s: %v", profileName, err)
		return
	}

	log.Printf("Canary Deployer Daemon started (Profile: %s, Mode: In-Memory)", profileName)

	// Remove leftovers the backend still lists for this server (e.g. a previous sentinel was
	// killed, or this host was re-added and merged into an earlier record). Non-fatal: the
	// brute-force pass below still runs if the backend is unreachable. Runs every rotation too,
	// because a merge is recorded asynchronously after startup.
	sweep := func(active []deployer.CanaryEntry) {
		sweepCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		ids, paths := map[string]bool{}, map[string]bool{}
		for _, c := range active { // never sweep what this sentinel has planted and is tracking
			ids[strings.ToLower(c.ID)], paths[c.Path] = true, true
		}
		fetch := func(c context.Context) ([]cleanup.Entry, error) {
			entries, err := cleanup.Fetch(c, ic)
			return cleanup.Without(entries, ids, paths), err
		}
		if n, err := cleanup.Sweep(sweepCtx, fetch, s, ic); err != nil {
			log.Printf("Deployer Daemon: backend canary cleanup incomplete (resolved %d): %v", n, err)
		} else if n > 0 {
			log.Printf("Deployer Daemon: removed %d leftover canaries listed by the backend", n)
		}
	}

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
			// 2b. Remove anything else the backend still lists for this server (cheap GET).
			sweep(activeCanaries)

			// 3. Deploy New Canaries
			newCanaries, err := deployer.Deploy(profile, templateDir, false)
			if err != nil {
				log.Printf("Deployer Daemon: error during deployment: %v — keeping existing canaries", err)
			} else {
				// 2. Remove previous canaries using in-memory state only after successful deploy
				removeStale(activeCanaries, newCanaries)
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

				envelope, _, err := s.SignEvent(event)
				if err != nil {
					log.Printf("Deployer Daemon: failed to sign canary map: %v", err)
				} else if payload, err := signer.MarshalEnvelope(envelope); err != nil {
					log.Printf("Deployer Daemon: failed to marshal canary map envelope: %v", err)
				} else if err := ic.Post(ctx, payload); err != nil {
					log.Printf("Deployer Daemon: failed to emit map: %v", err)
				} else {
					log.Printf("Deployer Daemon: rotated %d canaries. Signed map sent to Ingestion Service.", len(newCanaries))
					
					// C-01: Broadcast the new paths to the auditmon workers
					if onDeploy != nil {
						var paths []string
						for _, c := range newCanaries {
							paths = append(paths, c.Path)
						}
						onDeploy(paths)
					}
				}
			}

			// 5. Sleep with Jitter
			jitter, err := rand.Int(rand.Reader, big.NewInt(int64(maxJitterSec)))
			var sleepDur time.Duration
			if err != nil {
				log.Printf("Deployer Daemon: rand.Int failed, sleeping without jitter: %v", err)
				sleepDur = time.Duration(intervalSec) * time.Second
			} else {
				sleepDur = time.Duration(intervalSec+int(jitter.Int64())) * time.Second
			}
			select {
			case <-time.After(sleepDur):
			case <-ctx.Done():
				return
			}
		}
	}
}

// removeStale deletes previous canaries whose path is not reused by the new set. Deploy
// overwrites a reused path in place, so removing it afterwards would delete the fresh decoy.
func removeStale(old, fresh []deployer.CanaryEntry) {
	keep := make(map[string]bool, len(fresh))
	for _, c := range fresh {
		keep[c.Path] = true
	}
	for _, c := range old {
		if !keep[c.Path] {
			_ = os.Remove(c.Path)
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
			n, err := f.Read(buf)
			f.Close()
			if err != nil && n == 0 {
				continue
			}

			if n > 0 && strings.Contains(string(buf[:n]), "__CANARY_ID__=") {
				if err := os.Remove(filePath); err != nil {
					log.Printf("Deployer Daemon: failed to remove orphan canary %s: %v", filePath, err)
				}
			}
		}
	}
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}
