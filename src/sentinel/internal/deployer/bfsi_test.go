package deployer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const (
	realTemplates = "../../templates"
	realConfig    = "../../../../config"
	installScript = "../../../../scripts/install-sentinel.sh"
)

// The decoy names an attacker sees must read as bank assets, and the file contents must agree with the name.

func TestBankPoolsContainRequiredNames(t *testing.T) {
	all := map[string]bool{}
	for _, names := range namePools {
		for _, n := range names {
			all[n] = true
		}
	}
	for _, want := range []string{
		"swift_mt103_gateway.env", "pci_dss_token_vault.key",
		"core_banking_clearing_creds.json", "ach_wire_staging_2025.sql.gz",
	} {
		if !all[want] {
			t.Errorf("namePools missing %q", want)
		}
	}
}

func TestPoolNamesAreValidAndPlentiful(t *testing.T) {
	dir := t.TempDir()
	for typ, names := range namePools {
		if len(names) < 6 {
			t.Errorf("%s: want >= 6 names, have %d", typ, len(names))
		}
		for _, n := range names {
			if !validName(n, dir, nil, map[string]bool{}) {
				t.Errorf("%s: %q fails validName", typ, n)
			}
		}
	}
}

func TestPoolExtensionsMatchTemplateContent(t *testing.T) {
	envRE := regexp.MustCompile(`(^\.env(\.\w+)?$)|(\.env(\.(bak|old|orig))?$)`)
	want := map[string]*regexp.Regexp{
		"ssh_key":              regexp.MustCompile(`\.(key|pem)(\.(bak|old))?$`),
		"serviceaccount_token": regexp.MustCompile(`\.(key|pem)(\.(bak|old))?$`),
		"config_backup":        envRE,
		"env_file":             envRE,
		"kubeconfig_backup":    regexp.MustCompile(`\.conf(\.(bak|old))?$`),
		"db_dump":              regexp.MustCompile(`\.(sql|sql\.gz|tar\.gz)$`),
		"credentials":          regexp.MustCompile(`\.json(\.(bak|old))?$`),
	}
	for typ, re := range want {
		if len(namePools[typ]) == 0 {
			t.Errorf("%s: no pool", typ)
		}
		for _, n := range namePools[typ] {
			if !re.MatchString(n) {
				t.Errorf("%s: %q does not look like %s", typ, n, re)
			}
		}
	}
}

func TestColdStartNamesComeFromTheBankPool(t *testing.T) {
	for typ, pool := range namePools {
		in := map[string]bool{}
		for _, n := range pool {
			in[n] = true
		}
		dir := t.TempDir()
		for i := 0; i < 20; i++ {
			got := staticFilename(typ, dir, map[string]bool{}, newRNG(int64(i)))
			if !in[got] || strings.Contains(got, "canary") {
				t.Fatalf("%s: static name %q not from pool", typ, got)
			}
		}
		if n := adaptiveFilename(typ, dir, map[string]bool{}, newRNG(7)); n == "" || strings.Contains(n, "canary") {
			t.Fatalf("%s: ml cold-start name %q", typ, n)
		}
	}
}

func render(t *testing.T, typ string) string {
	t.Helper()
	p := selectTemplate(realTemplates, typ)
	if p == "" {
		t.Fatalf("no template for %s", typ)
	}
	out, err := renderTemplate(p, TemplateData{AppName: "bfsi-payments", BlendedDate: "2026-07-11", CanaryUUID: "u"})
	if err != nil {
		t.Fatalf("render %s: %v", typ, err)
	}
	return out
}

func TestTemplatesCarryBankContent(t *testing.T) {
	for _, typ := range []string{"env_file", "config_backup"} {
		out := render(t, typ)
		if !strings.Contains(out, "SWIFT_BIC=") || !strings.Contains(out, "MT103") {
			t.Errorf("%s: no SWIFT/MT103 settings:\n%s", typ, out)
		}
	}
	out := render(t, "db_dump")
	if !strings.Contains(out, "ach_batches") || !strings.Contains(out, "wire_transfers") {
		t.Errorf("db_dump has no ACH/wire tables:\n%s", out)
	}
	if out := render(t, "ssh_key"); !strings.Contains(out, "BEGIN OPENSSH PRIVATE KEY") {
		t.Errorf("key template lost its PEM armor")
	}
	for _, typ := range []string{"kubeconfig_backup", "serviceaccount_token"} {
		if strings.TrimSpace(render(t, typ)) == "" {
			t.Errorf("%s renders empty", typ)
		}
	}
}

func TestCredentialsTemplateIsClearingJSON(t *testing.T) {
	out := render(t, "credentials")
	if strings.Contains(strings.ToLower(out), "aws_") {
		t.Fatalf("still an AWS credentials file:\n%s", out)
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("not valid JSON (%v):\n%s", err, out)
	}
	for _, k := range []string{"clearing_house", "client_id", "client_secret"} {
		if _, ok := v[k]; !ok {
			t.Errorf("missing key %q", k)
		}
	}
}

func TestEveryProfileUsesKnownTypes(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(realConfig, "profiles", "*.yaml"))
	if len(files) == 0 {
		t.Fatal("no profiles found")
	}
	for _, f := range files {
		var p Profile
		b, _ := os.ReadFile(f)
		if err := yaml.Unmarshal(b, &p); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		for _, d := range p.TargetDirectories {
			if tp := selectTemplate(realTemplates, d.CanaryType); tp == "" {
				t.Errorf("%s: type %q has no template mapping", f, d.CanaryType)
			} else if _, err := os.Stat(tp); err != nil {
				t.Errorf("%s: template for %q missing: %v", f, d.CanaryType, err)
			}
			if len(namePools[d.CanaryType]) == 0 {
				t.Errorf("%s: type %q has no name pool", f, d.CanaryType)
			}
		}
	}
}

func TestBFSIProfileDeploysBankDecoys(t *testing.T) {
	p, err := LoadProfile(realConfig, "bfsi-payments")
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "bfsi-payments" || p.NamingStrategy != "ml" {
		t.Fatalf("profile = %+v", p)
	}
	root, total := t.TempDir(), 0
	for i := range p.TargetDirectories {
		d := &p.TargetDirectories[i]
		if !strings.HasPrefix(d.Path, "/opt/bank/") && !strings.HasPrefix(d.Path, "/var/backups/bank") {
			t.Errorf("unexpected directory %s", d.Path)
		}
		total += d.Count
		d.Path = filepath.Join(root, strings.TrimPrefix(d.Path, "/"))
	}
	entries, err := Deploy(p, realTemplates, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != total || total < 8 {
		t.Fatalf("planted %d, want %d (>= 8)", len(entries), total)
	}
	for _, e := range entries {
		b, err := os.ReadFile(e.Path)
		if err != nil || !strings.Contains(string(b), "__CANARY_ID__="+e.ID) {
			t.Errorf("%s: missing file or marker (%v)", e.Path, err)
		}
		base := strings.ToLower(filepath.Base(e.Path))
		for _, w := range bannedWords {
			if strings.Contains(base, w) {
				t.Errorf("%s contains banned word %q", base, w)
			}
		}
	}
}

func TestTemplateHelpers(t *testing.T) {
	td := TemplateData{}
	if d := td.RandomDigits(12); !regexp.MustCompile(`^\d{12}$`).MatchString(d) {
		t.Errorf("RandomDigits = %q", d)
	}
	if td.RandomDigits(0) != "" {
		t.Error("RandomDigits(0) should be empty")
	}
	if iban := td.FakeIBAN(); !regexp.MustCompile(`^GB\d{2}[A-Z]{4}\d{14}$`).MatchString(iban) {
		t.Errorf("FakeIBAN = %q", iban)
	}
}

func TestInstallerAllowsBFSIProfile(t *testing.T) {
	b, err := os.ReadFile(installScript)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, "app-server|db-server|k8s-node|bfsi-payments)") {
		t.Error("profile allowlist does not include bfsi-payments")
	}
	if !strings.Contains(s, "bfsi-payments") {
		t.Error("usage text should mention bfsi-payments")
	}
}
