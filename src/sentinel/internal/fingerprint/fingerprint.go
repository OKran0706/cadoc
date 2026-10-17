// Package fingerprint derives a stable, tenant-scoped identifier for the host a sentinel runs
// on, so the backend can recognise the same machine when it is added a second time.
//
// The raw /etc/machine-id and DMI product_uuid never leave the host: only an HMAC keyed by the
// tenant slug is sent, so values are not comparable across tenants.
package fingerprint

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/your-org/canary/sentinel/internal/signer"
)

const (
	MachineIDPath   = "/etc/machine-id"
	ProductUUIDPath = "/sys/class/dmi/id/product_uuid"
	maxRead         = 256
)

var (
	hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// All-zero / all-F ids and common firmware filler carry no identity.
	placeholderRE  = regexp.MustCompile(`^([0-]+|[f-]+)$`)
	placeholderSet = map[string]bool{
		"not settable": true, "not specified": true, "unknown": true, "none": true,
		"to be filled by o.e.m.": true, "default string": true, "system product name": true,
		"uninitialized": true,
	}
)

func clean(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" || placeholderRE.MatchString(s) || placeholderSet[s] {
		return ""
	}
	return s
}

// Compute returns the 64-hex fingerprint, or "" when there is not enough identity to build one
// (no tenant slug or no usable machine-id). A missing/placeholder product_uuid is simply left out.
func Compute(slug, machineID, productUUID string) string {
	slug = strings.TrimSpace(slug)
	m := clean(machineID)
	if slug == "" || m == "" {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(slug))
	mac.Write([]byte(m + "|" + clean(productUUID)))
	return hex.EncodeToString(mac.Sum(nil))
}

func readSmall(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxRead))
	if err != nil {
		return ""
	}
	return string(b)
}

// ReadFrom computes the fingerprint from the given identity files.
func ReadFrom(slug, machineIDPath, productUUIDPath string) string {
	return Compute(slug, readSmall(machineIDPath), readSmall(productUUIDPath))
}

// Read computes the fingerprint of this host.
// ponytail: product_uuid is root-readable only, so call this before dropping privileges; if it is
// unreadable the fingerprint is machine-id only (still stable for a given deployment).
func Read(slug string) string { return ReadFrom(slug, MachineIDPath, ProductUUIDPath) }

// SlugOf returns the tenant slug from a client id of the form "{slug}.{sentinel_id}".
func SlugOf(clientID string) string {
	i := strings.Index(clientID, ".")
	if i <= 0 || i == len(clientID)-1 {
		return ""
	}
	return clientID[:i]
}

// Signer signs telemetry events (satisfied by *signer.Signer).
type Signer interface {
	SignEvent(event map[string]interface{}) (map[string]interface{}, string, error)
}

// Poster delivers a signed envelope to ingestion (satisfied by *ingestclient.Client).
type Poster interface {
	Post(ctx context.Context, payload []byte) error
}

// Emit reports the fingerprint to the backend. An empty fingerprint is a no-op.
func Emit(ctx context.Context, s Signer, p Poster, fp string) error {
	if fp == "" {
		return nil
	}
	if !hex64.MatchString(fp) {
		return fmt.Errorf("malformed fingerprint")
	}
	envelope, _, err := s.SignEvent(map[string]interface{}{"type": "SENTINEL_FINGERPRINT", "fingerprint": fp})
	if err != nil {
		return fmt.Errorf("sign fingerprint: %w", err)
	}
	payload, err := signer.MarshalEnvelope(envelope)
	if err != nil {
		return fmt.Errorf("marshal fingerprint: %w", err)
	}
	return p.Post(ctx, payload)
}
