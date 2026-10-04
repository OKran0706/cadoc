package auth

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// IsProvisioned checks if the sentinel has its mTLS session certificates.
// By default, it looks in /var/lib/canary (configurable via STATE_DIRECTORY).
func IsProvisioned() bool {
	stateDir := os.Getenv("STATE_DIRECTORY")
	if stateDir == "" {
		stateDir = "/var/lib/canary"
	}
	certPath := filepath.Join(stateDir, "client.crt")
	_, err := os.Stat(certPath)
	return err == nil
}

// EnsureCertificates is a placeholder for the automated certificate acquisition
// workflow. In a real implementation, this would perform an mTLS-bootstrapping
// handshake with the Ingestion LB using a one-time Join Token.
func EnsureCertificates(ctx context.Context, ingestionURL string) error {
	// For this phase, we assume manual provisioning or that the certificates
	// are already present if booting in production mode.
	// In the future, this will trigger the 'Join' workflow.
	if !IsProvisioned() {
		return fmt.Errorf("node not provisioned - mTLS certificates missing in /var/lib/canary")
	}
	return nil
}
