// canary-system/src/sentinel/internal/signer/signer.go
// Ed25519 event signing with Merkle chain integrity.
// Derived from: sentinel-daemon/SKILL.md

package signer

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Signer handles Ed25519 signing and Merkle chaining of events.
type Signer struct {
	privKey          ed25519.PrivateKey
	pubKeyFP         string // public key fingerprint (hex of first 16 bytes)
	prevHash         string
	sequence         uint64
	mu               sync.Mutex
	hostname         string
}

// New creates a Signer from a raw hex private key.
func New(privateKeyHex string) (*Signer, error) {
	hostname, _ := os.Hostname()

	if privateKeyHex == "" {
		return nil, fmt.Errorf("private key hex is required for Signer")
	}

	keyBytes, err := hex.DecodeString(strings.TrimSpace(privateKeyHex))
	if err != nil {
		return nil, fmt.Errorf("decode signer key (hex expected): %w", err)
	}

	privKey, pubKeyFP, err := loadKeyBytes(keyBytes)
	if err != nil {
		return nil, err
	}

	return &Signer{
		privKey:  privKey,
		pubKeyFP: pubKeyFP,
		hostname: hostname,
	}, nil
}

// loadKeyBytes converts a raw byte slice into a valid Ed25519 key and fingerprint.
func loadKeyBytes(keyBytes []byte) (ed25519.PrivateKey, string, error) {
	var privKey ed25519.PrivateKey
	if len(keyBytes) == ed25519.SeedSize {
		privKey = ed25519.NewKeyFromSeed(keyBytes)
	} else if len(keyBytes) == ed25519.PrivateKeySize {
		privKey = ed25519.PrivateKey(keyBytes)
	} else {
		return nil, "", fmt.Errorf("invalid ed25519 private key size: got %d, want 32 (seed) or 64 (full key)", len(keyBytes))
	}

	pub := privKey.Public().(ed25519.PublicKey)
	hash := sha256.Sum256(pub)
	pubKeyFP := hex.EncodeToString(hash[:8])
	return privKey, pubKeyFP, nil
}

// SignEvent signs an event and chains it to the previous event.
// Returns the signed envelope, the event hash (for chaining), and any error.
func (s *Signer) SignEvent(event map[string]interface{}) (map[string]interface{}, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	event["prev_hash"] = s.prevHash
	s.sequence++
	event["seq"] = s.sequence
	event["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	event["host"] = s.hostname

	// Canonical JSON (Go's json.Marshal sorts map keys)
	canonical, err := json.Marshal(event)
	if err != nil {
		return nil, "", fmt.Errorf("marshal event: %w", err)
	}

	hash := sha256.Sum256(canonical)
	eventHash := hex.EncodeToString(hash[:])

	sig := ed25519.Sign(s.privKey, canonical)

	s.prevHash = eventHash

	envelope := map[string]interface{}{
		"payload":   string(canonical),
		"hash":      eventHash,
		"signature": hex.EncodeToString(sig),
		"key_id":    s.pubKeyFP,
	}
	return envelope, eventHash, nil
}

// MarshalEnvelope serializes a signed envelope to JSON bytes.
func MarshalEnvelope(envelope map[string]interface{}) ([]byte, error) {
	return json.Marshal(envelope)
}
