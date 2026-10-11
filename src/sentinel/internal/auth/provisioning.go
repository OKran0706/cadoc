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
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/your-org/canary/sentinel/internal/sysutil"
)

// CredentialResponse represents the JSON payload returned by the Ingestion Service
// containing the Sentinel's mTLS identity and ratcheting renewal token.
type CredentialResponse struct {
	CACert       string `json:"ca_cert"`
	ClientCert   string `json:"client_cert"`
	ClientKey    string `json:"client_key"`
	RenewalToken string `json:"renewal_token"` // Used for the next recovery/renewal cycle
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
	certPath := filepath.Join(stateDir, "mtls.crt")
	_, err := os.Stat(certPath)
	return err == nil
}

// BootstrapFromIngestionService contacts the Ingestion Service's
// POST /bootstrap/get_credentials endpoint using the provided joinToken, fetches the
// mTLS credential package, and stores the private key in InMemoryClientKey (never on disk).
//
// Returns the CA cert, client cert PEM bytes, and the Renewal Token so the caller can:
//  1. Persist the certs via sysutil.PersistPublicCerts (public material only).
//  2. Persist the Renewal Token for the next restart.
//  3. Build an in-memory tls.Config via sysutil.BuildTLSConfigFromBytes.
func BootstrapFromIngestionService(ctx context.Context, ingestionURL, joinToken, stateDir string) (caCert []byte, clientCert []byte, renewalToken string, err error) {
	if joinToken == "" {
		return nil, nil, "", fmt.Errorf("bootstrap: join token is required")
	}
	if ingestionURL == "" {
		return nil, nil, "", fmt.Errorf("bootstrap: ingestion URL is required")
	}

	url := strings.TrimRight(ingestionURL, "/") + "/bootstrap/get_credentials"

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewBuffer([]byte("{}")))
	if err != nil {
		return nil, nil, "", fmt.Errorf("bootstrap: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+joinToken)
	req.Header.Set("Content-Type", "application/json")

	httpClient := &http.Client{Timeout: 30 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, nil, "", fmt.Errorf("bootstrap: execute request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, "", fmt.Errorf("bootstrap: read response: %w", err)
	}

	switch resp.StatusCode {
	case http.StatusOK:
		// success — fall through
	case http.StatusForbidden:
		return nil, nil, "", fmt.Errorf("bootstrap: token already used (403) — %s", string(body))
	case http.StatusUnauthorized:
		return nil, nil, "", fmt.Errorf("bootstrap: token invalid or expired (401)")
	default:
		return nil, nil, "", fmt.Errorf("bootstrap: unexpected status %d from %s: %s", resp.StatusCode, url, string(body))
	}

	var creds CredentialResponse
	if err := json.Unmarshal(body, &creds); err != nil {
		return nil, nil, "", fmt.Errorf("bootstrap: parse credential response: %w", err)
	}

	if creds.CACert == "" || creds.ClientCert == "" || creds.ClientKey == "" {
		return nil, nil, "", fmt.Errorf("bootstrap: incomplete credential response — ca_cert, client_cert, and client_key are all required")
	}

	// Store private key strictly in process memory — NEVER written to disk.
	InMemoryClientKey = []byte(creds.ClientKey)

	return []byte(creds.CACert), []byte(creds.ClientCert), creds.RenewalToken, nil
}

// RecoverFromIngestionService re-fetches mTLS credentials from the Ingestion Service
// using the already-persisted public certificates as the identity proof (via mTLS)
// AND the ratcheting renewal token as proof of sequence.
// No join token is required.
//
// This is the restart recovery path: the private key was lost when the process exited,
// so we request fresh credentials from the Ingestion Service using our existing cert
// and our single-use renewal token.
//
// clientID must match the CN in the persisted mtls.crt.
func RecoverFromIngestionService(ctx context.Context, ingestionURL string, tlsConfig *tls.Config, clientID string, renewalToken string) (caCert []byte, clientCert []byte, newRenewalToken string, err error) {
	if ingestionURL == "" {
		return nil, nil, "", fmt.Errorf("recovery: ingestion URL is required")
	}
	if tlsConfig == nil {
		return nil, nil, "", fmt.Errorf("recovery: TLS config is required for mTLS recovery")
	}
	if clientID == "" {
		return nil, nil, "", fmt.Errorf("recovery: clientID is required")
	}
	if renewalToken == "" {
		return nil, nil, "", fmt.Errorf("recovery: renewalToken is required")
	}

	url := strings.TrimRight(ingestionURL, "/") + "/bootstrap/renew_credentials"

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil, "", fmt.Errorf("recovery: build request: %w", err)
	}
	// Pass client_id via header so the Ingestion Service can identify this Sentinel
	req.Header.Set("X-Client-Cert-CN", clientID)
	// Pass the Ratcheting Renewal Token to prove we are in sync
	req.Header.Set("X-Renewal-Token", renewalToken)

	httpClient := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, nil, "", fmt.Errorf("recovery: execute request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, "", fmt.Errorf("recovery: read response: %w", err)
	}

	switch resp.StatusCode {
	case http.StatusOK:
		// success — fall through
	case http.StatusUnauthorized:
		return nil, nil, "", fmt.Errorf("recovery: identity rejected (401) — mTLS cert may be expired or CN unknown")
	case http.StatusForbidden:
		return nil, nil, "", fmt.Errorf("recovery: token rejected (403) — SECURITY ALARM: Your renewal token is invalid or already used. Possible theft detected.")
	case http.StatusNotFound:
		return nil, nil, "", fmt.Errorf("recovery: credentials not found (404) — re-bootstrap with a join token is required")
	default:
		return nil, nil, "", fmt.Errorf("recovery: unexpected status %d from %s: %s", resp.StatusCode, url, string(body))
	}

	var creds CredentialResponse
	if err := json.Unmarshal(body, &creds); err != nil {
		return nil, nil, "", fmt.Errorf("recovery: parse credential response: %w", err)
	}

	if creds.CACert == "" || creds.ClientCert == "" || creds.ClientKey == "" {
		return nil, nil, "", fmt.Errorf("recovery: incomplete credential response from Ingestion Service")
	}

	// Store the refreshed private key in memory.
	InMemoryClientKey = []byte(creds.ClientKey)

	return []byte(creds.CACert), []byte(creds.ClientCert), creds.RenewalToken, nil
}

// RunIdentityRenewalLoop starts a background goroutine that periodically refreshes
// the Sentinel's mTLS identity and ratcheting token.
//
// interval: how often to renew (e.g. 6 hours).
// onUpdate: callback invoked with the new tls.Config after a successful renewal.
func RunIdentityRenewalLoop(ctx context.Context, ingestionURL, stateDir, clientID string, onUpdate func(*tls.Config)) {
	const (
		baseInterval = 6 * time.Hour
		minBackoff   = 1 * time.Minute
		maxBackoff   = 10 * time.Minute
	)

	go func() {
		backoff := minBackoff
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(baseInterval):
				// Start renewal attempt
				for {
					var (
						err          error
						caCert       []byte
						renewalToken string
						tempTLS      *tls.Config
						newCA        []byte
						newCert      []byte
						newToken     string
						newTLS       *tls.Config
					)

					log.Printf("[auth] Scheduled identity renewal started for %s", clientID)

					// 1. Load current state
					caCert, _, err = sysutil.LoadPersistedCerts(stateDir)
					if err != nil {
						log.Printf("[auth] Renewal failed (load certs): %v. Retrying in %v...", err, backoff)
						goto retry
					}
					renewalToken, err = sysutil.LoadRenewalToken(stateDir)
					if err != nil {
						log.Printf("[auth] Renewal failed (load token): %v. Retrying in %v...", err, backoff)
						goto retry
					}

					// 2. Build temporary TLS config for the call (verify server only)
					tempTLS, err = sysutil.BuildTLSConfigFromBytes(caCert, nil, nil)
					if err != nil {
						log.Printf("[auth] Renewal failed (build temp TLS): %v. Retrying in %v...", err, backoff)
						goto retry
					}

					// 3. Call Ingestion Service
					newCA, newCert, newToken, err = RecoverFromIngestionService(ctx, ingestionURL, tempTLS, clientID, renewalToken)
					if err != nil {
						log.Printf("[auth] Renewal failed (service call): %v. Retrying in %v...", err, backoff)
						goto retry
					}

					// 4. Persist and apply new identity
					if err := sysutil.PersistPublicCerts(stateDir, newCA, newCert); err != nil {
						log.Printf("[auth] Renewal failed (persist certs): %v. Retrying in %v...", err, backoff)
						goto retry
					}
					if err := sysutil.PersistRenewalToken(stateDir, newToken); err != nil {
						log.Printf("[auth] Renewal failed (persist token): %v. Retrying in %v...", err, backoff)
						goto retry
					}

					// Build final TLS config (uses global InMemoryClientKey updated by RecoverFromIngestionService)
					newTLS, err = sysutil.BuildTLSConfigFromBytes(newCA, newCert, InMemoryClientKey)
					if err != nil {
						log.Printf("[auth] Renewal failed (build final TLS): %v. Retrying in %v...", err, backoff)
						goto retry
					}

					// SUCCESS: Notify application and reset backoff
					log.Printf("[auth] Identity successfully rotated. New certificates and token applied.")
					onUpdate(newTLS)
					backoff = minBackoff
					break // Exit retry loop and wait for next scheduled interval

				retry:
					select {
					case <-ctx.Done():
						return
					case <-time.After(backoff):
						backoff *= 2
						if backoff > maxBackoff {
							backoff = maxBackoff
						}
						continue
					}
				}
			}
		}
	}()
}
