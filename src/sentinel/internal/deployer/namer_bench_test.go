package deployer

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// BenchmarkAdaptiveFilename measures one full decoy-name generation (read the directory, train the
// character 5-gram model on the sibling names, sample and validate candidates) at several directory sizes.
func BenchmarkAdaptiveFilename(b *testing.B) {
	exts := []string{".env", ".conf", ".sql.gz", ".json", ".bak", ".pem"}
	for _, siblings := range []int{5, 50, 500} {
		b.Run(fmt.Sprintf("siblings=%d", siblings), func(b *testing.B) {
			dir := b.TempDir()
			for i := 0; i < siblings; i++ {
				name := fmt.Sprintf("payments_batch_%04d_prod%s", i, exts[i%len(exts)])
				if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0600); err != nil {
					b.Fatal(err)
				}
			}
			rng := rand.New(rand.NewSource(1))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if adaptiveFilename("env_file", dir, map[string]bool{}, rng) == "" {
					b.Fatal("empty name")
				}
			}
		})
	}
}
