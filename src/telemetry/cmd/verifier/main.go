// canary-system/src/telemetry/cmd/verifier/main.go
// Chain verifier — validates Ed25519 signatures and Merkle chain integrity.
// Derived from: telemetry-bus/SKILL.md

package main

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/segmentio/kafka-go"
	"github.com/your-org/canary/chain-verifier/internal/verifier"
)

func main() {
	brokers := flag.String("brokers", "kafka-0:9092,kafka-1:9092", "Comma-separated Kafka broker list")
	topic := flag.String("topic", "canary-events", "Kafka topic to consume")
	groupID := flag.String("group", "verifier", "Kafka consumer group ID")
	keyDir := flag.String("key-dir", "/etc/canary/trusted-keys", "Directory of trusted Ed25519 public keys")
	last := flag.Int("last", 0, "Verify only the last N events, then exit (0 = continuous)")
	report := flag.Bool("report", false, "Print verification report and exit")
	flag.Parse()

	// Load trusted public keys
	pubKeys, err := loadPublicKeys(*keyDir)
	if err != nil {
		log.Fatalf("Failed to load public keys: %v", err)
	}
	log.Printf("Loaded %d trusted public keys", len(pubKeys))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		cancel()
	}()

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:  splitBrokers(*brokers),
		Topic:    *topic,
		GroupID:  *groupID,
		MinBytes: 1,
		MaxBytes: 10e6,
	})
	defer reader.Close()

	cv := verifier.New(pubKeys)

	if *last > 0 || *report {
		results := cv.VerifyBatch(ctx, reader, *last)
		printReport(results)
		return
	}

	// Continuous verification
	log.Println("Starting continuous chain verification...")
	cv.VerifyContinuous(ctx, reader)
}

func loadPublicKeys(dir string) (map[string]ed25519.PublicKey, error) {
	keys := make(map[string]ed25519.PublicKey)

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read key dir: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(fmt.Sprintf("%s/%s", dir, entry.Name()))
		if err != nil {
			continue
		}
		if len(data) == ed25519.PublicKeySize {
			keys[entry.Name()] = ed25519.PublicKey(data)
		} else if len(data) == ed25519.PublicKeySize*2 {
			// Hex-encoded
			decoded, err := hex.DecodeString(string(data))
			if err == nil {
				keys[entry.Name()] = ed25519.PublicKey(decoded)
			}
		}
	}

	return keys, nil
}

func splitBrokers(s string) []string {
	var result []string
	for _, b := range splitCommaList(s) {
		if b != "" {
			result = append(result, b)
		}
	}
	return result
}

func splitCommaList(s string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	parts = append(parts, s[start:])
	return parts
}

func printReport(results verifier.BatchResults) {
	fmt.Println("=== Chain Verification Report ===")
	fmt.Printf("Events verified:   %d\n", results.Total)
	fmt.Printf("Signatures valid:  %d\n", results.ValidSigs)
	fmt.Printf("Signatures failed: %d\n", results.FailedSigs)
	fmt.Printf("Sequence gaps:     %d\n", results.SequenceGaps)
	fmt.Printf("Chain breaks:      %d\n", results.ChainBreaks)
	if results.Total > 0 && results.FailedSigs == 0 && results.SequenceGaps == 0 && results.ChainBreaks == 0 {
		fmt.Println("Status: ✓ All checks passed")
	} else {
		fmt.Println("Status: ✗ Issues detected — investigate alerts")
	}
}
