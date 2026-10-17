package fingerprint

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var hexRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

const (
	mid  = "6c1f0b7e3a2d4f5c9e8a7b6d5c4e3f2a"
	puid = "4C4C4544-0050-3510-8052-B8C04F4C4E32"
)

// ---------------------------------------------------------------- Compute: negative

func TestComputeEmptyMachineIDYieldsNothing(t *testing.T) {
	for _, m := range []string{"", " ", "\n", "\t \n"} {
		if got := Compute("acme", m, puid); got != "" {
			t.Errorf("Compute(machine-id=%q) = %q, want empty", m, got)
		}
	}
}

func TestComputeEmptySlugYieldsNothing(t *testing.T) {
	for _, s := range []string{"", " ", "\n"} {
		if got := Compute(s, mid, puid); got != "" {
			t.Errorf("Compute(slug=%q) = %q, want empty", s, got)
		}
	}
}

func TestComputeIgnoresPlaceholderProductUUIDs(t *testing.T) {
	want := Compute("acme", mid, "")
	for _, p := range []string{
		"00000000-0000-0000-0000-000000000000",
		"FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
		"Not Settable", "not specified", "Unknown", "To Be Filled By O.E.M.", "  ", "\n",
	} {
		if got := Compute("acme", mid, p); got != want {
			t.Errorf("placeholder product_uuid %q changed the fingerprint", p)
		}
	}
}

func TestComputeSeparatesTheTwoInputs(t *testing.T) {
	if Compute("acme", "abcd", "ef01") == Compute("acme", "abc", "def01") {
		t.Fatal("input boundary is ambiguous")
	}
}

func TestComputeDiffersAcrossTenants(t *testing.T) {
	if Compute("acme", mid, puid) == Compute("globex", mid, puid) {
		t.Fatal("fingerprint must not be comparable across tenants")
	}
}

func TestComputeDiffersAcrossMachines(t *testing.T) {
	if Compute("acme", mid, puid) == Compute("acme", "0123456789abcdef0123456789abcdef", puid) {
		t.Fatal("different machine-id gave the same fingerprint")
	}
	if Compute("acme", mid, puid) == Compute("acme", mid, "4C4C4544-0050-3510-8052-000000000000") {
		t.Fatal("different product_uuid gave the same fingerprint")
	}
}

func TestComputeDoesNotLeakRawIDs(t *testing.T) {
	got := Compute("acme", mid, puid)
	if strings.Contains(got, mid) || strings.Contains(strings.ToLower(got), strings.ToLower(puid)) {
		t.Fatal("raw identifiers present in output")
	}
}

// ---------------------------------------------------------------- Compute: positive

func TestComputeShapeAndDeterminism(t *testing.T) {
	a, b := Compute("acme", mid, puid), Compute("acme", mid, puid)
	if !hexRE.MatchString(a) || a != b {
		t.Fatalf("a=%q b=%q", a, b)
	}
}

func TestComputeNormalisesWhitespaceAndCase(t *testing.T) {
	base := Compute("acme", mid, puid)
	for name, got := range map[string]string{
		"trailing newline": Compute("acme", mid+"\n", puid+"\n"),
		"surrounding ws":   Compute("acme", "  "+mid+"\t", " "+puid+" "),
		"upper machine-id": Compute("acme", strings.ToUpper(mid), puid),
		"lower product":    Compute("acme", mid, strings.ToLower(puid)),
	} {
		if got != base {
			t.Errorf("%s changed the fingerprint", name)
		}
	}
}

func TestComputeWorksWithoutProductUUID(t *testing.T) {
	a := Compute("acme", mid, "")
	if !hexRE.MatchString(a) || a != Compute("acme", mid, "") {
		t.Fatalf("machine-id-only fingerprint unstable: %q", a)
	}
}

// ---------------------------------------------------------------- ReadFrom

func write(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadFromMissingMachineIDYieldsNothing(t *testing.T) {
	d := t.TempDir()
	if got := ReadFrom("acme", filepath.Join(d, "nope"), write(t, d, "pu", puid)); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestReadFromEmptyMachineIDFileYieldsNothing(t *testing.T) {
	d := t.TempDir()
	if got := ReadFrom("acme", write(t, d, "mid", "\n"), write(t, d, "pu", puid)); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestReadFromDirectoryInsteadOfFileYieldsNothing(t *testing.T) {
	d := t.TempDir()
	if got := ReadFrom("acme", d, write(t, d, "pu", puid)); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestReadFromUnreadableProductUUIDFallsBackToMachineID(t *testing.T) {
	d := t.TempDir()
	m := write(t, d, "mid", mid+"\n")
	got := ReadFrom("acme", m, filepath.Join(d, "missing-product-uuid"))
	if got == "" || got != Compute("acme", mid, "") {
		t.Fatalf("got %q, want machine-id-only fingerprint", got)
	}
}

func TestReadFromBoundsFileSize(t *testing.T) {
	d := t.TempDir()
	huge := write(t, d, "mid", strings.Repeat("a", 10<<20))
	if got := ReadFrom("acme", huge, write(t, d, "pu", puid)); got != "" && !hexRE.MatchString(got) {
		t.Fatalf("malformed output %q", got)
	}
}

func TestReadFromMatchesCompute(t *testing.T) {
	d := t.TempDir()
	got := ReadFrom("acme", write(t, d, "mid", mid+"\n"), write(t, d, "pu", puid+"\n"))
	if got != Compute("acme", mid, puid) {
		t.Fatalf("got %q", got)
	}
}

func TestSlugOf(t *testing.T) {
	cases := map[string]string{
		"mock-acme.34d0222e-5f7b-4b7f-b1be-023377ec8f8f": "mock-acme",
		"acme.edge-01": "acme",
		"":             "",
		"noseparator":  "",
		".id":          "",
		"acme.":        "",
	}
	for in, want := range cases {
		if got := SlugOf(in); got != want {
			t.Errorf("SlugOf(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---------------------------------------------------------------- Emit

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
	n   int
	err error
}

func (f *fakePoster) Post(context.Context, []byte) error {
	if f.err != nil {
		return f.err
	}
	f.n++
	return nil
}

func TestEmitEmptyFingerprintSendsNothing(t *testing.T) {
	s, p := &fakeSigner{}, &fakePoster{}
	if err := Emit(context.Background(), s, p, ""); err != nil || p.n != 0 || len(s.events) != 0 {
		t.Fatalf("err=%v posts=%d events=%d", err, p.n, len(s.events))
	}
}

func TestEmitRejectsMalformedFingerprint(t *testing.T) {
	for _, fp := range []string{"abc", strings.Repeat("g", 64), strings.Repeat("A", 64), strings.Repeat("a", 65)} {
		s, p := &fakeSigner{}, &fakePoster{}
		if err := Emit(context.Background(), s, p, fp); err == nil || p.n != 0 {
			t.Errorf("fp %q: err=%v posts=%d", fp, err, p.n)
		}
	}
}

func TestEmitSignErrorStopsBeforePosting(t *testing.T) {
	s, p := &fakeSigner{err: errors.New("no key")}, &fakePoster{}
	if err := Emit(context.Background(), s, p, strings.Repeat("a", 64)); err == nil || p.n != 0 {
		t.Fatalf("err=%v posts=%d", err, p.n)
	}
}

func TestEmitPostErrorIsReturned(t *testing.T) {
	s, p := &fakeSigner{}, &fakePoster{err: errors.New("503")}
	if err := Emit(context.Background(), s, p, strings.Repeat("a", 64)); err == nil {
		t.Fatal("expected error")
	}
}

func TestEmitEventShapeCarriesOnlyTypeAndFingerprint(t *testing.T) {
	s, p := &fakeSigner{}, &fakePoster{}
	fp := strings.Repeat("a", 64)
	if err := Emit(context.Background(), s, p, fp); err != nil || p.n != 1 {
		t.Fatalf("err=%v posts=%d", err, p.n)
	}
	e := s.events[0]
	if e["type"] != "SENTINEL_FINGERPRINT" || e["fingerprint"] != fp || len(e) != 2 {
		t.Fatalf("event: %v", e)
	}
}
