package ingestclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Client handles telemetry delivery to the central ingestion service.
type Client struct {
	url    string
	mu     sync.RWMutex
	client *http.Client
}

// New creates a new mTLS Ingestion Client with a production-grade pooled transport.
// The client is safe for concurrent use and reuses connections across heartbeats and events.
func New(url string, tlsConfig *tls.Config) *Client {
	transport := &http.Transport{
		TLSClientConfig:     tlsConfig,
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 5,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  false,
	}
	return &Client{
		url: url,
		client: &http.Client{
			Transport: transport,
			Timeout:   10 * time.Second,
		},
	}
}

// UpdateTLSConfig hot-swaps the underlying TLS configuration used for mTLS.
// It creates a new transport and client to ensure new connections use the fresh credentials.
func (c *Client) UpdateTLSConfig(tlsConfig *tls.Config) {
	c.mu.Lock()
	defer c.mu.Unlock()

	transport := &http.Transport{
		TLSClientConfig:     tlsConfig,
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 5,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  false,
	}
	c.client = &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
	}
}

// Post sends a signed telemetry envelope to the ingestion service.
// On failure, it returns an error; the caller determines the drop/retry policy.
func (c *Client) Post(ctx context.Context, payload []byte) error {
	req, err := http.NewRequestWithContext(ctx, "POST", c.url, bytes.NewBuffer(payload))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	c.mu.RLock()
	client := c.client
	c.mu.RUnlock()

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("ingestion service unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ingestion service rejected request: %s", resp.Status)
	}

	return nil
}

// HTTPClient exposes the underlying *http.Client for OOB or health-check callers
// that share this transport rather than creating their own http.Client.
func (c *Client) HTTPClient() *http.Client {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.client
}

// BaseURL returns the base scheme and host of the ingestion service, stripping any trailing path like /ingest.
func (c *Client) BaseURL() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	u := c.url
	// Handle http:// or https://
	offset := 7
	if strings.HasPrefix(u, "https://") {
		offset = 8
	}
	if offset < len(u) {
		if idx := strings.Index(u[offset:], "/"); idx != -1 {
			return u[:offset+idx]
		}
	}
	return u
}
