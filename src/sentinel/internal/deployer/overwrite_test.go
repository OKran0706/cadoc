package deployer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const realContent = "REAL=do-not-touch\n"

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

// ---------- canOverwrite: negative first ----------

func TestCanOverwriteRefusesRealFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "real.env")
	writeFile(t, p, realContent)
	if canOverwrite(p) {
		t.Fatal("real file must not be overwritable")
	}
}

func TestCanOverwriteRefusesEmptyFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "empty")
	writeFile(t, p, "")
	if canOverwrite(p) {
		t.Fatal("empty non-canary file must not be overwritable")
	}
}

func TestCanOverwriteRefusesDirectory(t *testing.T) {
	d := filepath.Join(t.TempDir(), "sub")
	if err := os.Mkdir(d, 0700); err != nil {
		t.Fatal(err)
	}
	if canOverwrite(d) {
		t.Fatal("directory must not be overwritable")
	}
}

func TestCanOverwriteRefusesSymlinkEvenToACanary(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	writeFile(t, target, "x\n# __CANARY_ID__=abc\n")
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if canOverwrite(link) {
		t.Fatal("symlink must never be overwritten (would write through to the target)")
	}
}

func TestCanOverwriteRefusesMarkerOnlyInMiddleOfLargeFile(t *testing.T) {
	// The marker is appended at the end by Deploy; one buried mid-file is not ours.
	p := filepath.Join(t.TempDir(), "big.sql")
	writeFile(t, p, strings.Repeat("a", 20000)+"# __CANARY_ID__=abc\n"+strings.Repeat("b", 20000))
	if canOverwrite(p) {
		t.Fatal("marker in the middle of a large real file must not count")
	}
}

func TestCanOverwriteAllowsMissingPath(t *testing.T) {
	if !canOverwrite(filepath.Join(t.TempDir(), "nope")) {
		t.Fatal("non-existent path is free to create")
	}
}

func TestCanOverwriteAllowsPreviousCanary(t *testing.T) {
	p := filepath.Join(t.TempDir(), "old.env")
	writeFile(t, p, "KEY=v\n\n# __CANARY_ID__=1234\n")
	if !canOverwrite(p) {
		t.Fatal("a previously planted canary (marker at end) may be rotated in place")
	}
}

func TestCanOverwriteAllowsLargePreviousCanary(t *testing.T) {
	p := filepath.Join(t.TempDir(), "dump.sql")
	writeFile(t, p, strings.Repeat("INSERT ...;\n", 5000)+"\n# __CANARY_ID__=1234\n")
	if !canOverwrite(p) {
		t.Fatal("large previous canary with trailing marker must be recognised")
	}
}

// ---------- Deploy never destroys real files ----------

func TestDeployStaticNeverOverwritesRealFiles(t *testing.T) {
	target := t.TempDir()
	for _, n := range []string{".env.production.bak", ".env.staging", "app_secrets.env"} {
		writeFile(t, filepath.Join(target, n), realContent)
	}
	entries, err := Deploy(deployProfile(target, "realistic", 2), writeEnvTemplate(t), false)
	if err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	for _, n := range []string{".env.production.bak", ".env.staging", "app_secrets.env"} {
		b, _ := os.ReadFile(filepath.Join(target, n))
		if string(b) != realContent {
			t.Fatalf("real file %q was modified", n)
		}
	}
	for _, e := range entries {
		b, _ := os.ReadFile(e.Path)
		if !strings.Contains(string(b), "__CANARY_ID__="+e.ID) {
			t.Fatalf("planted file %q is not a canary", e.Path)
		}
	}
}

func TestDeployMLFallbackNeverOverwritesRealFiles(t *testing.T) {
	// Unknown-style dir full of real pool-named files: ml must fall through safely.
	target := t.TempDir()
	for _, n := range []string{".env.production.bak", ".env.staging", "app_secrets.env"} {
		writeFile(t, filepath.Join(target, n), realContent)
	}
	if _, err := Deploy(deployProfile(target, "ml", 3), writeEnvTemplate(t), false); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	for _, n := range []string{".env.production.bak", ".env.staging", "app_secrets.env"} {
		b, _ := os.ReadFile(filepath.Join(target, n))
		if string(b) != realContent {
			t.Fatalf("real file %q was modified", n)
		}
	}
}

func TestDeployDoesNotWriteThroughSymlink(t *testing.T) {
	target := t.TempDir()
	victim := filepath.Join(t.TempDir(), "victim")
	writeFile(t, victim, realContent)
	if err := os.Symlink(victim, filepath.Join(target, ".env.staging")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	_ = os.Symlink(victim, filepath.Join(target, ".env.production.bak"))
	_ = os.Symlink(victim, filepath.Join(target, "app_secrets.env"))
	if _, err := Deploy(deployProfile(target, "realistic", 1), writeEnvTemplate(t), false); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	b, _ := os.ReadFile(victim)
	if string(b) != realContent {
		t.Fatal("canary was written through a symlink into another file")
	}
}

func TestDeployRotationMayReplacePreviousCanary(t *testing.T) {
	target := t.TempDir()
	tdir := writeEnvTemplate(t)
	first, err := Deploy(deployProfile(target, "realistic", 3), tdir, false)
	if err != nil || len(first) != 3 {
		t.Fatalf("first deploy: %v (%d)", err, len(first))
	}
	// All three pool names now hold canaries; a second rotation reuses them in place.
	second, err := Deploy(deployProfile(target, "realistic", 3), tdir, false)
	if err != nil {
		t.Fatalf("rotation must be able to replace its own canaries: %v", err)
	}
	if len(second) != 3 {
		t.Fatalf("got %d entries", len(second))
	}
}

func TestDeployRefusesAtWriteTimeIfPathBecameRealFile(t *testing.T) {
	// Defence in depth: even if selection was fooled, the write itself must refuse.
	target := t.TempDir()
	p := filepath.Join(target, "x.env")
	writeFile(t, p, realContent)
	if err := plant(p, "NEW\n"); err == nil {
		t.Fatal("plant must refuse to overwrite a real file")
	}
	b, _ := os.ReadFile(p)
	if string(b) != realContent {
		t.Fatal("real file modified by plant")
	}
}
