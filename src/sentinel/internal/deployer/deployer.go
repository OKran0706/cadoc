// canary-system/src/canary_deployer/internal/deployer/deployer.go
// Profile-based canary file deployment and template rendering.
// Derived from: file-canary-engine/SKILL.md

package deployer

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"text/template"
	"time"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"

	"github.com/your-org/canary/sentinel/internal/sysutil"
)

// Profile defines a server canary deployment profile.
type Profile struct {
	Name              string            `yaml:"profile"`
	TargetDirectories []TargetDir       `yaml:"target_directories"`
	NamingStrategy    string            `yaml:"naming_strategy"`
	TimestampStrategy string            `yaml:"timestamp_strategy"`
	PermissionStrat   string            `yaml:"permission_strategy"`
}

// TargetDir is a directory/canary-type pair in a profile.
type TargetDir struct {
	Path      string `yaml:"path"`
	CanaryType string `yaml:"canary_type"`
	Count     int    `yaml:"count"`
	BlendWith string `yaml:"blend_with"`
}

// CanaryMap is the JSON registry of all planted canaries.
type CanaryMap struct {
	Version     string        `json:"version"`
	GeneratedAt string        `json:"generated_at"`
	Host        string        `json:"host"`
	Canaries    []CanaryEntry `json:"canaries"`
}

// CanaryEntry is a single canary file record.
type CanaryEntry struct {
	ID           string `json:"id"`
	Path         string `json:"path"`
	Type         string `json:"type"`
	SHA256       string `json:"sha256"`
	PlantedAt    string `json:"planted_at"`
	BlendedMtime string `json:"blended_mtime"`
	Profile      string `json:"profile"`
}

// TemplateData provides functions and data to Go text/template files.
type TemplateData struct {
	AppName     string
	BlendedDate string
	CanaryUUID  string
}

// RandomAlpha returns a random alphabetic string of length n.
func (td TemplateData) RandomAlpha(n int) string {
	return sysutil.RandomAlpha(n)
}

// RandomBase64 returns a random base64-encoded string of length n.
func (td TemplateData) RandomBase64(n int) string {
	return sysutil.RandomBase64(n)
}

// RandomHex returns a random hex string of length n.
func (td TemplateData) RandomHex(n int) string {
	return sysutil.RandomHex(n)
}

// FakeSSHKeyBody returns a base64 block resembling an SSH private key body.
func (td TemplateData) FakeSSHKeyBody() string {
	buf := make([]byte, 256)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("Critical entropy failure during FakeSSHKeyBody generation: %v", err)
	}
	return base64.StdEncoding.EncodeToString(buf)
}

// LoadProfile reads a YAML profile from the config directory.
func LoadProfile(configDir, profileName string) (*Profile, error) {
	path := filepath.Join(configDir, "profiles", profileName+".yaml")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read profile %s: %w", path, err)
	}

	var profile Profile
	if err := yaml.Unmarshal(data, &profile); err != nil {
		return nil, fmt.Errorf("parse profile %s: %w", path, err)
	}

	return &profile, nil
}

// DetectProfile determines the server profile from hostname patterns.
func DetectProfile(configDir string) (string, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return "app-server", fmt.Errorf("detect profile: os.Hostname(): %w", err)
	}
	h := strings.ToLower(hostname)

	switch {
	case strings.Contains(h, "k8s") || strings.Contains(h, "kube") || strings.Contains(h, "node"):
		return "k8s-node", nil
	case strings.Contains(h, "db") || strings.Contains(h, "postgres") || strings.Contains(h, "mysql"):
		return "db-server", nil
	default:
		return "app-server", nil
	}
}

// Deploy generates and plants canary files based on a profile.
func Deploy(profile *Profile, templateDir string, dryRun bool) ([]CanaryEntry, error) {
	var entries []CanaryEntry
	rng := newSeededRNG()
	usedByDir := map[string]map[string]bool{}

	for _, target := range profile.TargetDirectories {
		used := usedByDir[target.Path]
		if used == nil {
			used = map[string]bool{}
			usedByDir[target.Path] = used
		}
		for i := 0; i < target.Count; i++ {
			canaryID := uuid.New().String()

			// Select template
			tmplPath := selectTemplate(templateDir, target.CanaryType)
			if tmplPath == "" {
				return nil, fmt.Errorf("no template for canary type: %s", target.CanaryType)
			}

			// Generate filename
			filename := pickFilename(profile.NamingStrategy, target.CanaryType, target.Path, used, rng)
			used[filename] = true
			outputPath := filepath.Join(target.Path, filename)

			now := time.Now().UTC()
			data := TemplateData{
				AppName:     profile.Name,
				BlendedDate: now.AddDate(0, -3, -7).Format("2006-01-02"),
				CanaryUUID:  canaryID,
			}

			if dryRun {
				entries = append(entries, CanaryEntry{
					ID:        canaryID,
					Path:      outputPath,
					Type:      target.CanaryType,
					SHA256:    "(dry run)",
					PlantedAt: now.Format(time.RFC3339),
					Profile:   profile.Name,
				})
				continue
			}

			// Ensure target directory exists
			if err := os.MkdirAll(target.Path, 0700); err != nil {
				return nil, fmt.Errorf("create target directory %s: %w", target.Path, err)
			}

			// Render template
			content, err := renderTemplate(tmplPath, data)
			if err != nil {
				return nil, fmt.Errorf("render template for %s: %w", outputPath, err)
			}

			// Append canary marker
			content += fmt.Sprintf("\n# __CANARY_ID__=%s\n", canaryID)

			// Write file
			if err := plant(outputPath, content); err != nil {
				return nil, fmt.Errorf("write canary file %s: %w", outputPath, err)
			}

			// Calculate hash
			hash := sha256.Sum256([]byte(content))

			// Blend timestamps with neighbor files
			blendTimestamp(outputPath, target.Path)

			entries = append(entries, CanaryEntry{
				ID:           canaryID,
				Path:         outputPath,
				Type:         target.CanaryType,
				SHA256:       hex.EncodeToString(hash[:]),
				PlantedAt:    now.Format(time.RFC3339),
				BlendedMtime: getBlendedMtime(target.Path),
				Profile:      profile.Name,
			})
		}
	}

	return entries, nil
}

func selectTemplate(templateDir, canaryType string) string {
	typeToDir := map[string]string{
		"ssh_key":             "keys/ssh_private_key.tmpl",
		"config_backup":      "configs/env_file.tmpl",
		"db_dump":            "dumps/pg_dump.tmpl",
		"env_file":           "configs/env_file.tmpl",
		"credentials":        "credentials/aws_credentials.tmpl",
		"kubeconfig_backup":  "configs/env_file.tmpl",
		"serviceaccount_token": "keys/ssh_private_key.tmpl",
	}

	rel, ok := typeToDir[canaryType]
	if !ok {
		return ""
	}
	return filepath.Join(templateDir, rel)
}

func renderTemplate(tmplPath string, data TemplateData) (string, error) {
	tmpl, err := template.ParseFiles(tmplPath)
	if err != nil {
		return "", fmt.Errorf("parse template: %w", err)
	}

	var buf strings.Builder
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("execute template: %w", err)
	}

	return buf.String(), nil
}

func blendTimestamp(canaryPath, dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.Name() == filepath.Base(canaryPath) || e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if err := os.Chtimes(canaryPath, info.ModTime(), info.ModTime()); err != nil {
			// Non-fatal: blending is a best-effort operation.
			// Log and continue — canary will still be active.
			log.Printf("[deployer] blendTimestamp: chtimes %s: %v", canaryPath, err)
		}
		return
	}
	
	// If no suitable file was found, fall back to the directory's mtime
	if info, err := os.Stat(dir); err == nil {
		_ = os.Chtimes(canaryPath, info.ModTime(), info.ModTime())
	}
}

func getBlendedMtime(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		return info.ModTime().Format(time.RFC3339)
	}
	// Fall back to directory mtime or current time
	if info, err := os.Stat(dir); err == nil {
		return info.ModTime().Format(time.RFC3339)
	}
	return time.Now().UTC().Format(time.RFC3339)
}

