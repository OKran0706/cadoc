// Package cleanup removes leftover canary files the backend still lists for this server
// (for example after a previous sentinel was killed), then acknowledges them.
//
// The backend list is untrusted input: a file is deleted only if it is a regular file that
// carries the canary marker for exactly that entry's id, so a compromised or buggy backend
// cannot make the sentinel delete anything else.
package cleanup

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/your-org/canary/sentinel/internal/ingestclient"
	"github.com/your-org/canary/sentinel/internal/signer"
)

const (
	// MaxEntries bounds how many entries one sweep will act on.
	MaxEntries = 1000

	maxBody   = 1 << 20 // fetch response cap
	tailBytes = 4096    // deployer appends the marker last, so only the tail is read
	ackChunk  = 200
	markerKey = "# __CANARY_ID__="
)

var idRE = regexp.MustCompile(`^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$`)

// Entry is one canary the backend believes is planted or tampered on this server.
type Entry struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Type   string `json:"type"`
	SHA256 string `json:"sha256"`
	Status string `json:"status"`
}

// Signer signs telemetry events (satisfied by *signer.Signer).
type Signer interface {
	SignEvent(event map[string]interface{}) (map[string]interface{}, string, error)
}

// Poster delivers a signed envelope to ingestion (satisfied by *ingestclient.Client).
type Poster interface {
	Post(ctx context.Context, payload []byte) error
}

// FetchFunc returns the entries to clean up.
type FetchFunc func(ctx context.Context) ([]Entry, error)

// Fetch asks the ingestion service (mTLS) for this server's planted/tampered canaries.
func Fetch(ctx context.Context, ic *ingestclient.Client) ([]Entry, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ic.BaseURL()+"/control/canaries", nil)
	if err != nil {
		return nil, err
	}
	resp, err := ic.HTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch canaries: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxBody {
		return nil, fmt.Errorf("fetch canaries: response exceeds %d bytes", maxBody)
	}
	var out struct {
		Canaries *[]Entry `json:"canaries"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("fetch canaries: %w", err)
	}
	if out.Canaries == nil {
		return nil, fmt.Errorf("fetch canaries: missing canaries list")
	}
	return *out.Canaries, nil
}

func safePath(p string) bool {
	if p == "" || !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return false
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// hasMarker reports whether f ends with a line "# __CANARY_ID__=<id>" for exactly this id.
func hasMarker(f *os.File, size int64, id string) bool {
	start := int64(0)
	if size > tailBytes {
		start = size - tailBytes
	}
	buf := make([]byte, size-start)
	if n, err := f.ReadAt(buf, start); err != nil && n != len(buf) {
		return false
	}
	tail := string(buf)
	needle := markerKey + id
	for from := 0; ; {
		i := strings.Index(tail[from:], needle)
		if i < 0 {
			return false
		}
		i += from
		atLineStart := (i == 0 && start == 0) || (i > 0 && tail[i-1] == '\n')
		end := i + len(needle)
		atLineEnd := end == len(tail) || tail[end] == '\n' || tail[end] == '\r'
		if atLineStart && atLineEnd {
			return true
		}
		from = i + 1
	}
}

// removeOne returns true when the entry is resolved: file deleted, or already gone.
func removeOne(e Entry) bool {
	if !idRE.MatchString(e.ID) || !safePath(e.Path) {
		return false
	}
	li, err := os.Lstat(e.Path)
	if os.IsNotExist(err) {
		return true
	}
	if err != nil || !li.Mode().IsRegular() {
		return false
	}
	f, err := os.Open(e.Path)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !os.SameFile(li, fi) { // swapped between Lstat and Open
		return false
	}
	if !hasMarker(f, fi.Size(), e.ID) {
		return false
	}
	if err := os.Remove(e.Path); err != nil && !os.IsNotExist(err) {
		return false
	}
	return true
}

// Without drops entries that are the sentinel's own live canaries (matched by id or by path,
// since a fresh decoy can reuse a stale entry's path), so a sweep never removes what was just planted.
func Without(entries []Entry, activeIDs, activePaths map[string]bool) []Entry {
	var out []Entry
	for _, e := range entries {
		if activeIDs[strings.ToLower(e.ID)] || activePaths[e.Path] {
			continue
		}
		out = append(out, e)
	}
	return out
}

// Remove deletes the verified canaries and returns the ids that are resolved (deleted or
// already missing), in input order, each at most once.
func Remove(entries []Entry) []string {
	if len(entries) > MaxEntries {
		entries = entries[:MaxEntries]
	}
	var done []string
	seen := map[string]bool{}
	for _, e := range entries {
		if seen[e.ID] {
			continue
		}
		if removeOne(e) {
			seen[e.ID] = true
			done = append(done, e.ID)
		}
	}
	return done
}

// Ack reports cleaned-up ids to the backend as signed CANARY_CLEANUP events.
func Ack(ctx context.Context, s Signer, p Poster, ids []string) error {
	for len(ids) > 0 {
		n := ackChunk
		if len(ids) < n {
			n = len(ids)
		}
		chunk := append([]string(nil), ids[:n]...)
		ids = ids[n:]
		envelope, _, err := s.SignEvent(map[string]interface{}{"type": "CANARY_CLEANUP", "ids": chunk})
		if err != nil {
			return fmt.Errorf("sign cleanup ack: %w", err)
		}
		payload, err := signer.MarshalEnvelope(envelope)
		if err != nil {
			return fmt.Errorf("marshal cleanup ack: %w", err)
		}
		if err := p.Post(ctx, payload); err != nil {
			return fmt.Errorf("post cleanup ack: %w", err)
		}
	}
	return nil
}

// Sweep fetches, removes and acknowledges. It returns how many canaries were resolved; a
// non-nil error means the sweep was incomplete but the caller can carry on.
func Sweep(ctx context.Context, fetch FetchFunc, s Signer, p Poster) (int, error) {
	entries, err := fetch(ctx)
	if err != nil {
		return 0, err
	}
	done := Remove(entries)
	if len(done) == 0 {
		return 0, nil
	}
	return len(done), Ack(ctx, s, p, done)
}
