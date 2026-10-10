// canary-system/src/sentinel/internal/auth/provisioning.go
// Brokered identity bootstrapping — replaces the placeholder EnsureCertificates stub.
// The Ingestion Service acts as the sole credential broker; the Sentinel never
// contacts Vault directly during first-time enrollment.
//
// SECURITY CONTRACT:
//   - InMemoryClientKey is NEVER written to disk.
//   - Only ca.crt and mtls.crt (public material) are persisted via sysutil.PersistPublicCerts.
//   - A new join token is required for each fresh enrollment.

package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CredentialResponse is the JSON payload returned by POST /bootstrap/get_credentials.
type CredentialResponse struct {
	CACert     string `json:"ca_cert"`
	ClientCert string `json:"client_cert"`
	ClientKey  string `json:"client_key"`
}

// InMemoryClientKey holds the private key bytes fetched during bootstrap.
// It is NEVER written to disk. It is populated by BootstrapFromIngestionService
// and consumed by the caller to build the in-memory TLS config.
// Zeroed out after use to minimise the window of exposure.
var InMemoryClientKey []byte

// IsProvisioned checks if the sentinel has its persisted mTLS public certificates.
// By default it looks in /var/lib/canary (configurable via STATE_DIRECTORY env var).
func IsProvisioned() bool {
	stateDir := os.Getenv("STATE_DIRECTORY")
	if stateDir == "" {
		stateDir = "/var/lib/canary"
	}
	certPath := filepath.Join(stateDir, "client.crt")
	_, err := os.Stat(certPath)
	return err == nil
}

// BootstrapFromIngestionService contacts the Ingestion Service's
// POST /bootstrap/get_credentials endpoint using the provided joinToken, fetches the
// mTLS credential package, and stores the private key in InMemoryClientKey (never on disk).
//
// Returns the CA cert and client cert PEM bytes so the caller can:
//  1. Persist them via sysutil.PersistPublicCerts (public material only).
//  2. Build an in-memory tls.Config via sysutil.BuildTLSConfigFromBytes.
func BootstrapFromIngestionService(ctx context.Context, ingestionURL, joinToken, stateDir string) (caCert []byte, clientCert []byte, err error) {
	if joinToken == "" {
		return nil, nil, fmt.Errorf("bootstrap: join token is required")
	}
	if ingestionURL == "" {
		return nil, nil, fmt.Errorf("bootstrap: ingestion URL is required")
	}

	url := strings.TrimRight(ingestionURL, "/") + "/bootstrap/get_credentials"

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, nil, fmt.Errorf("bootstrap: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+joinToken)
	req.Header.Set("Content-Type", "application/json")

	httpClient := &http.Client{Timeout: 30 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("bootstrap: request to %s failed: %w", url, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("bootstrap: read response body: %w", err)
	}

	switch resp.StatusCode {
	case http.StatusOK:
		// success — fall through
	case http.StatusForbidden:
		return nil, nil, fmt.Errorf("bootstrap: join token rejected (403) — token may be expired or already consumed")
	case http.StatusUnauthorized:
		return nil, nil, fmt.Errorf("bootstrap: join token rejected (401) — missing or malformed bearer token")
	default:
		return nil, nil, fmt.Errorf("bootstrap: unexpected status %d from %s: %s", resp.StatusCode, url, string(body))
	}

	var creds CredentialResponse
	if err := json.Unmarshal(body, &creds); err != nil {
		return nil, nil, fmt.Errorf("bootstrap: parse credential response: %w", err)
	}

	if creds.CACert == "" || creds.ClientCert == "" || creds.ClientKey == "" {
		return nil, nil, fmt.Errorf("bootstrap: incomplete credential response — ca_cert, client_cert, and client_key are all required")
	}

	// Store private key strictly in process memory — NEVER written to disk.
	InMemoryClientKey = []byte(creds.ClientKey)

	return []byte(creds.CACert), []byte(creds.ClientCert), nil
}
