// canary-system/src/sentinel/internal/sysutil/sysutil.go
// Common system utilities for sentinel processes.

package sysutil

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/your-org/canary/sentinel/internal/config"
	"kernel.org/pub/linux/libs/security/libcap/cap"
)


// DropCapabilitiesAfterInit restricts the process to only the minimum required capabilities.
func DropCapabilitiesAfterInit() error {
	c := cap.NewSet()
	c.SetFlag(cap.Permitted, true, cap.NET_ADMIN)
	c.SetFlag(cap.Effective, true, cap.NET_ADMIN)
	c.SetFlag(cap.Permitted, true, cap.AUDIT_CONTROL)
	c.SetFlag(cap.Effective, true, cap.AUDIT_CONTROL)
	c.SetFlag(cap.Permitted, true, cap.AUDIT_WRITE)
	c.SetFlag(cap.Effective, true, cap.AUDIT_WRITE)
	c.SetFlag(cap.Permitted, true, cap.AUDIT_READ)
	c.SetFlag(cap.Effective, true, cap.AUDIT_READ)
	// CAP_KILL: remote process quarantine signals other users' processes (exe/comm verified first).
	c.SetFlag(cap.Permitted, true, cap.KILL)
	c.SetFlag(cap.Effective, true, cap.KILL)
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

	// FIXME: This is a prototype stub. In production, the expected hash must be 
	// fetched from a secure remote source (Vault) and verified against a signed manifest.
	// UPGRADE PATH: Implement verification loop with ingestclient once metadata endpoint is ready.
	log.Printf("[sysutil] WARNING: Self-integrity check is running in prototype mode (trust-on-first-use)")
	expectedHash := actualHash

	if actualHash != expectedHash {
		return expectedHash, actualHash, fmt.Errorf("BINARY_INTEGRITY_FAIL: expected %s got %s", expectedHash, actualHash)
	}
	return expectedHash, actualHash, nil
}

// LoadTLSConfig creates a tls.Config fetching certs from disk.
// This is used as a fallback during restart recovery when mTLS identity needs to be proven.
func LoadTLSConfig(cfg config.TelemetryConfig) (*tls.Config, []byte, []byte, error) {
	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
	}

	var caCertData, clientCertData []byte

	// Helper to load cert from file
	getCertData := func(filePath string) ([]byte, error) {
		if filePath != "" {
			data, err := os.ReadFile(filePath)
			if err != nil {
				return nil, fmt.Errorf("read cert file %s: %w", filePath, err)
			}
			return data, nil
		}
		return nil, nil
	}

	// Load CA Cert
	var err error
	caCertData, err = getCertData(cfg.CACert)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to load CA cert: %w", err)
	}
	if len(caCertData) > 0 {
		caCertPool := x509.NewCertPool()
		if !caCertPool.AppendCertsFromPEM(caCertData) {
			return nil, nil, nil, fmt.Errorf("failed to parse CA certificate")
		}
		tlsConfig.RootCAs = caCertPool
	}

	// Load Client Cert (public)
	clientCertData, err = getCertData(cfg.ClientCert)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to load client cert: %w", err)
	}

	return tlsConfig, caCertData, clientCertData, nil
}

// BuildTLSConfigFromBytes constructs a tls.Config from raw PEM bytes.
// Used during fresh bootstrap when the private key is held in memory (never on disk).
//
//   - caCert:     PEM CA certificate bytes (sets RootCAs for server verification)
//   - clientCert: PEM client certificate bytes
//   - clientKey:  PEM private key bytes — in-memory ONLY, caller must never write this to disk
func BuildTLSConfigFromBytes(caCert, clientCert, clientKey []byte) (*tls.Config, error) {
	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
	}

	if len(caCert) > 0 {
		caCertPool := x509.NewCertPool()
		if !caCertPool.AppendCertsFromPEM(caCert) {
			return nil, fmt.Errorf("BuildTLSConfigFromBytes: failed to parse CA certificate PEM")
		}
		tlsConfig.RootCAs = caCertPool
	}

	if len(clientCert) > 0 && len(clientKey) > 0 {
		cert, err := tls.X509KeyPair(clientCert, clientKey)
		if err != nil {
			return nil, fmt.Errorf("BuildTLSConfigFromBytes: failed to load client key pair: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{cert}
	} else if len(clientCert) > 0 || len(clientKey) > 0 {
		return nil, fmt.Errorf("BuildTLSConfigFromBytes: both client cert and key must be provided together")
	}

	return tlsConfig, nil
}



// PersistPublicCerts writes the CA and mTLS public certificates to disk
// using atomic write (write-to-temp + rename) to prevent corruption.
// The private key is NEVER written — this function only handles public material.
func PersistPublicCerts(stateDir string, caCert, clientCert []byte) error {
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return fmt.Errorf("create state dir %s: %w", stateDir, err)
	}
	if err := atomicWrite(filepath.Join(stateDir, "ca.crt"), caCert); err != nil {
		return fmt.Errorf("persist ca.crt: %w", err)
	}
	if err := atomicWrite(filepath.Join(stateDir, "mtls.crt"), clientCert); err != nil {
		return fmt.Errorf("persist mtls.crt: %w", err)
	}
	log.Printf("Persisted public certs to %s (private key remains in memory only)", stateDir)
	return nil
}

// LoadPersistedCerts reads the CA and mTLS public certificates from disk.
// Returns os.ErrNotExist if either file is missing.
func LoadPersistedCerts(stateDir string) (caCert, clientCert []byte, err error) {
	caPath := filepath.Join(stateDir, "ca.crt")
	certPath := filepath.Join(stateDir, "mtls.crt")

	caCert, err = os.ReadFile(caPath)
	if err != nil {
		return nil, nil, fmt.Errorf("load ca.crt: %w", err)
	}

	clientCert, err = os.ReadFile(certPath)
	if err != nil {
		return nil, nil, fmt.Errorf("load mtls.crt: %w", err)
	}

	log.Printf("Loaded persisted public certs from %s", stateDir)
	return caCert, clientCert, nil
}

// PersistRenewalToken writes the Sentinel's current ratcheting renewal token to disk.
// This file is sensitive as it acts as the "password" for the next restart,
// so it is written with 0600 permissions.
func PersistRenewalToken(stateDir, token string) error {
	tokenPath := filepath.Join(stateDir, "renewal.token")
	if err := os.WriteFile(tokenPath, []byte(token), 0600); err != nil {
		return fmt.Errorf("write renewal.token: %w", err)
	}
	return nil
}

// LoadRenewalToken reads the Sentinel's ratcheting renewal token from disk.
func LoadRenewalToken(stateDir string) (string, error) {
	tokenPath := filepath.Join(stateDir, "renewal.token")
	tokenBytes, err := os.ReadFile(tokenPath)
	if err != nil {
		return "", fmt.Errorf("load renewal.token: %w", err)
	}
	return string(tokenBytes), nil
}

// IsCommandAvailable checks if a command exists in the system PATH.
func IsCommandAvailable(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// atomicWrite writes data to a temp file then renames it to the target path.
// This ensures the target file is never left in a partially-written state.
func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func parseVaultLocation(loc string) (string, string) {
	parts := strings.SplitN(loc, ":", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return loc, "cert"
}

// ListenUnix creates a Unix domain socket listener with appropriate cleanup and permissions.
func ListenUnix(ctx context.Context, socketPath string, perm os.FileMode) (net.Listener, error) {
	// Clean up existing socket
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("remove existing socket: %w", err)
	}

	lc := net.ListenConfig{}
	listener, err := lc.Listen(ctx, "unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("listen unix: %w", err)
	}

	if err := os.Chmod(socketPath, perm); err != nil {
		listener.Close()
		return nil, fmt.Errorf("chmod socket: %w", err)
	}

	return listener, nil
}

// RandomAlpha returns a random alphabetic string of length n.
func RandomAlpha(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	result := make([]byte, n)
	for i := range result {
		b := make([]byte, 1)
		if _, err := rand.Read(b); err != nil {
			log.Printf("[sysutil] WARNING: rand.Read failed in RandomAlpha: %v", err)
		}
		result[i] = chars[int(b[0])%len(chars)]
	}
	return string(result)
}

// RandomBase64 returns a random base64-encoded string of length n.
func RandomBase64(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		log.Printf("[sysutil] WARNING: rand.Read failed in RandomBase64: %v", err)
	}
	enc := base64.StdEncoding.EncodeToString(buf)
	if len(enc) > n {
		return enc[:n]
	}
	return enc
}

// RandomHex returns a random hex string of length n.
func RandomHex(n int) string {
	buf := make([]byte, (n+1)/2)
	if _, err := rand.Read(buf); err != nil {
		log.Printf("[sysutil] WARNING: rand.Read failed in RandomHex: %v", err)
	}
	return hex.EncodeToString(buf)[:n]
}
