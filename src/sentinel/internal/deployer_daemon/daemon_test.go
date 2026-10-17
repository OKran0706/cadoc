package deployer_daemon

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/your-org/canary/sentinel/internal/deployer"
)

func TestRemoveStaleKeepsReusedPaths(t *testing.T) {
	dir := t.TempDir()
	reused, gone := filepath.Join(dir, "id_rsa_backup"), filepath.Join(dir, "old.env")
	for _, p := range []string{reused, gone} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	removeStale(
		[]deployer.CanaryEntry{{Path: reused}, {Path: gone}},
		[]deployer.CanaryEntry{{Path: reused}},
	)
	if _, err := os.Stat(reused); err != nil {
		t.Fatalf("freshly planted decoy at a reused path was deleted: %v", err)
	}
	if _, err := os.Stat(gone); !os.IsNotExist(err) {
		t.Fatalf("stale decoy was not removed: %v", err)
	}
}
