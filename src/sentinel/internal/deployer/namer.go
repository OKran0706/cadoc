// Adaptive canary filename generation: a small character n-gram language model is trained on
// the target directory's own filenames and sampled to produce names in the same style.
// Runs on-box in microseconds with no external model. Falls back to the static pools.

package deployer

import (
	"bytes"
	crand "crypto/rand"
	"encoding/binary"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxNameLen   = 64
	ngramOrder   = 5
	digitMark    = '' // private-use base; digitMark+k stands for a run of k digits while training
	maxDigitRun  = 15
	sampleTries  = 40
	minRepeat    = 3 // shortest block (runes) treated as a degenerate repeat while sampling
	mutationOdds = 4 // 1-in-N chance to prefer a sibling-derived backup name
)

// namePools are the static per-type names: banking/fintech assets, so every profile reads as a bank. They seed the model
// when a directory has too few siblings to learn from, and back the non-ML strategies.
var namePools = map[string][]string{
	"ssh_key": {"pci_dss_token_vault.key", "hsm_wrapping_key_backup.pem", "swift_lau_signing_key.pem.old",
		"card_pin_block_zpk.key.bak", "payment_gateway_tls_2025.key", "tokenization_master.key.old", "issuer_cvk_backup.pem"},
	"config_backup": {"payment_switch_prod.env.bak", "ach_batch_scheduler.env.old", "fx_rates_feed.env.bak",
		"treasury_gateway.env", "card_issuer_processor.env.old", "recon_engine_prod.env.bak", "ledger_sync_worker.env"},
	"db_dump": {"ach_wire_staging_2025.sql.gz", "core_banking_ledger_2025q3.sql.gz", "kyc_customer_master_export.sql",
		"card_transactions_archive_2025.sql.gz", "nostro_vostro_recon_dump.sql", "loan_origination_prod.sql.gz", "sanctions_screening_backup.tar.gz"},
	"env_file": {"swift_mt103_gateway.env", "swift_alliance_access.env.bak", "core_banking_api.env",
		"payments_hub_prod.env.old", ".env.payments", ".env.treasury", "sepa_instant_gateway.env"},
	"credentials": {"core_banking_clearing_creds.json", "nostro_account_api_keys.json.old", "card_processor_credentials.json",
		"swift_service_bureau_auth.json.bak", "rtgs_participant_creds.json", "upi_psp_credentials.json.old", "payment_hub_oauth_clients.json"},
	"kubeconfig_backup": {"payments-cluster-admin.conf.bak", "treasury-gateway.conf", "core-banking-cluster.conf.old",
		"swift-gw-prod.conf.bak", "settlement-cluster.conf", "card-switch-admin.conf.old"},
	"serviceaccount_token": {"swift_alliance_signing.key.old", "clearing_hsm_session.pem.bak", "treasury_api_signing.key",
		"nostro_recon_service.pem", "payments_gateway_client.key.bak", "upi_switch_signing.pem"},
}

var (
	bannedWords    = []string{"canary", "honey", "decoy", "trap", "fake"}
	compoundExts   = []string{".sql.gz", ".tar.gz", ".tar.bz2", ".tar.xz"}
	backupExts     = map[string]bool{".bak": true, ".old": true, ".orig": true, ".backup": true, ".save": true, "~": true}
	backupSuffixes = []string{".bak", ".old", ".orig"}
	tempSuffixes   = []string{".tmp", ".swp", ".swx", ".lock", "~"}
	dateDashedRE   = regexp.MustCompile("--")
	dateCompactRE  = regexp.MustCompile("")
)

// validName is the single gate every candidate (model output, mutation, pool) must pass.
func validName(name, dir string, siblings []string, used map[string]bool) bool {
	if name == "" || len(name) > maxNameLen || name != strings.TrimSpace(name) {
		return false
	}
	if strings.Trim(name, ".") == "" || strings.Contains(name, "..") {
		return false
	}
	if strings.ContainsAny(name, `/\`) || repeatedSegment(name) {
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	lower := strings.ToLower(name)
	for _, w := range bannedWords {
		if strings.Contains(lower, w) {
			return false
		}
	}
	if used[name] {
		return false
	}
	for _, s := range siblings {
		if s == name {
			return false
		}
	}
	if _, err := os.Lstat(filepath.Join(dir, name)); err == nil {
		return false
	}
	return true
}

// splitName separates the stem from the extension, keeping compound extensions (.sql.gz) whole
// and treating a leading dot alone (.bashrc) as part of the stem.
func splitName(name string) (stem, ext string) {
	for _, c := range compoundExts {
		if strings.HasSuffix(name, c) && len(name) > len(c) {
			return strings.TrimSuffix(name, c), c
		}
	}
	if i := strings.LastIndex(name, "."); i > 0 {
		return name[:i], name[i:]
	}
	return name, ""
}

// ngram is a character-level language model with backoff to shorter contexts.
type ngram struct {
	n int
	c map[string]map[rune]int
}

func newNgram(n int) *ngram { return &ngram{n: n, c: map[string]map[rune]int{}} }

func (m *ngram) train(s string) {
	r := []rune(strings.Repeat("^", m.n-1) + s + "$")
	for i := m.n - 1; i < len(r); i++ {
		for l := 0; l < m.n; l++ {
			key := string(r[i-l : i])
			if m.c[key] == nil {
				m.c[key] = map[rune]int{}
			}
			m.c[key][r[i]]++
		}
	}
}

func (m *ngram) next(ctx []rune, rng *rand.Rand) (rune, bool) {
	for l := m.n - 1; l >= 0; l-- {
		counts := m.c[string(ctx[len(ctx)-l:])]
		if len(counts) == 0 {
			continue
		}
		keys := make([]rune, 0, len(counts))
		total := 0
		for k, v := range counts {
			keys = append(keys, k)
			total += v
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] }) // deterministic for a seed
		pick := rng.Intn(total)
		for _, k := range keys {
			pick -= counts[k]
			if pick < 0 {
				return k, true
			}
		}
	}
	return 0, false
}

func (m *ngram) sample(rng *rand.Rand, maxLen int) string {
	ctx := []rune(strings.Repeat("^", m.n-1))
	var out []rune
	for len(out) < maxLen {
		r, ok := m.next(ctx, rng)
		if !ok || r == '$' {
			break
		}
		out = append(out, r)
		if k := repeatTail(out); k > 0 { // break Markov cycles like ".env.env.env"
			out = out[:len(out)-k]
			break
		}
		ctx = append(append([]rune{}, ctx[1:]...), r)
	}
	return string(out)
}

// repeatTail returns the length of a block (>= minRepeat runes) that out ends with twice in a
// row, or 0.
func repeatTail(out []rune) int {
	for k := minRepeat; 2*k <= len(out); k++ {
		if string(out[len(out)-k:]) == string(out[len(out)-2*k:len(out)-k]) {
			return k
		}
	}
	return 0
}

// repeatedSegment reports a name with identical adjacent dot-separated segments (a.env.env).
func repeatedSegment(name string) bool {
	p := strings.Split(name, ".")
	for i := 1; i < len(p); i++ {
		if p[i] != "" && p[i] == p[i-1] {
			return true
		}
	}
	return false
}

// normalizeDigits collapses each digit run into one token carrying its length, so the model
// learns shapes like DDDD-DD-DD instead of drifting run lengths.
func normalizeDigits(s string) string {
	var b strings.Builder
	run := 0
	flush := func() {
		if run > 0 {
			if run > maxDigitRun {
				run = maxDigitRun
			}
			b.WriteRune(digitMark + rune(run))
			run = 0
		}
	}
	for _, r := range s {
		if r >= '0' && r <= '9' {
			run++
			continue
		}
		flush()
		b.WriteRune(r)
	}
	flush()
	return b.String()
}

// fillDigits turns digit placeholders back into digits; date-shaped runs become a plausible
// recent date. ponytail: random date in the last year, not fitted to the siblings' date range.
func fillDigits(s string, rng *rand.Rand) string {
	day := func() time.Time {
		return time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, -rng.Intn(365))
	}
	s = dateDashedRE.ReplaceAllStringFunc(s, func(string) string { return day().Format("2006-01-02") })
	s = dateCompactRE.ReplaceAllStringFunc(s, func(string) string { return day().Format("20060102") })
	var b strings.Builder
	for _, r := range s {
		if r > digitMark && r <= digitMark+maxDigitRun {
			for i := rune(0); i < r-digitMark; i++ {
				b.WriteRune(rune('0' + rng.Intn(10)))
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func skipSibling(n string) bool {
	if len(n) > maxNameLen || strings.HasPrefix(n, "~$") || strings.Contains(n, "..") {
		return true
	}
	for _, r := range n {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	lower := strings.ToLower(n)
	for _, w := range bannedWords {
		if strings.Contains(lower, w) {
			return true
		}
	}
	for _, s := range tempSuffixes {
		if strings.HasSuffix(n, s) {
			return true
		}
	}
	return false
}

// readSiblings returns every entry name (for copy detection) and the regular, non-temp,
// non-suspicious files worth learning from.
func readSiblings(dir string) (all, usable []string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil
	}
	for _, e := range entries {
		n := e.Name()
		all = append(all, n)
		if e.Type().IsRegular() && !skipSibling(n) {
			usable = append(usable, n)
		}
	}
	return all, usable
}

func filterValid(cands []string, dir string, all []string, used map[string]bool) []string {
	var out []string
	for _, c := range cands {
		if validName(c, dir, all, used) {
			out = append(out, c)
		}
	}
	return out
}

// adaptiveFilename returns a name that blends with dir's existing files, or "" if none passed
// validation (caller falls back to the static pool).
func adaptiveFilename(canaryType, dir string, used map[string]bool, rng *rand.Rand) string {
	all, usable := readSiblings(dir)
	pool := namePools[canaryType]
	cold := len(usable) < 3

	m := newNgram(ngramOrder)
	var exts, muts []string
	trained := false
	train := func(stem string, weight int) {
		for i := 0; i < weight; i++ {
			m.train(normalizeDigits(stem))
		}
		trained = true
	}

	for _, s := range usable {
		stem, ext := splitName(s)
		train(stem, 3)
		exts = append(exts, ext)
		if !backupExts[ext] {
			for _, sfx := range backupSuffixes {
				muts = append(muts, s+sfx)
			}
		}
	}
	if cold {
		for _, p := range pool {
			stem, ext := splitName(p)
			train(stem, 1)
			exts = append(exts, ext)
		}
	}

	var gen []string
	if trained && len(exts) > 0 {
		for i := 0; i < sampleTries; i++ {
			stem := m.sample(rng, maxNameLen-8)
			if len([]rune(stem)) < 2 {
				continue
			}
			gen = append(gen, fillDigits(stem, rng)+exts[rng.Intn(len(exts))])
		}
	}
	if cold {
		gen = append(gen, pool...)
	}

	vg := filterValid(gen, dir, all, used)
	vm := filterValid(muts, dir, all, used)
	pick := vg
	switch {
	case len(vg) > 0 && len(vm) > 0:
		if rng.Intn(mutationOdds) == 0 {
			pick = vm
		}
	case len(vg) == 0:
		pick = vm
	}
	if len(pick) == 0 {
		return ""
	}
	return pick[rng.Intn(len(pick))]
}

// canOverwrite reports whether path is free to plant a canary on: it does not exist, or it is a
// regular file this system planted earlier (marker near the end, where Deploy appends it).
// Real files, symlinks and directories are never overwritable.
func canOverwrite(path string) bool {
	fi, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return true
	}
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	off := fi.Size() - 4096
	if off < 0 {
		off = 0
	}
	buf := make([]byte, fi.Size()-off)
	n, _ := f.ReadAt(buf, off)
	return bytes.Contains(buf[:n], []byte("__CANARY_ID__="))
}

// plant writes a canary, refusing to touch anything that is not a prior canary. A new path is
// created with O_EXCL so a file or symlink appearing in between is not clobbered.
// ponytail: replacing an existing canary is check-then-write (small race); fine while the dirs
// are root-owned, use renameat2/O_NOFOLLOW if untrusted users can write there.
func plant(path, content string) error {
	if !canOverwrite(path) {
		return fmt.Errorf("refusing to overwrite non-canary path %s", path)
	}
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return err
		}
		_, werr := f.WriteString(content)
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		return werr
	}
	return os.WriteFile(path, []byte(content), 0644)
}

// staticFilename picks from the type's pool without repeating a name used this run or landing
// on a real file in dir.
func staticFilename(canaryType, dir string, used map[string]bool, rng *rand.Rand) string {
	names := namePools[canaryType]
	if len(names) == 0 {
		return fmt.Sprintf("canary_%s_%d", canaryType, time.Now().UnixNano())
	}
	free := func(n string) bool { return !used[n] && canOverwrite(filepath.Join(dir, n)) }
	for _, i := range rng.Perm(len(names)) {
		if free(names[i]) {
			return names[i]
		}
	}
	base := names[rng.Intn(len(names))]
	for i := 1; ; i++ { // pool exhausted: numbered variant, always terminates
		if n := base + "." + strconv.Itoa(i); free(n) {
			return n
		}
	}
}

// pickFilename applies the profile's naming strategy ("ml" = adaptive, anything else = static pool).
func pickFilename(strategy, canaryType, dir string, used map[string]bool, rng *rand.Rand) string {
	if strategy == "ml" {
		if n := adaptiveFilename(canaryType, dir, used, rng); n != "" {
			return n
		}
	}
	return staticFilename(canaryType, dir, used, rng)
}

func newSeededRNG() *rand.Rand {
	var b [8]byte
	seed := time.Now().UnixNano()
	if _, err := crand.Read(b[:]); err == nil {
		seed = int64(binary.LittleEndian.Uint64(b[:]))
	}
	return rand.New(rand.NewSource(seed))
}
