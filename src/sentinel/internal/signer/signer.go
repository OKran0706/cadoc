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
	"sync"
	"sync/atomic"
	"time"

	"github.com/your-org/canary/sentinel/internal/config"
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

// New creates a Signer from the signing configuration.
// Supports key_source: "file" | "tpm" | "vault"
func New(cfg config.SigningConfig) (*Signer, error) {
	hostname, _ := os.Hostname()

	var privKey ed25519.PrivateKey
	var pubKeyFP string

	switch cfg.KeySource {
	case "file":
		keyBytes, err := os.ReadFile(cfg.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("read signing key: %w", err)
		}
		privKey = ed25519.PrivateKey(keyBytes)
		pub := privKey.Public().(ed25519.PublicKey)
		hash := sha256.Sum256(pub)
		pubKeyFP = hex.EncodeToString(hash[:8])

	case "tpm":
		// TPM signing placeholder — in production, use go-tpm2 library
		// to load the persistent handle and sign via TPM2_Sign
		return nil, fmt.Errorf("TPM signing not yet implemented — use key_source: file")

	case "vault":
		// Vault transit engine placeholder — fetch key via Vault API
		return nil, fmt.Errorf("Vault signing not yet implemented — use key_source: file")

	default:
		return nil, fmt.Errorf("unknown key_source: %s", cfg.KeySource)
	}

	return &Signer{
		privKey:  privKey,
		pubKeyFP: pubKeyFP,
		hostname: hostname,
	}, nil
}

// SignEvent signs an event and chains it to the previous event.
// Returns the signed envelope and the event hash (for chaining).
func (s *Signer) SignEvent(event map[string]interface{}) (map[string]interface{}, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	event["prev_hash"] = s.prevHash
	event["seq"] = atomic.AddUint64(&s.sequence, 1)
	event["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	event["host"] = s.hostname

	// Canonical JSON (Go's json.Marshal sorts map keys)
	canonical, _ := json.Marshal(event)

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
	return envelope, eventHash
}

// MarshalEnvelope serializes a signed envelope to JSON bytes.
func MarshalEnvelope(envelope map[string]interface{}) ([]byte, error) {
	return json.Marshal(envelope)
}
