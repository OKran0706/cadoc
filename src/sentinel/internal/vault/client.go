// canary-system/src/sentinel/internal/vault/client.go
// Internal wrapper for the HashiCorp Vault Go API.
// This enables "Zero-External-Dependency" secret management.

package vault

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/hashicorp/vault/api"
)

// Sentinel errors for Vault HTTP response codes.
// Callers should use errors.Is to check for specific conditions.
var (
	// ErrForbidden is returned when Vault responds with HTTP 403 (token expired or insufficient policy).
	ErrForbidden = errors.New("vault: forbidden (403)")
	// ErrNotFound is returned when Vault responds with HTTP 404 (secret path does not exist).
	ErrNotFound = errors.New("vault: not found (404)")
)

// Client wraps the official Vault API client.
type Client struct {
	vault *api.Client
	mu    sync.Mutex
}

// New creates a new Vault client. 
// It automatically reads VAULT_ADDR and other standard env vars.
func New() (*Client, error) {
	config := api.DefaultConfig()
	
	// Read address from env (default to localhost if not set)
	if addr := os.Getenv("VAULT_ADDR"); addr == "" {
		config.Address = "http://127.0.0.1:8200"
	}

	client, err := api.NewClient(config)
	if err != nil {
		return nil, fmt.Errorf("create vault client: %w", err)
	}

	// Set the current token if already available in environment
	if token := os.Getenv("VAULT_TOKEN"); token != "" {
		client.SetToken(token)
	}

	return &Client{vault: client}, nil
}

// SetTLSConfig updates the underlying Vault client with a specific TLS configuration.
// Required for cert-based re-authentication.
func (c *Client) SetTLSConfig(tlsConfig *tls.Config) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	token := c.vault.Token() // Preserve existing session token
	apiConfig := c.vault.CloneConfig()
	apiConfig.HttpClient.Transport = &http.Transport{
		TLSClientConfig: tlsConfig,
	}
	client, err := api.NewClient(apiConfig)
	if err != nil {
		return err
	}
	c.vault = client
	c.vault.SetToken(token) // Restore session token
	return nil
}

// LoginWithCert authenticates to Vault using the mTLS certificate configured on the client.
// Returns the new session token.
func (c *Client) LoginWithCert() (string, error) {
	// Vault's cert auth mount is usually at auth/cert
	secret, err := c.vault.Logical().Write("auth/cert/login", nil)
	if err != nil {
		return "", err
	}

	if secret == nil || secret.Auth == nil {
		return "", fmt.Errorf("cert login failed: no authentication info returned")
	}

	token := secret.Auth.ClientToken
	c.vault.SetToken(token)
	return token, nil
}

// SetToken safely injects a token strictly into process memory for this client
func (c *Client) SetToken(token string) {
	c.vault.SetToken(token)
}

// Unwrap takes a wrapped token and exchanges it for a real session token.
// The session token is automatically set on the client for future use.
func (c *Client) Unwrap(wrappedToken string) (string, error) {
	if wrappedToken == "" {
		return "", fmt.Errorf("wrapped token is empty")
	}

	// 1. Create an isolated, ephemeral client for the unwrap operation
	// to avoid corrupting the main client's session token.
	apiConfig := c.vault.CloneConfig()
	tempClient, err := api.NewClient(apiConfig)
	if err != nil {
		return "", err
	}
	tempClient.SetToken(wrappedToken)

	// 2. Execute unwrap using the isolated client
	secret, err := tempClient.Logical().Unwrap(wrappedToken)
	if err != nil {
		return "", fmt.Errorf("vault unwrap failed: %w", err)
	}

	if secret == nil {
		return "", fmt.Errorf("unwrapped response is nil")
	}

	var token string
	if secret.Auth != nil {
		token = secret.Auth.ClientToken
	}
	if token == "" && secret.Data != nil {
		if val, ok := secret.Data["token"].(string); ok {
			token = val
		}
	}

	if token == "" {
		return "", fmt.Errorf("could not find 'token' in unwrapped response")
	}

	// 3. Update the main client's token under lock
	c.mu.Lock()
	c.vault.SetToken(token)
	c.mu.Unlock()

	return token, nil
}

// GetSecretField retrieves a single field from a KV secret path.
// Supports both KV v1 and v2 by automatically handling path and data structure differences.
func (c *Client) GetSecretField(path, field string) (string, error) {
	apiPath := path
	// If it's a KV v2 engine, we need to inject /data/ after the mount point (e.g., secret/data/...)
	// In the Canary ecosystem, we assume 'secret/' is the mount point for general secrets.
	if strings.HasPrefix(path, "secret/") && !strings.HasPrefix(path, "secret/data/") {
		apiPath = strings.Replace(path, "secret/", "secret/data/", 1)
	}

	secret, err := c.vault.Logical().Read(apiPath)
	if err != nil {
		errStr := err.Error()
		switch {
		case strings.Contains(errStr, "403"):
			return "", fmt.Errorf("read secret %s: %w", path, ErrForbidden)
		case strings.Contains(errStr, "404"):
			return "", fmt.Errorf("read secret %s: %w", path, ErrNotFound)
		default:
			return "", fmt.Errorf("read secret %s (api: %s): %w", path, apiPath, err)
		}
	}

	if secret == nil || secret.Data == nil {
		return "", fmt.Errorf("secret %s not found or empty (api: %s)", path, apiPath)
	}

	// Handle KV v2 structure (actual data is nested under "data" key)
	data := secret.Data
	if subData, ok := secret.Data["data"].(map[string]interface{}); ok {
		data = subData
	}

	val, ok := data[field].(string)
	if !ok {
		return "", fmt.Errorf("field %s not found in secret %s", field, path)
	}

	return strings.TrimSpace(val), nil
}
