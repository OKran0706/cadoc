package ingestclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"time"
)

// Client handles telemetry delivery to the central ingestion service.
type Client struct {
	url    string
	client *http.Client
}

// New creates a new mTLS Ingestion Client.
func New(url string, tlsConfig *tls.Config) *Client {
	return &Client{
		url: url,
		client: &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: tlsConfig,
			},
			Timeout: 10 * time.Second,
		},
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

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("ingestion service unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ingestion service rejected request: %s", resp.Status)
	}

	return nil
}
