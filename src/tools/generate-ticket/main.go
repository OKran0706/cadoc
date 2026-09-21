// canary-system/src/tools/generate-ticket/main.go
// Offline CLI tool for generating cryptographically signed authorization tickets.
// Run this on a secure workstation (NOT on the target host) to produce a
// signed JSON ticket that authorizes deployment, redeployment, shutdown,
// or killswitch operations on the canary system.
//
// Usage:
//   generate-ticket \
//     --key /path/to/maintenance.key \
//     --action SHUTDOWN \
//     --target app-server-1 \
//     --binary sentinel-a \
//     --ttl 5m \
//     --issuer "ops-team" \
//     --output ticket.json
//
//   # Then retrieve the ticket payload and pass it to sentinel:
//   TICKET_JSON=$(cat ticket.json)
//   ssh app-server-1 "/opt/sentinel/bin/sentinel-a --auth-ticket-json '${TICKET_JSON}' --action SHUTDOWN"

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"
)

// Ticket mirrors the structure in internal/auth/ticket.go.
type Ticket struct {
	Action    string `json:"action"`
	Target    string `json:"target"`
	Binary    string `json:"binary"`
	NewHash   string `json:"new_hash"`
	IssuedAt  string `json:"iat"`
	ExpiresAt string `json:"exp"`
	Issuer    string `json:"issuer"`
	Nonce     string `json:"nonce"`
}

// SignedTicket is the output envelope.
type SignedTicket struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
	KeyID     string `json:"key_id"`
}

var validActions = map[string]bool{
	"DEPLOY":              true,
	"REDEPLOY":            true,
	"SHUTDOWN":            true,
	"KILLSWITCH_ACTIVATE": true,
	"DEREGISTER":          true,
}

func main() {
	keyPath := flag.String("key", "", "Path to Ed25519 private key (64 bytes, required)")
	action := flag.String("action", "", "Action: DEPLOY, REDEPLOY, SHUTDOWN, DEREGISTER, KILLSWITCH_ACTIVATE (required)")
	target := flag.String("target", "*", "Target hostname or '*' for any host")
	binary := flag.String("binary", "*", "Target binary name or '*' for any binary")
	newHash := flag.String("new-hash", "", "SHA256 hash of new binary (required for REDEPLOY)")
	ttl := flag.Duration("ttl", 5*time.Minute, "Time-to-live for the ticket")
	issuer := flag.String("issuer", "", "Human-readable issuer name (required)")
	output := flag.String("output", "ticket.json", "Output path for the signed ticket")
	genKey := flag.Bool("generate-keypair", false, "Generate a new Ed25519 keypair and exit")
	keyOutDir := flag.String("key-out-dir", ".", "Directory for generated keypair files")
	flag.Parse()

	// --- Keypair generation mode ---
	if *genKey {
		generateKeypair(*keyOutDir)
		return
	}

	// --- Ticket generation mode ---
	if *keyPath == "" {
		log.Fatal("--key is required. Use --generate-keypair to create a new keypair.")
	}
	if *action == "" {
		log.Fatal("--action is required. Valid: DEPLOY, REDEPLOY, SHUTDOWN, DEREGISTER, KILLSWITCH_ACTIVATE")
	}
	if !validActions[*action] {
		log.Fatalf("Invalid action %q. Valid: DEPLOY, REDEPLOY, SHUTDOWN, DEREGISTER, KILLSWITCH_ACTIVATE", *action)
	}
	if *issuer == "" {
		log.Fatal("--issuer is required (e.g., 'ops-team', 'ci-pipeline')")
	}
	if *action == "REDEPLOY" && *newHash == "" {
		log.Fatal("--new-hash is required for REDEPLOY action")
	}

	// Read private key
	keyBytes, err := os.ReadFile(*keyPath)
	if err != nil {
		log.Fatalf("Failed to read key: %v", err)
	}
	if len(keyBytes) != ed25519.PrivateKeySize {
		log.Fatalf("Invalid key size: expected %d bytes, got %d", ed25519.PrivateKeySize, len(keyBytes))
	}
	privKey := ed25519.PrivateKey(keyBytes)

	// Compute public key fingerprint
	pubKey := privKey.Public().(ed25519.PublicKey)
	fpHash := sha256.Sum256(pubKey)
	keyID := hex.EncodeToString(fpHash[:8])

	// Generate nonce (16 random bytes, hex-encoded)
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		log.Fatalf("Failed to generate nonce: %v", err)
	}
	nonce := hex.EncodeToString(nonceBytes)

	// Build ticket
	now := time.Now().UTC()
	ticket := Ticket{
		Action:    *action,
		Target:    *target,
		Binary:    *binary,
		NewHash:   *newHash,
		IssuedAt:  now.Format(time.RFC3339),
		ExpiresAt: now.Add(*ttl).Format(time.RFC3339),
		Issuer:    *issuer,
		Nonce:     nonce,
	}

	// Canonical JSON
	payload, err := json.Marshal(ticket)
	if err != nil {
		log.Fatalf("Failed to marshal ticket: %v", err)
	}

	// Sign
	sig := ed25519.Sign(privKey, payload)

	signed := SignedTicket{
		Payload:   string(payload),
		Signature: hex.EncodeToString(sig),
		KeyID:     keyID,
	}

	// Write output
	out, err := json.MarshalIndent(signed, "", "  ")
	if err != nil {
		log.Fatalf("Failed to marshal signed ticket: %v", err)
	}

	if err := os.WriteFile(*output, out, 0600); err != nil {
		log.Fatalf("Failed to write ticket: %v", err)
	}

	fmt.Printf("✓ Ticket generated: %s\n", *output)
	fmt.Printf("  Action:    %s\n", ticket.Action)
	fmt.Printf("  Target:    %s\n", ticket.Target)
	fmt.Printf("  Binary:    %s\n", ticket.Binary)
	fmt.Printf("  Expires:   %s\n", ticket.ExpiresAt)
	fmt.Printf("  Issuer:    %s\n", ticket.Issuer)
	fmt.Printf("  Key ID:    %s\n", keyID)
	fmt.Printf("  Nonce:     %s\n", nonce)
}

// generateKeypair creates a new Ed25519 keypair for maintenance operations.
func generateKeypair(outDir string) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatalf("Failed to generate keypair: %v", err)
	}

	privPath := outDir + "/maintenance.key"
	pubPath := outDir + "/maintenance.pub"

	if err := os.WriteFile(privPath, priv, 0400); err != nil {
		log.Fatalf("Failed to write private key: %v", err)
	}
	if err := os.WriteFile(pubPath, pub, 0444); err != nil {
		log.Fatalf("Failed to write public key: %v", err)
	}

	fpHash := sha256.Sum256(pub)
	keyID := hex.EncodeToString(fpHash[:8])

	fmt.Printf("✓ Ed25519 keypair generated\n")
	fmt.Printf("  Private key: %s (KEEP SECRET — store offline)\n", privPath)
	fmt.Printf("  Public key:  %s (upload to Vault)\n", pubPath)
	fmt.Printf("  Key ID:      %s\n", keyID)
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  1. Upload maintenance.pub to Vault: vault kv put secret/canary/maintenance ed25519_pubkey=@maintenance.pub")
	fmt.Println("  2. Store maintenance.key in a secure offline location (USB, HSM, etc)")
	fmt.Println("  3. NEVER store maintenance.key on any canary-monitored host")
}
