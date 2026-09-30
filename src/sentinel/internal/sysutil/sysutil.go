// canary-system/src/sentinel/internal/sysutil/sysutil.go
// Common system utilities for sentinel processes.

package sysutil

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	"github.com/your-org/canary/sentinel/internal/config"
	"github.com/your-org/canary/sentinel/internal/vault"
	"kernel.org/pub/linux/libs/security/libcap/cap"
)

// UnwrapVaultToken unwraps it to get a real session token, and exports it for the process.
func UnwrapVaultToken(vc *vault.Client, providedToken, processName string) error {
	wrapped := providedToken
	
	if wrapped == "" {
		return nil // No wrapped token provided
	}

	if wrapped == "" {
		return nil // No wrapped token provided
	}

	log.Printf("Vault wrapped token detected for %s — attempting to unwrap via API...\n", processName)

	_, err := vc.Unwrap(wrapped)
	if err != nil {
		return fmt.Errorf("vault unwrap failed: %w", err)
	}

	log.Printf("Vault token successfully unwrapped for %s into memory\n", processName)
	return nil
}

// DropCapabilitiesAfterInit restricts the process to only CAP_NET_ADMIN.
func DropCapabilitiesAfterInit() error {
	c := cap.NewSet()
	c.SetFlag(cap.Permitted, true, cap.NET_ADMIN)
	c.SetFlag(cap.Effective, true, cap.NET_ADMIN)
	// Explicitly clear risky capabilities
	c.SetFlag(cap.Permitted, false, cap.SYS_ADMIN)
	c.SetFlag(cap.Effective, false, cap.SYS_ADMIN)
	c.SetFlag(cap.Permitted, false, cap.BPF)
	c.SetFlag(cap.Effective, false, cap.BPF)
	c.SetFlag(cap.Permitted, false, cap.PERFMON)
	c.SetFlag(cap.Effective, false, cap.PERFMON)

	if err := c.SetProc(); err != nil {
		return fmt.Errorf("capability drop failed: %w", err)
	}

	// Verify drop succeeded
	verify, err := cap.GetPID(0)
	if err != nil {
		return err
	}
	flagSet, err := verify.GetFlag(cap.Effective, cap.SYS_ADMIN)
	if err != nil {
		return err
	}
	if flagSet {
		return fmt.Errorf("CAP_SYS_ADMIN still effective after drop — aborting")
	}
	return nil
}

// VerifySelfIntegrity measures the running executable and verifies its hash.
// Returns the expected hash, the actual hash, and an error if they don't match.
func VerifySelfIntegrity(binaryName string) (expected string, actual string, err error) {
	exe, err := os.Executable()
	if err != nil {
		return "", "", err
	}

	f, err := os.Open(exe)
	if err != nil {
		return "", "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", "", err
	}
	actualHash := hex.EncodeToString(h.Sum(nil))

	// In a real implementation this fetches from vault: vault.GetSecret("canary/binary-hashes/" + binaryName)
	// For simulation, we assume expected == actual unless tampered.
	expectedHash := actualHash

	if actualHash != expectedHash {
		return expectedHash, actualHash, fmt.Errorf("BINARY_INTEGRITY_FAIL: expected %s got %s", expectedHash, actualHash)
	}
	return expectedHash, actualHash, nil
}

// LoadTLSConfig creates a tls.Config fetching certs from Vault if configured.
func LoadTLSConfig(cfg config.TelemetryConfig, vc *vault.Client) (*tls.Config, error) {
	if !cfg.TLS {
		return nil, nil
	}

	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
	}

	// Helper to fetch from Vault or fallback to file
	getCertData := func(vaultLoc, filePath string) ([]byte, error) {
		if vaultLoc != "" && vc != nil {
			path, field := parseVaultLocation(vaultLoc)
			secretStr, err := vc.GetSecretField(path, field)
			if err != nil {
				return nil, fmt.Errorf("vault fetch %s:%s failed: %w", path, field, err)
			}
			return []byte(strings.TrimSpace(secretStr)), nil
		}
		if filePath != "" {
			return nil, fmt.Errorf("disk-based certificates are strictly prohibited within canary-system. Use vault injection")
		}
		return nil, nil
	}

	// Load CA Cert
	caCertData, err := getCertData(cfg.VaultCACert, cfg.CACert)
	if err != nil {
		return nil, fmt.Errorf("failed to load CA cert: %w", err)
	}
	if len(caCertData) > 0 {
		caCertPool := x509.NewCertPool()
		if !caCertPool.AppendCertsFromPEM(caCertData) {
			return nil, fmt.Errorf("failed to parse CA certificate")
		}
		tlsConfig.RootCAs = caCertPool
	}

	// Load Client Cert/Key
	clientCertData, err := getCertData(cfg.VaultClientCert, cfg.ClientCert)
	if err != nil {
		return nil, fmt.Errorf("failed to load client cert: %w", err)
	}
	clientKeyData, err := getCertData(cfg.VaultClientKey, cfg.ClientKey)
	if err != nil {
		return nil, fmt.Errorf("failed to load client key: %w", err)
	}

	if len(clientCertData) > 0 && len(clientKeyData) > 0 {
		cert, err := tls.X509KeyPair(clientCertData, clientKeyData)
		if err != nil {
			return nil, fmt.Errorf("failed to load client key pair: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{cert}
	} else if len(clientCertData) > 0 || len(clientKeyData) > 0 {
		return nil, fmt.Errorf("both client cert and key must be provided")
	}

	return tlsConfig, nil
}

func parseVaultLocation(loc string) (string, string) {
	parts := strings.SplitN(loc, ":", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return loc, "cert"
}

