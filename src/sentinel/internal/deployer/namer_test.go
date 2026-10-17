package deployer

import (
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func newRNG(seed int64) *rand.Rand { return rand.New(rand.NewSource(seed)) }

func touch(t *testing.T, dir string, names ...string) {
	t.Helper()
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0600); err != nil {
			t.Fatalf("touch %q: %v", n, err)
		}
	}
}

// ---------- validName: negative cases first ----------

func TestValidNameRejects(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "exists.env")
	siblings := []string{"exists.env", "app.yml"}
	used := map[string]bool{"taken.bak": true}

	cases := map[string]string{
		"empty":           "",
		"dotdot":          "..",
		"dotdot-prefix":   "../etc/passwd",
		"embedded-dotdot": "a..b/../c",
		"slash":           "a/b",
		"backslash":       `a\b`,
		"nul":             "a\x00b",
		"newline":         "a\nb",
		"too-long":        strings.Repeat("a", 65),
		"existing-file":   "exists.env",
		"used-this-run":   "taken.bak",
		"sibling-copy":    "app.yml",
		"banned-canary":   "canary_backup.sql",
		"banned-upper":    "CANARY.env",
		"banned-mid":      "db_Honey_2024.sql",
		"banned-decoy":    "decoy.key",
		"banned-trap":     "my-trap.conf",
		"banned-fake":     "fake_creds.json",
		"banned-honeypot": "honeypot.txt",
		"only-dots":       "...",
		"single-dot":      ".",
		"leading-space":   " id_rsa",
		"trailing-space":  "id_rsa ",
		"control-char":    "id\x07rsa",
		"repeated-seg":    "app.config.yml.env.env.env",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if validName(in, dir, siblings, used) {
				t.Fatalf("validName(%q) = true, want false", in)
			}
		})
	}
}

func TestValidNameAccepts(t *testing.T) {
	dir := t.TempDir()
	for _, in := range []string{"pg_backup_2025-02-27.sql.gz", ".env.production.bak", "id_rsa.bak", strings.Repeat("a", 64)} {
		if !validName(in, dir, nil, map[string]bool{}) {
			t.Errorf("validName(%q) = false, want true", in)
		}
	}
}

func TestValidNameNilUsedMapDoesNotPanic(t *testing.T) {
	if !validName("ok.bak", t.TempDir(), nil, nil) {
		t.Fatal("expected ok.bak valid with nil used map")
	}
}

func TestSampleBreaksRepeatLoop(t *testing.T) {
	m := newNgram(ngramOrder)
	m.train("app.config.yml.env.env.env.env.env.env.env.env") // no EOS-reachable exit but a cycle
	for seed := int64(0); seed < 50; seed++ {
		if s := m.sample(newRNG(seed), maxNameLen); repeatTail([]rune(s)) != 0 {
			t.Fatalf("seed %d: sample %q ends in a repeated block", seed, s)
		}
	}
}

// ---------- splitName ----------

func TestSplitName(t *testing.T) {
	cases := []struct{ in, stem, ext string }{
		{"pg_backup_2025-01-14.sql.gz", "pg_backup_2025-01-14", ".sql.gz"},
		{"db.tar.gz", "db", ".tar.gz"},
		{"app.yml.bak", "app.yml", ".bak"},
		{".env.staging", ".env", ".staging"},
		{"id_rsa", "id_rsa", ""},
		{".bashrc", ".bashrc", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		stem, ext := splitName(c.in)
		if stem != c.stem || ext != c.ext {
			t.Errorf("splitName(%q) = (%q,%q), want (%q,%q)", c.in, stem, ext, c.stem, c.ext)
		}
	}
}

// ---------- adaptiveFilename: negative / robustness ----------

func assertAllValid(t *testing.T, canaryType, dir string, siblings []string, n int) {
	t.Helper()
	sibSet := map[string]bool{}
	for _, s := range siblings {
		sibSet[s] = true
	}
	rng := newRNG(1)
	for i := 0; i < n; i++ {
		used := map[string]bool{}
		got := adaptiveFilename(canaryType, dir, used, rng)
		if got == "" {
			continue // allowed: caller falls back to the static list
		}
		if sibSet[got] {
			t.Fatalf("iteration %d: copied sibling %q", i, got)
		}
		if !validName(got, dir, nil, map[string]bool{}) {
			t.Fatalf("iteration %d: produced invalid name %q", i, got)
		}
	}
}

func TestAdaptiveNeverEscapesValidation(t *testing.T) {
	dir := t.TempDir()
	sib := []string{"pg_backup_2025-01-14.sql.gz", "pg_backup_2025-02-11.sql.gz", "mysql_full_2025-03-09.tar.gz"}
	touch(t, dir, sib...)
	assertAllValid(t, "db_dump", dir, sib, 500)
}

func TestAdaptiveUnknownTypeNoPanic(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "a.conf")
	_ = adaptiveFilename("no_such_type", dir, map[string]bool{}, newRNG(2))
}

func TestAdaptiveMissingDirFallsBackToPool(t *testing.T) {
	got := adaptiveFilename("env_file", filepath.Join(t.TempDir(), "does-not-exist"), map[string]bool{}, newRNG(3))
	if got == "" {
		t.Fatal("expected a pool-based name for unreadable/missing dir, got empty")
	}
	if !validName(got, t.TempDir(), nil, map[string]bool{}) {
		t.Fatalf("invalid fallback name %q", got)
	}
}

func TestAdaptiveEmptyDirUsesTypePool(t *testing.T) {
	got := adaptiveFilename("ssh_key", t.TempDir(), map[string]bool{}, newRNG(4))
	if got == "" {
		t.Fatal("expected pool-based name in empty dir")
	}
}

func TestAdaptiveOnlyDirsSymlinksAndTempFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0700); err != nil {
		t.Fatal(err)
	}
	touch(t, dir, ".swp", "~$lock.docx", "a.tmp", ".lock")
	// A symlink is skipped (best effort: Windows may refuse without privilege).
	_ = os.Symlink(filepath.Join(dir, "a.tmp"), filepath.Join(dir, "link"))
	got := adaptiveFilename("env_file", dir, map[string]bool{}, newRNG(5))
	if got == "" {
		t.Fatal("expected pool-based name when siblings are unusable")
	}
	for _, bad := range []string{"subdir", ".swp", "a.tmp", ".lock", "link"} {
		if got == bad {
			t.Fatalf("returned unusable sibling %q", bad)
		}
	}
}

func TestAdaptiveHostileSiblingNames(t *testing.T) {
	dir := t.TempDir()
	hostile := []string{
		strings.Repeat("A", 200),
		"héllo wörld ünï.sql",
		"a b c.env",
		"CANARY_old.env",
	}
	touch(t, dir, hostile...)
	assertAllValid(t, "env_file", dir, hostile, 300)
}

func TestAdaptiveNeverLeaksBannedWordFromSiblings(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "honeypot_config.env", "decoy_settings.env", "trap.env")
	rng := newRNG(6)
	banned := regexp.MustCompile(`(?i)canary|honey|decoy|trap|fake`)
	for i := 0; i < 300; i++ {
		got := adaptiveFilename("env_file", dir, map[string]bool{}, rng)
		if banned.MatchString(got) {
			t.Fatalf("banned word leaked into %q", got)
		}
	}
}

func TestPickFilenameNeverRepeatsWithinRun(t *testing.T) {
	for _, strategy := range []string{"ml", "realistic"} {
		dir := t.TempDir()
		used := map[string]bool{}
		rng := newRNG(7)
		for i := 0; i < 25; i++ {
			got := pickFilename(strategy, "env_file", dir, used, rng)
			if got == "" {
				t.Fatalf("%s: empty name on pick %d", strategy, i)
			}
			if used[got] {
				t.Fatalf("%s: duplicate %q on pick %d", strategy, got, i)
			}
			used[got] = true
		}
	}
}

func TestAdaptiveReturnsEmptyWhenEverythingTaken(t *testing.T) {
	dir := t.TempDir()
	used := map[string]bool{}
	rng := newRNG(8)
	// Exhaust the namespace the generator can reach.
	for i := 0; i < 5000; i++ {
		got := adaptiveFilename("kubeconfig_backup", dir, used, rng)
		if got == "" {
			return // exhausted -> caller falls back; this is the expected terminal state
		}
		used[got] = true
	}
	// Reaching here means the generator never runs out; acceptable only if names stay unique.
}

// ---------- adaptiveFilename: positive style mimicry ----------

func TestAdaptiveMimicsDirectoryStyle(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "pg_backup_2025-01-14.sql.gz", "pg_backup_2025-02-11.sql.gz", "pg_backup_2025-03-09.sql.gz")
	rng := newRNG(9)
	dateShape := regexp.MustCompile(`\d{4}-\d{2}-\d{2}`)
	hits := 0
	for i := 0; i < 100; i++ {
		got := adaptiveFilename("db_dump", dir, map[string]bool{}, rng)
		if got == "" {
			continue
		}
		if strings.HasSuffix(got, ".sql.gz") && strings.Contains(got, "_") && dateShape.MatchString(got) {
			hits++
		}
	}
	if hits < 60 {
		t.Fatalf("only %d/100 names matched the directory style (_ separator, date, .sql.gz)", hits)
	}
}

func TestAdaptiveMutatesSiblingWithBackupSuffix(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "app.yml", "database.yml", "redis.yml")
	rng := newRNG(10)
	found := false
	for i := 0; i < 200 && !found; i++ {
		got := adaptiveFilename("config_backup", dir, map[string]bool{}, rng)
		for _, sfx := range []string{".bak", ".old", ".orig", "~"} {
			if strings.HasSuffix(got, ".yml"+sfx) {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("never produced a sibling-derived backup name like database.yml.bak")
	}
}

func TestAdaptiveDeterministicWithSameSeed(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "id_rsa", "id_rsa.pub", "known_hosts")
	a := adaptiveFilename("ssh_key", dir, map[string]bool{}, newRNG(42))
	b := adaptiveFilename("ssh_key", dir, map[string]bool{}, newRNG(42))
	if a != b {
		t.Fatalf("same seed gave %q and %q", a, b)
	}
}

// ---------- Deploy integration ----------

func deployProfile(dir, strategy string, count int) *Profile {
	return &Profile{
		Name:           "test",
		NamingStrategy: strategy,
		TargetDirectories: []TargetDir{
			{Path: dir, CanaryType: "env_file", Count: count},
		},
	}
}

func writeEnvTemplate(t *testing.T) string {
	t.Helper()
	tdir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tdir, "configs"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tdir, "configs", "env_file.tmpl"), []byte("KEY=value\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return tdir
}

func TestDeployMLCountThreeProducesDistinctFiles(t *testing.T) {
	target := t.TempDir()
	touch(t, target, "app.env", "worker.env")
	entries, err := Deploy(deployProfile(target, "ml", 3), writeEnvTemplate(t), false)
	if err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("got %d entries, want 3", len(entries))
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if seen[e.Path] {
			t.Fatalf("duplicate path %q: later canary overwrote the earlier one", e.Path)
		}
		seen[e.Path] = true
		if _, err := os.Stat(e.Path); err != nil {
			t.Fatalf("planted file missing: %v", err)
		}
	}
}

func TestDeployStaticStrategyAlsoAvoidsDuplicates(t *testing.T) {
	target := t.TempDir()
	entries, err := Deploy(deployProfile(target, "realistic", 3), writeEnvTemplate(t), false)
	if err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if seen[e.Path] {
			t.Fatalf("duplicate path %q under static naming", e.Path)
		}
		seen[e.Path] = true
	}
}

func TestDeployMLNeverOverwritesExistingNonCanaryFile(t *testing.T) {
	target := t.TempDir()
	touch(t, target, ".env.production.bak", ".env.staging", "app_secrets.env")
	before := map[string]string{}
	for _, n := range []string{".env.production.bak", ".env.staging", "app_secrets.env"} {
		b, _ := os.ReadFile(filepath.Join(target, n))
		before[n] = string(b)
	}
	if _, err := Deploy(deployProfile(target, "ml", 2), writeEnvTemplate(t), false); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	for n, want := range before {
		got, _ := os.ReadFile(filepath.Join(target, n))
		if string(got) != want {
			t.Fatalf("existing file %q was overwritten", n)
		}
	}
}

func TestDeployMLUnknownTypeErrorsLikeBefore(t *testing.T) {
	p := &Profile{NamingStrategy: "ml", TargetDirectories: []TargetDir{{Path: t.TempDir(), CanaryType: "bogus", Count: 1}}}
	if _, err := Deploy(p, writeEnvTemplate(t), false); err == nil {
		t.Fatal("expected error for unknown canary type (no template)")
	}
}

func TestDeployDryRunCreatesNothing(t *testing.T) {
	target := t.TempDir()
	entries, err := Deploy(deployProfile(target, "ml", 2), writeEnvTemplate(t), true)
	if err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries", len(entries))
	}
	files, _ := os.ReadDir(target)
	if len(files) != 0 {
		t.Fatalf("dry run created %d files", len(files))
	}
	if entries[0].Path == entries[1].Path {
		t.Fatal("dry run planned duplicate paths")
	}
}
