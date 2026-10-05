// canary-system/src/sentinel/internal/auth/ticket.go
// Cryptographic authorization ticket verification for lifecycle operations.
// Tickets are short-lived, Ed25519-signed JSON documents that authorize
// deployment, redeployment, shutdown, and killswitch operations.
//
// The maintenance public key is fetched from Vault at startup and held
// in process memory only — no on-disk key file to tamper with.

package auth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

// Action represents a lifecycle operation that can be authorized.
type Action string

const (
	ActionKillSwitch Action = "KILLSWITCH_ACTIVATE"
)

// DefaultMaxTicketAge is the maximum allowed age for a ticket.
const DefaultMaxTicketAge = 10 * time.Minute

// Ticket represents a signed authorization for a lifecycle operation.
type Ticket struct {
	Action    Action `json:"action"`
	Target    string `json:"target"`    // hostname or "*" for any host
	Binary    string `json:"binary"`    // target binary (e.g., "sentinel-a") or "*"
	NewHash   string `json:"new_hash"`  // expected SHA256 of new binary (for REDEPLOY)
	IssuedAt  string `json:"iat"`       // RFC3339 issuance timestamp
	ExpiresAt string `json:"exp"`       // RFC3339 expiration timestamp
	Issuer    string `json:"issuer"`    // human-readable issuer name
	Nonce     string `json:"nonce"`     // unique nonce to prevent replay
}

// SignedTicket wraps a ticket with its Ed25519 signature.
type SignedTicket struct {
	Payload   string `json:"payload"`   // canonical JSON of Ticket
	Signature string `json:"signature"` // hex-encoded Ed25519 signature
	KeyID     string `json:"key_id"`    // hex fingerprint of the signing public key
}

// Verifier validates signed authorization tickets.
// The public key is held in memory only — never written to disk.
type Verifier struct {
	pubKey     ed25519.PublicKey
	keyID      string
	hostname   string
	usedNonces map[string]time.Time
	mu         sync.RWMutex
}

// NewVerifierFromBytes creates a Verifier from raw Ed25519 public key bytes.
// This is the primary constructor — key bytes are fetched from Vault and
// passed directly, never touching the filesystem.
func NewVerifierFromBytes(pubKeyBytes []byte) (*Verifier, error) {
	if len(pubKeyBytes) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid maintenance pubkey size: expected %d bytes, got %d",
			ed25519.PublicKeySize, len(pubKeyBytes))
	}

	pubKey := ed25519.PublicKey(pubKeyBytes)

	// Compute fingerprint (first 8 bytes of SHA256 of pubkey, hex-encoded)
	fpHash := sha256.Sum256(pubKey)
	keyID := hex.EncodeToString(fpHash[:8])

	hostname, _ := os.Hostname()

	return &Verifier{
		pubKey:     pubKey,
		keyID:      keyID,
		hostname:   hostname,
		usedNonces: make(map[string]time.Time),
	}, nil
}

// KeyID returns the fingerprint of the loaded public key (for audit logging).
func (v *Verifier) KeyID() string {
	return v.keyID
}

// Verify validates a signed ticket and returns the parsed Ticket if valid.
// Checks: signature, expiration, target scope, action, nonce replay.
func (v *Verifier) Verify(signed *SignedTicket, expectedAction Action) (*Ticket, error) {
	// 1. Verify Ed25519 signature
	sigBytes, err := hex.DecodeString(signed.Signature)
	if err != nil {
		return nil, fmt.Errorf("invalid signature encoding: %w", err)
	}

	payloadBytes := []byte(signed.Payload)
	if !ed25519.Verify(v.pubKey, payloadBytes, sigBytes) {
		return nil, fmt.Errorf("SIGNATURE_INVALID: ticket signature verification failed")
	}

	// 2. Parse ticket payload
	var ticket Ticket
	if err := json.Unmarshal(payloadBytes, &ticket); err != nil {
		return nil, fmt.Errorf("invalid ticket payload: %w", err)
	}

	// 3. Verify action matches expected
	if ticket.Action != expectedAction {
		return nil, fmt.Errorf("ACTION_MISMATCH: ticket authorizes %s, but %s was requested",
			ticket.Action, expectedAction)
	}

	// 4. Verify target scope
	if ticket.Target != "*" && ticket.Target != v.hostname {
		return nil, fmt.Errorf("TARGET_MISMATCH: ticket is for host %q, but this host is %q",
			ticket.Target, v.hostname)
	}

	// 5. Verify expiration
	expTime, err := time.Parse(time.RFC3339, ticket.ExpiresAt)
	if err != nil {
		return nil, fmt.Errorf("invalid expiration timestamp: %w", err)
	}
	if time.Now().UTC().After(expTime) {
		return nil, fmt.Errorf("TICKET_EXPIRED: ticket expired at %s", ticket.ExpiresAt)
	}

	// 6. Verify issuance time
	iatTime, err := time.Parse(time.RFC3339, ticket.IssuedAt)
	if err != nil {
		return nil, fmt.Errorf("invalid issuance timestamp: %w", err)
	}
	age := time.Since(iatTime)
	if age < -30*time.Second {
		return nil, fmt.Errorf("TICKET_FUTURE: ticket issued %v in the future", -age)
	}
	if age > DefaultMaxTicketAge {
		return nil, fmt.Errorf("TICKET_TOO_OLD: ticket issued %v ago (max %v)", age, DefaultMaxTicketAge)
	}

	// 7. Replay protection
	if ticket.Nonce == "" {
		return nil, fmt.Errorf("MISSING_NONCE: ticket must include a unique nonce")
	}
	v.mu.Lock()
	if _, used := v.usedNonces[ticket.Nonce]; used {
		v.mu.Unlock()
		return nil, fmt.Errorf("NONCE_REPLAY: ticket nonce %q has already been used", ticket.Nonce)
	}
	v.usedNonces[ticket.Nonce] = time.Now()
	v.mu.Unlock()

	// 8. Occasional cleanup (roughly every 100 verifications)
	if time.Now().Unix()%100 == 0 {
		v.cleanupNonces()
	}

	return &ticket, nil
}

// VerifyFromJSON parses a JSON-encoded signed ticket and verifies it.
// This is used when the ticket is passed directly via CLI or Vault
// without creating an intermediate file on disk.
func (v *Verifier) VerifyFromJSON(ticketJSON []byte, expectedAction Action) (*Ticket, error) {
	var signed SignedTicket
	if err := json.Unmarshal(ticketJSON, &signed); err != nil {
		return nil, fmt.Errorf("parse ticket json: %w", err)
	}

	return v.Verify(&signed, expectedAction)
}

// cleanupNonces removes nonces older than 1 hour.
func (v *Verifier) cleanupNonces() {
	v.mu.Lock()
	defer v.mu.Unlock()
	cutoff := time.Now().Add(-1 * time.Hour)
	for nonce, ts := range v.usedNonces {
		if ts.Before(cutoff) {
			delete(v.usedNonces, nonce)
		}
	}
}
