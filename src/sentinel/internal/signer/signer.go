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
	"sync/atomic"
	"time"

	"github.com/your-org/canary/sentinel/internal/config"
	"github.com/your-org/canary/sentinel/internal/vault"
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
	switch strings.ToLower(cfg.KeySource) {
	case "vault":
		// Fetch private key from Vault (held in memory only) via API library
		vc, err := vault.New()
		if err != nil {
			return nil, fmt.Errorf("init vault client: %w", err)
		}

		keyStr, err := vc.GetSecretField(cfg.VaultPath, cfg.VaultField)
		if err != nil {
			return nil, fmt.Errorf("vault signing key: %w", err)
		}
		
		keyBytes, err := hex.DecodeString(strings.TrimSpace(keyStr))
		if err != nil {
			return nil, fmt.Errorf("decode vault key (hex expected): %w", err)
		}
		
		if len(keyBytes) != ed25519.PrivateKeySize {
			return nil, fmt.Errorf("invalid ed25519 private key size: got %d, want %d", len(keyBytes), ed25519.PrivateKeySize)
		}
		
		privKey = ed25519.PrivateKey(keyBytes)
		pub := privKey.Public().(ed25519.PublicKey)
		hash := sha256.Sum256(pub)
		pubKeyFP = hex.EncodeToString(hash[:8])

	default:
		return nil, fmt.Errorf("unsupported key_source: %s (only 'vault' is supported)", cfg.KeySource)
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
