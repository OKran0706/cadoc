// canary-system/src/sentinel/internal/vault/client.go
// Internal wrapper for the HashiCorp Vault Go API.
// This enables "Zero-External-Dependency" secret management.

package vault

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/hashicorp/vault/api"
)

// Client wraps the official Vault API client.
type Client struct {
	vault *api.Client
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

	// Use the wrapped token to authenticate for the unwrap call
	c.vault.SetToken(wrappedToken)

	// Execute unwrap
	secret, err := c.vault.Logical().Unwrap(wrappedToken)
	if err != nil {
		return "", fmt.Errorf("vault unwrap failed: %w", err)
	}

	if secret == nil || secret.Data == nil {
		return "", fmt.Errorf("unwrapped secret is empty")
	}

	// Extract tokens from common fields (KV v1 vs v2)
	token, ok := secret.Data["token"].(string)
	if !ok {
		// Fallback for some Vault versions/responses
		if auth, ok := secret.Auth.(*api.SecretAuth); ok {
			token = auth.ClientToken
		}
	}

	if token == "" {
		return "", fmt.Errorf("could not find 'token' in unwrapped response")
	}

	// Set the real token on the client
	c.vault.SetToken(token)

	return token, nil
}

// GetSecretField retrieves a single field from a KV secret path.
// Supports both KV v1 and v2.
func (c *Client) GetSecretField(path, field string) (string, error) {
	secret, err := c.vault.Logical().Read(path)
	if err != nil {
		return "", fmt.Errorf("read secret %s: %w", path, err)
	}

	if secret == nil || secret.Data == nil {
		return "", fmt.Errorf("secret %s not found or empty", path)
	}

	// Handle KV v2 (data is under the "data" sub-field)
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
