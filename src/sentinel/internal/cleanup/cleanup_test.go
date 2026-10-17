package cleanup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/your-org/canary/sentinel/internal/ingestclient"
)

const (
	id1 = "34d0222e-5f7b-4b7f-b1be-023377ec8f8f"
	id2 = "8a3f1c52-0d2e-4a6b-9c11-5b7e2d9f0a44"
)

func marker(id string) string { return "\n# __CANARY_ID__=" + id + "\n" }

func canaryFile(t *testing.T, dir, name, id string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("SECRET=abc\nTOKEN=xyz\n"+marker(id)), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func plainFile(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func entry(id, path string) Entry {
	return Entry{ID: id, Path: path, Type: "env_file", Status: "planted"}
}

// ---------------------------------------------------------------- Remove: negative

func TestRemoveSkipsFileWithoutMarker(t *testing.T) {
	p := plainFile(t, t.TempDir(), "real.env", "DB_PASSWORD=real\n")
	if got := Remove([]Entry{entry(id1, p)}); len(got) != 0 {
		t.Fatalf("acked %v for an unmarked file", got)
	}
	if !exists(p) {
		t.Fatal("deleted a real file that carries no canary marker")
	}
}

func TestRemoveSkipsMarkerWithDifferentID(t *testing.T) {
	// A fresh decoy planted at a reused path must survive a stale entry for the old id.
	p := canaryFile(t, t.TempDir(), "id_rsa.bak", id2)
	if got := Remove([]Entry{entry(id1, p)}); len(got) != 0 {
		t.Fatalf("acked %v", got)
	}
	if !exists(p) {
		t.Fatal("deleted a decoy with a different id")
	}
}

func TestRemoveMarkerMustMatchWholeID(t *testing.T) {
	d := t.TempDir()
	// entry id is a prefix of the id in the file, and a suffix-extended variant
	longer := id1 + "0"
	p := plainFile(t, d, "a.env", "X=1\n# __CANARY_ID__="+longer+"\n")
	if got := Remove([]Entry{entry(id1, p)}); len(got) != 0 || !exists(p) {
		t.Fatalf("prefix id matched: acked=%v exists=%v", got, exists(p))
	}
}

func TestRemoveMarkerMustBeOwnLine(t *testing.T) {
	p := plainFile(t, t.TempDir(), "notes.txt", "remember: # __CANARY_ID__="+id1+" is the marker format\n")
	if got := Remove([]Entry{entry(id1, p)}); len(got) != 0 || !exists(p) {
		t.Fatalf("marker quoted mid-line deleted a user file: acked=%v", got)
	}
}

func TestRemoveDoesNotFollowSymlink(t *testing.T) {
	d := t.TempDir()
	target := canaryFile(t, d, "target.env", id1)
	link := filepath.Join(d, "link.env")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if got := Remove([]Entry{entry(id1, link)}); len(got) != 0 {
		t.Fatalf("acked %v for a symlink", got)
	}
	if !exists(link) || !exists(target) {
		t.Fatal("symlink or its target was removed")
	}
}

func TestRemoveSkipsDirectories(t *testing.T) {
	d := t.TempDir()
	sub := filepath.Join(d, "keys")
	if err := os.Mkdir(sub, 0700); err != nil {
		t.Fatal(err)
	}
	plainFile(t, sub, "inside", "x")
	if got := Remove([]Entry{entry(id1, sub)}); len(got) != 0 || !exists(sub) {
		t.Fatalf("directory handled: acked=%v", got)
	}
}

func TestRemoveRejectsUnsafePaths(t *testing.T) {
	d := t.TempDir()
	victim := canaryFile(t, d, "victim.env", id1)
	cases := map[string]string{
		"empty":        "",
		"relative":     "victim.env",
		"dot-relative": "./victim.env",
		"dotdot":       d + string(os.PathSeparator) + "sub" + string(os.PathSeparator) + ".." + string(os.PathSeparator) + "victim.env",
		"double-slash": d + string(os.PathSeparator) + string(os.PathSeparator) + "victim.env",
		"trailing-sep": victim + string(os.PathSeparator),
		"nul":          victim + "\x00.txt",
		"newline":      victim + "\n",
	}
	for name, path := range cases {
		t.Run(name, func(t *testing.T) {
			if got := Remove([]Entry{entry(id1, path)}); len(got) != 0 {
				t.Fatalf("acked %v for path %q", got, path)
			}
			if !exists(victim) {
				t.Fatalf("victim removed via path %q", path)
			}
		})
	}
}

func TestRemoveRejectsBadIDs(t *testing.T) {
	d := t.TempDir()
	for name, id := range map[string]string{
		"empty":     "",
		"traversal": "../../x",
		"newline":   id1 + "\nINJECT",
		"short":     "abc",
		"long":      id1 + id1,
		"non-hex":   "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
		"spaces":    " " + id1,
	} {
		t.Run(name, func(t *testing.T) {
			p := plainFile(t, d, "f-"+name, "# __CANARY_ID__="+id+"\n")
			if got := Remove([]Entry{entry(id, p)}); len(got) != 0 || !exists(p) {
				t.Fatalf("bad id %q accepted: acked=%v", id, got)
			}
		})
	}
}

func TestRemoveEmptyAndNilListAreNoOps(t *testing.T) {
	if got := Remove(nil); len(got) != 0 {
		t.Fatalf("nil list returned %v", got)
	}
	if got := Remove([]Entry{}); len(got) != 0 {
		t.Fatalf("empty list returned %v", got)
	}
}

func TestRemoveUnreadableFileSkippedWithoutAbortingOthers(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("permission bits not enforced here")
	}
	d := t.TempDir()
	locked := canaryFile(t, d, "locked.env", id1)
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0600) })
	ok := canaryFile(t, d, "ok.env", id2)
	got := Remove([]Entry{entry(id1, locked), entry(id2, ok)})
	if len(got) != 1 || got[0] != id2 {
		t.Fatalf("got %v, want only %s", got, id2)
	}
	if !exists(locked) || exists(ok) {
		t.Fatal("wrong files removed")
	}
}

func TestRemoveCapsEntriesProcessed(t *testing.T) {
	d := t.TempDir()
	var in []Entry
	for i := 0; i < MaxEntries+5; i++ {
		in = append(in, entry(fmt.Sprintf("00000000-0000-4000-8000-%012d", i), filepath.Join(d, fmt.Sprintf("gone-%d", i))))
	}
	if got := Remove(in); len(got) != MaxEntries {
		t.Fatalf("processed %d entries, want cap %d", len(got), MaxEntries)
	}
}

func TestRemoveDuplicateEntriesAckedOnce(t *testing.T) {
	p := canaryFile(t, t.TempDir(), "a.env", id1)
	got := Remove([]Entry{entry(id1, p), entry(id1, p)})
	if len(got) != 1 {
		t.Fatalf("got %v, want a single ack for id %s", got, id1)
	}
}

// ---------------------------------------------------------------- Remove: positive

func TestRemoveDeletesMarkedFileAndAcks(t *testing.T) {
	p := canaryFile(t, t.TempDir(), "id_rsa.bak", id1)
	got := Remove([]Entry{entry(id1, p)})
	if len(got) != 1 || got[0] != id1 || exists(p) {
		t.Fatalf("got=%v exists=%v", got, exists(p))
	}
}

func TestRemoveMissingFileIsAcked(t *testing.T) {
	p := filepath.Join(t.TempDir(), "already-gone.env")
	if got := Remove([]Entry{entry(id1, p)}); len(got) != 1 || got[0] != id1 {
		t.Fatalf("got %v", got)
	}
	// parent directory also missing
	p2 := filepath.Join(t.TempDir(), "nodir", "x.env")
	if got := Remove([]Entry{entry(id2, p2)}); len(got) != 1 || got[0] != id2 {
		t.Fatalf("got %v", got)
	}
}

func TestRemoveFindsMarkerInTailOfLargeFile(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "dump.sql")
	body := strings.Repeat("INSERT INTO t VALUES (1);\n", 200000) + marker(id1)
	if err := os.WriteFile(p, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	if got := Remove([]Entry{entry(id1, p)}); len(got) != 1 || exists(p) {
		t.Fatalf("large canary not removed: %v", got)
	}
}

func TestRemoveMixedListOnlyTouchesValidOnes(t *testing.T) {
	d := t.TempDir()
	good1 := canaryFile(t, d, "g1.env", id1)
	real := plainFile(t, d, "real.env", "KEEP=1\n")
	good2 := canaryFile(t, d, "g2.env", id2)
	got := Remove([]Entry{entry(id1, good1), entry("00000000-0000-4000-8000-000000000009", real), entry(id2, good2)})
	if len(got) != 2 || got[0] != id1 || got[1] != id2 {
		t.Fatalf("got %v, want [%s %s]", got, id1, id2)
	}
	if exists(good1) || exists(good2) || !exists(real) {
		t.Fatal("wrong set of files removed")
	}
}

// ---------------------------------------------------------------- Fetch

func newClient(t *testing.T, h http.HandlerFunc) *ingestclient.Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return ingestclient.New(srv.URL+"/ingest", nil)
}

func TestFetchNon200IsError(t *testing.T) {
	for _, code := range []int{401, 403, 404, 500, 502, 503} {
		ic := newClient(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code) })
		if _, err := Fetch(context.Background(), ic); err == nil {
			t.Errorf("status %d: expected error", code)
		}
	}
}

func TestFetchBadJSONIsError(t *testing.T) {
	for _, body := range []string{"", "not json", "[]", `{"canaries":"x"}`, `{"canaries":{"a":1}}`, "null"} {
		ic := newClient(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) })
		if _, err := Fetch(context.Background(), ic); err == nil {
			t.Errorf("body %q: expected error", body)
		}
	}
}

func TestFetchHonoursContextTimeout(t *testing.T) {
	ic := newClient(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(3 * time.Second):
		case <-r.Context().Done():
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := Fetch(ctx, ic); err == nil {
		t.Fatal("expected timeout error")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("Fetch ignored the context deadline")
	}
}

func TestFetchBodyIsBounded(t *testing.T) {
	ic := newClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"canaries":[`))
		chunk := strings.Repeat(" ", 64*1024)
		for i := 0; i < 64; i++ { // ~4 MiB
			_, _ = w.Write([]byte(chunk))
		}
		_, _ = w.Write([]byte(`]}`))
	})
	if _, err := Fetch(context.Background(), ic); err == nil {
		t.Fatal("expected error for oversized body")
	}
}

func TestFetchRequestsControlCanaries(t *testing.T) {
	var path, method string
	ic := newClient(t, func(w http.ResponseWriter, r *http.Request) {
		path, method = r.URL.Path, r.Method
		_, _ = w.Write([]byte(`{"canaries":[]}`))
	})
	if _, err := Fetch(context.Background(), ic); err != nil {
		t.Fatal(err)
	}
	if path != "/control/canaries" || method != "GET" {
		t.Fatalf("%s %s", method, path)
	}
}

func TestFetchDecodesEntries(t *testing.T) {
	want := []Entry{{ID: id1, Path: "/opt/a/keys/id_rsa.bak", Type: "ssh_key", SHA256: strings.Repeat("a", 64), Status: "planted"}}
	ic := newClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"canaries": want})
	})
	got, err := Fetch(context.Background(), ic)
	if err != nil || len(got) != 1 || got[0] != want[0] {
		t.Fatalf("got %v err %v", got, err)
	}
}

// ---------------------------------------------------------------- Ack

type fakeSigner struct {
	events []map[string]interface{}
	err    error
}

func (f *fakeSigner) SignEvent(e map[string]interface{}) (map[string]interface{}, string, error) {
	if f.err != nil {
		return nil, "", f.err
	}
	f.events = append(f.events, e)
	b, _ := json.Marshal(e)
	return map[string]interface{}{"payload": string(b)}, "h", nil
}

type fakePoster struct {
	posts [][]byte
	err   error
}

func (f *fakePoster) Post(_ context.Context, b []byte) error {
	if f.err != nil {
		return f.err
	}
	f.posts = append(f.posts, b)
	return nil
}

func TestAckEmptyIDsSendsNothing(t *testing.T) {
	s, p := &fakeSigner{}, &fakePoster{}
	if err := Ack(context.Background(), s, p, nil); err != nil || len(p.posts) != 0 || len(s.events) != 0 {
		t.Fatalf("err=%v posts=%d events=%d", err, len(p.posts), len(s.events))
	}
}

func TestAckSignErrorStopsBeforePosting(t *testing.T) {
	s, p := &fakeSigner{err: errors.New("no key")}, &fakePoster{}
	if err := Ack(context.Background(), s, p, []string{id1}); err == nil {
		t.Fatal("expected error")
	}
	if len(p.posts) != 0 {
		t.Fatal("posted despite signing failure")
	}
}

func TestAckPostErrorIsReturned(t *testing.T) {
	s, p := &fakeSigner{}, &fakePoster{err: errors.New("503")}
	if err := Ack(context.Background(), s, p, []string{id1}); err == nil {
		t.Fatal("expected error")
	}
}

func TestAckEventShape(t *testing.T) {
	s, p := &fakeSigner{}, &fakePoster{}
	if err := Ack(context.Background(), s, p, []string{id1, id2}); err != nil {
		t.Fatal(err)
	}
	if len(s.events) != 1 || s.events[0]["type"] != "CANARY_CLEANUP" {
		t.Fatalf("events: %v", s.events)
	}
	ids, _ := s.events[0]["ids"].([]string)
	if len(ids) != 2 || ids[0] != id1 || ids[1] != id2 {
		t.Fatalf("ids: %v", s.events[0]["ids"])
	}
}

func TestAckChunksLargeBatches(t *testing.T) {
	s, p := &fakeSigner{}, &fakePoster{}
	var ids []string
	for i := 0; i < 450; i++ {
		ids = append(ids, fmt.Sprintf("00000000-0000-4000-8000-%012d", i))
	}
	if err := Ack(context.Background(), s, p, ids); err != nil {
		t.Fatal(err)
	}
	if len(p.posts) != 3 {
		t.Fatalf("posts = %d, want 3 chunks", len(p.posts))
	}
}

// ---------------------------------------------------------------- Sweep

func TestSweepFetchFailureIsReturnedAndNothingElseRuns(t *testing.T) {
	s, p := &fakeSigner{}, &fakePoster{}
	fetch := func(context.Context) ([]Entry, error) { return nil, errors.New("down") }
	if _, err := Sweep(context.Background(), fetch, s, p); err == nil {
		t.Fatal("expected error")
	}
	if len(p.posts) != 0 {
		t.Fatal("acked after failed fetch")
	}
}

func TestSweepNothingToDoSendsNoAck(t *testing.T) {
	s, p := &fakeSigner{}, &fakePoster{}
	fetch := func(context.Context) ([]Entry, error) { return nil, nil }
	n, err := Sweep(context.Background(), fetch, s, p)
	if err != nil || n != 0 || len(p.posts) != 0 {
		t.Fatalf("n=%d err=%v posts=%d", n, err, len(p.posts))
	}
}

func TestSweepSkippedEntriesAreNotAcked(t *testing.T) {
	d := t.TempDir()
	real := plainFile(t, d, "real.env", "KEEP=1\n")
	s, p := &fakeSigner{}, &fakePoster{}
	fetch := func(context.Context) ([]Entry, error) { return []Entry{entry(id1, real)}, nil }
	n, err := Sweep(context.Background(), fetch, s, p)
	if err != nil || n != 0 || len(p.posts) != 0 || !exists(real) {
		t.Fatalf("n=%d err=%v posts=%d exists=%v", n, err, len(p.posts), exists(real))
	}
}

func TestSweepRemovesAndAcks(t *testing.T) {
	d := t.TempDir()
	p1 := canaryFile(t, d, "a.env", id1)
	s, p := &fakeSigner{}, &fakePoster{}
	fetch := func(context.Context) ([]Entry, error) { return []Entry{entry(id1, p1)}, nil }
	n, err := Sweep(context.Background(), fetch, s, p)
	if err != nil || n != 1 || exists(p1) || len(p.posts) != 1 {
		t.Fatalf("n=%d err=%v exists=%v posts=%d", n, err, exists(p1), len(p.posts))
	}
}

func TestSweepAckFailureStillReportsRemovalAndReturnsError(t *testing.T) {
	d := t.TempDir()
	p1 := canaryFile(t, d, "a.env", id1)
	s, p := &fakeSigner{}, &fakePoster{err: errors.New("503")}
	fetch := func(context.Context) ([]Entry, error) { return []Entry{entry(id1, p1)}, nil }
	n, err := Sweep(context.Background(), fetch, s, p)
	if err == nil || n != 1 || exists(p1) {
		t.Fatalf("n=%d err=%v exists=%v", n, err, exists(p1))
	}
}

// ---------------------------------------------------------------- Without (never sweep live canaries)

func TestWithoutDropsEntriesMatchingActiveID(t *testing.T) {
	in := []Entry{entry(id1, "/a/one"), entry(id2, "/a/two")}
	got := Without(in, map[string]bool{id1: true}, nil)
	if len(got) != 1 || got[0].ID != id2 {
		t.Fatalf("got %v", got)
	}
}

func TestWithoutDropsEntriesMatchingActivePathEvenWithDifferentID(t *testing.T) {
	// A fresh decoy re-using a stale entry's path must not be swept.
	in := []Entry{entry(id1, "/opt/app/keys/id_rsa.bak")}
	got := Without(in, nil, map[string]bool{"/opt/app/keys/id_rsa.bak": true})
	if len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestWithoutIDMatchIsCaseInsensitive(t *testing.T) {
	in := []Entry{entry(strings.ToUpper(id1), "/a/one")}
	if got := Without(in, map[string]bool{id1: true}, nil); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestWithoutNilAndEmptyKeepEverything(t *testing.T) {
	in := []Entry{entry(id1, "/a/one"), entry(id2, "/a/two")}
	if got := Without(in, nil, nil); len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	if got := Without(nil, map[string]bool{id1: true}, nil); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestWithoutDoesNotMutateInput(t *testing.T) {
	in := []Entry{entry(id1, "/a/one"), entry(id2, "/a/two")}
	_ = Without(in, map[string]bool{id1: true}, nil)
	if in[0].ID != id1 || in[1].ID != id2 || len(in) != 2 {
		t.Fatalf("input mutated: %v", in)
	}
}

func TestWithoutEndToEndActiveCanaryIsNotDeleted(t *testing.T) {
	d := t.TempDir()
	live := canaryFile(t, d, "live.env", id1)
	stale := canaryFile(t, d, "stale.env", id2)
	entries := Without([]Entry{entry(id1, live), entry(id2, stale)}, map[string]bool{id1: true}, map[string]bool{live: true})
	Remove(entries)
	if !exists(live) || exists(stale) {
		t.Fatalf("live exists=%v (want true), stale exists=%v (want false)", exists(live), exists(stale))
	}
}
