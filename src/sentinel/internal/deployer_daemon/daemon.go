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

	"github.com/segmentio/kafka-go"
	"github.com/your-org/canary/sentinel/internal/deployer"
	"github.com/your-org/canary/sentinel/internal/signer"
)

// StartDaemon runs the continuous canary deployment and rotation loop.
func StartDaemon(ctx context.Context, profileName, configDir, templateDir string, intervalSec, maxJitterSec int, s *signer.Signer, writer *kafka.Writer) {
	profile, err := deployer.LoadProfile(configDir, profileName)
	if err != nil {
		log.Printf("Deployer Daemon: failed to load profile %s: %v", profileName, err)
		return
	}

	log.Printf("Canary Deployer Daemon started (Profile: %s, Interval: %ds)", profileName, intervalSec)

	for {
		select {
		case <-ctx.Done():
			log.Println("Canary Deployer Daemon stopping...")
			return
		default:
			// 1. Remove Old Canaries
			removed := removeOldCanaries(profile)

			// 2. Deploy New Canaries
			newCanaries, err := deployer.Deploy(profile, templateDir, false)
			if err != nil {
				log.Printf("Deployer Daemon: error during deployment: %v", err)
			} else {
				// 3. Build the Map
				canaryMap := deployer.CanaryMap{
					Version:     "1.0",
					GeneratedAt: time.Now().UTC().Format(time.RFC3339),
					Host:        hostname(),
					Canaries:    newCanaries,
				}

				// 4. Build the Event
				event := map[string]interface{}{
					"type": "CANARY_MAP_DEPLOYED",
					"map":  canaryMap,
				}

				// 5. Sign the Event using Sentinel's shared signer
				envelope, _ := s.SignEvent(event)
				payload, _ := signer.MarshalEnvelope(envelope)

				// 6. Emit to Kafka securely
				err = writer.WriteMessages(ctx, kafka.Message{
					Value: payload,
				})
				if err != nil {
					log.Printf("Deployer Daemon: failed to emit Canary Map to Kafka: %v", err)
				} else {
					log.Printf("Deployer Daemon: rotated %d canaries (removed %d). Signed map sent to Kafka.", len(newCanaries), removed)
				}
			}

			// 7. Sleep with Jitter
			jitter, _ := rand.Int(rand.Reader, big.NewInt(int64(maxJitterSec)))
			sleepDur := time.Duration(intervalSec+int(jitter.Int64())) * time.Second
			
			select {
			case <-time.After(sleepDur):
				// continue to next iteration
			case <-ctx.Done():
				return
			}
		}
	}
}

func removeOldCanaries(profile *deployer.Profile) int {
	removed := 0
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
			content, err := os.ReadFile(filePath)
			if err == nil && strings.Contains(string(content), "__CANARY_ID__=") {
				if err := os.Remove(filePath); err == nil {
					removed++
				}
			}
		}
	}
	return removed
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}
