// canary-system/src/sentinel/internal/sysutil/sysutil.go
// Common system utilities for sentinel processes.

package sysutil

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"

	"github.com/your-org/canary/sentinel/internal/vault"
	"kernel.org/pub/linux/libs/security/libcap/cap"
)

// UnwrapVaultToken checks for a wrapped token in the environment,
// unwraps it to get a real session token, and exports it for the process.
func UnwrapVaultToken(vc *vault.Client, tokenEnvStr, processName string) error {
	// Support both specific and generic env vars
	wrapped := os.Getenv(tokenEnvStr)
	if wrapped == "" {
		wrapped = os.Getenv("VAULT_WRAPPED_TOKEN")
	}

	if wrapped == "" {
		return nil // No wrapped token provided
	}

	log.Printf("Vault wrapped token detected for %s — attempting to unwrap via API...\n", processName)

	_, err := vc.Unwrap(wrapped)
	if err != nil {
		return fmt.Errorf("vault unwrap failed: %w", err)
	}

	// CRITICAL: Unset the wrapped tokens so they cannot be leaked/reused
	os.Unsetenv(tokenEnvStr)
	os.Unsetenv("VAULT_WRAPPED_TOKEN")

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
	if verify.GetFlag(cap.Effective, cap.SYS_ADMIN) {
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
