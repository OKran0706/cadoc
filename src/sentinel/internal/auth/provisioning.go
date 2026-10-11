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
	"sync"
	"time"

	"github.com/your-org/canary/sentinel/internal/ingestclient"
	"github.com/your-org/canary/sentinel/internal/sysutil"
)

// InMemoryClientKey holds the private key bytes fetched during bootstrap.
// It is NEVER written to disk. It is populated by BootstrapFromIngestionService
// and consumed by the caller to build the in-memory TLS config.
// Zeroed out after use to minimise the window of exposure.
var (
	InMemoryClientKey []byte
	maintenanceKey    string
	keyMu             sync.RWMutex
)

// GetSignerKey returns the current brokered signer key (Ed25519 hex).
func GetSignerKey() string {
	keyMu.RLock()
	defer keyMu.RUnlock()
	return maintenanceKey
}

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

// BootstrapFromIngestionService exchanges a Join Token for mTLS credentials and a Signer Key.
func BootstrapFromIngestionService(ctx context.Context, ingestionURL, joinToken, stateDir string, bootstrapTLS *tls.Config) (caCert, clientCert []byte, renewalToken, signerKey string, err error) {
	if joinToken == "" {
		return nil, nil, "", "", fmt.Errorf("bootstrap: join token is required")
	}
	if ingestionURL == "" {
		return nil, nil, "", "", fmt.Errorf("bootstrap: ingestion URL is required")
	}

	baseUrl := strings.TrimSuffix(strings.TrimRight(ingestionURL, "/"), "/ingest")
	url := baseUrl + "/bootstrap/get_credentials"

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewBuffer([]byte("{}")))
	if err != nil {
		return nil, nil, "", "", fmt.Errorf("bootstrap: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+joinToken)
	req.Header.Set("Content-Type", "application/json")

	httpClient := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: bootstrapTLS,
		},
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, nil, "", "", fmt.Errorf("bootstrap: execute request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, "", "", fmt.Errorf("bootstrap: read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, nil, "", "", fmt.Errorf("bootstrap: unexpected status %d: %s", resp.StatusCode, string(body))
	}

	var respData struct {
		CACert       string `json:"ca_cert"`
		ClientCert   string `json:"client_cert"`
		ClientKey    string `json:"client_key"`
		RenewalToken string `json:"renewal_token"`
		SignerKey    string `json:"signer_key"`
	}
	if err := json.Unmarshal(body, &respData); err != nil {
		return nil, nil, "", "", fmt.Errorf("decode bootstrap response: %w", err)
	}

	caCert = []byte(respData.CACert)
	clientCert = []byte(respData.ClientCert)
	clientKey := []byte(respData.ClientKey)
	renewalToken = respData.RenewalToken
	signerKey = respData.SignerKey

	if len(caCert) == 0 || len(clientCert) == 0 || len(clientKey) == 0 || renewalToken == "" || signerKey == "" {
		return nil, nil, "", "", fmt.Errorf("incomplete credential package from ingestion service")
	}

	InMemoryClientKey = clientKey
	keyMu.Lock()
	maintenanceKey = signerKey
	keyMu.Unlock()

	return caCert, clientCert, renewalToken, signerKey, nil
}

// RecoverFromIngestionService uses a renewal token to get a fresh mTLS package and Signer Key.
func RecoverFromIngestionService(ctx context.Context, ingestionURL string, tempTLS *tls.Config, clientID, renewalToken string) (caCert, clientCert []byte, newRenewalToken, signerKey string, err error) {
	if ingestionURL == "" {
		return nil, nil, "", "", fmt.Errorf("recovery: ingestion URL is required")
	}
	if tempTLS == nil {
		return nil, nil, "", "", fmt.Errorf("recovery: TLS config is required for mTLS recovery")
	}

	baseUrl := strings.TrimSuffix(strings.TrimRight(ingestionURL, "/"), "/ingest")
	url := baseUrl + "/bootstrap/renew_credentials"

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil, "", "", fmt.Errorf("recovery: build request: %w", err)
	}
	req.Header.Set("X-Client-Cert-CN", clientID)
	req.Header.Set("X-Renewal-Token", renewalToken)

	httpClient := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: tempTLS,
		},
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, nil, "", "", fmt.Errorf("recovery: execute request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, "", "", fmt.Errorf("recovery: read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, nil, "", "", fmt.Errorf("recovery: unexpected status %d from %s: %s", resp.StatusCode, url, string(body))
	}

	var respData struct {
		CACert       string `json:"ca_cert"`
		ClientCert   string `json:"client_cert"`
		ClientKey    string `json:"client_key"`
		RenewalToken string `json:"renewal_token"`
		SignerKey    string `json:"signer_key"`
	}
	if err := json.Unmarshal(body, &respData); err != nil {
		return nil, nil, "", "", fmt.Errorf("recovery: parse response: %w", err)
	}

	if respData.CACert == "" || respData.ClientCert == "" || respData.ClientKey == "" || respData.RenewalToken == "" || respData.SignerKey == "" {
		return nil, nil, "", "", fmt.Errorf("recovery: incomplete credential response from Ingestion Service")
	}

	// Store the refreshed private key in memory.
	InMemoryClientKey = []byte(respData.ClientKey)
	keyMu.Lock()
	maintenanceKey = respData.SignerKey
	keyMu.Unlock()

	return []byte(respData.CACert), []byte(respData.ClientCert), respData.RenewalToken, respData.SignerKey, nil
}

// RunIdentityRenewalLoop starts a background goroutine that periodically refreshes
// the Sentinel's mTLS identity, ratcheting token, and signer key.
//
// interval: how often to renew (e.g. 6 hours).
// onUpdate: callback invoked with the new tls.Config and new signerKey after a successful renewal.
func RunIdentityRenewalLoop(ctx context.Context, ingestionURL, stateDir, clientID string, onUpdate func(*tls.Config, string)) {
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
						signerKey    string
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
					newCA, newCert, newToken, signerKey, err = RecoverFromIngestionService(ctx, ingestionURL, tempTLS, clientID, renewalToken)
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
					log.Printf("[auth] Identity and Signer successfully rotated. New assets applied.")
					onUpdate(newTLS, signerKey)
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

// GetMaintenanceKey fetches the public key for maintenance ticket verification via the broker.
func GetMaintenanceKey(ctx context.Context, ic *ingestclient.Client) (string, error) {
	resp, err := ic.HTTPClient().Get(ic.BaseURL() + "/bootstrap/maintenance_key")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to fetch maintenance key: status %d", resp.StatusCode)
	}

	var data struct {
		PubKey string `json:"pubkey"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", err
	}
	return data.PubKey, nil
}

// GetKillSwitch fetches the current killswitch ticket via the broker.
func GetKillSwitch(ctx context.Context, ic *ingestclient.Client) (string, error) {
	resp, err := ic.HTTPClient().Get(ic.BaseURL() + "/control/killswitch")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to fetch killswitch: status %d", resp.StatusCode)
	}

	var data struct {
		Ticket string `json:"ticket"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", err
	}
	return data.Ticket, nil
}
