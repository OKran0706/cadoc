//go:build linux
// +build linux

package auditmon

import (
	"fmt"
	"encoding/hex"
	"log"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/elastic/go-libaudit/auparse"
)

// Confidence represents the semantic trust in the reconstructed event.
type Confidence string

const (
	ConfComplete   Confidence = "COMPLETE"   // All expected fragments captured
	ConfIncomplete Confidence = "INCOMPLETE" // Missing context (e.g. CWD or PATH)
	ConfDropped    Confidence = "DROPPED"    // Event lost due to backpressure
)

// AuditEvent represents a fully (or partially) reconstructed audit interaction.
type AuditEvent struct {
	ID         string                 `json:"audit_id"`
	Timestamp  time.Time              `json:"ts"`
	Type       string                 `json:"type"`
	PID        int                    `json:"pid"`
	TID        int                    `json:"tid"`
	UID        int                    `json:"uid"`
	AUID       string                 `json:"auid,omitempty"` // login uid; 4294967295 = no login session
	Session    string                 `json:"ses,omitempty"`
	TTY        string                 `json:"tty,omitempty"`
	SrcIP      string                 `json:"src_ip,omitempty"` // remote address of the SSH login that owns Session
	User       string                 `json:"user,omitempty"`       // name for UID
	LoginUser  string                 `json:"login_user,omitempty"` // name for AUID: the person who logged in
	PPID       int                    `json:"ppid,omitempty"`
	ParentComm string                 `json:"parent_comm,omitempty"` // read from /proc at event time; empty if the parent already exited
	Success    bool                   `json:"success"`
	Exit       string                 `json:"exit,omitempty"`    // syscall return; negative = errno (e.g. -13 denied)
	Cmdline    string                 `json:"cmdline,omitempty"` // decoded PROCTITLE
	Comm      string                 `json:"comm"`
	Exe        string                 `json:"exe"`
	Path       string                 `json:"path"`
	DestPath   string                 `json:"dest_path,omitempty"`
	CWD        string                 `json:"cwd"`
	Op         string                 `json:"op"`         // e.g. READ, WRITE, RENAME, DELETE
	Confidence Confidence             `json:"confidence"`
	RawRecords []map[string]string    `json:"-"` // Hidden from JSON by default
}

// fillProcess copies who/what/how-it-went from a SYSCALL record. Caller holds a.mu.
func (a *Aggregator) fillProcess(e *AuditEvent, fields map[string]string) {
	e.AUID, e.Session, e.TTY = fields["auid"], fields["ses"], fields["tty"]
	e.SrcIP = a.srcIP(e.Session)
	e.User = a.userName(fields["uid"])
	if e.AUID != "4294967295" {
		e.LoginUser = a.userName(e.AUID)
	}
	fmt.Sscanf(fields["ppid"], "%d", &e.PPID)
	if e.PPID > 0 {
		if b, err := os.ReadFile("/proc/" + strconv.Itoa(e.PPID) + "/comm"); err == nil {
			e.ParentComm = strings.TrimSpace(string(b))
		}
	}
	e.Success = fields["success"] == "yes"
	e.Exit = fields["exit"]
}

// userName resolves a numeric uid to a login name ("" if unknown), cached.
func (a *Aggregator) userName(uid string) string {
	if uid == "" {
		return ""
	}
	if n, ok := a.names[uid]; ok {
		return n
	}
	name := ""
	if u, err := user.LookupId(uid); err == nil {
		name = u.Username
	}
	if len(a.names) >= 1024 { // ponytail: reset when full
		a.names = make(map[string]string)
	}
	a.names[uid] = name
	return name
}

// decodeProctitle turns a PROCTITLE record into a command line. The kernel hex-encodes the value
// (NUL-separated argv) unless it is a plain quoted string. Capped so one huge argv cannot bloat alerts.
func decodeProctitle(rec *auparse.AuditMessage) string {
	if rec == nil {
		return ""
	}
	i := strings.Index(rec.RawData, "proctitle=")
	if i < 0 {
		return ""
	}
	v := rec.RawData[i+len("proctitle="):]
	if j := strings.IndexByte(v, ' '); j >= 0 {
		v = v[:j]
	}
	if strings.HasPrefix(v, `"`) {
		v = strings.Trim(v, `"`)
	} else if b, err := hex.DecodeString(v); err == nil {
		v = strings.TrimSpace(strings.ReplaceAll(string(b), "\x00", " "))
	}
	if len(v) > 512 {
		v = v[:512] + "..."
	}
	return v
}

var (
	sesRe  = regexp.MustCompile(`\bses=(\d+)`)
	addrRe = regexp.MustCompile(`\baddr=([0-9a-fA-F:.]+)`)
)

// noteLogin remembers the remote address of a login session. sshd's USER_START (1105) and
// USER_LOGIN (1112) records carry ses= and addr=; sudo/su/cron records for the same session carry
// addr=? and are ignored so they cannot overwrite it. Caller holds a.mu.
func (a *Aggregator) noteLogin(raw string) {
	ses, addr := sesRe.FindStringSubmatch(raw), addrRe.FindStringSubmatch(raw)
	if ses == nil || addr == nil {
		return
	}
	if len(a.sessions) >= 4096 { // ponytail: reset when full, per-entry expiry if churn matters
		a.sessions = make(map[string]string)
	}
	a.sessions[ses[1]] = addr[1]
}

// srcIP returns the SSH client address for an audit session id, or "". Sessions that began before
// the plugin started were never seen in the audit stream, so fall back to the SSH_CONNECTION
// variable of any live process in that session (cached, including misses). Caller holds a.mu.
func (a *Aggregator) srcIP(ses string) string {
	if ses == "" || ses == "4294967295" {
		return ""
	}
	if ip, ok := a.sessions[ses]; ok {
		return ip
	}
	ip := ipFromProc(ses)
	a.sessions[ses] = ip
	return ip
}

// ipFromProc scans /proc for a process of session ses and reads the client IP from its environment.
// ponytail: full /proc scan on first sight of a session, acceptable at one per session.
func ipFromProc(ses string) string {
	dirs, _ := filepath.Glob("/proc/[0-9]*")
	for _, d := range dirs {
		if b, err := os.ReadFile(d + "/sessionid"); err != nil || strings.TrimSpace(string(b)) != ses {
			continue
		}
		env, err := os.ReadFile(d + "/environ")
		if err != nil {
			continue
		}
		for _, kv := range strings.Split(string(env), "\x00") {
			if v, ok := strings.CutPrefix(kv, "SSH_CONNECTION="); ok {
				if f := strings.Fields(v); len(f) > 0 {
					return f[0]
				}
			}
		}
	}
	return ""
}

// eventBuffer holds fragmented records for a single audit sequence.
type eventBuffer struct {
	id         string
	ts         time.Time
	pid        int
	tid        int
	syscall    *auparse.AuditMessage
	paths      []*auparse.AuditMessage
	cwd        *auparse.AuditMessage
	proctitle  *auparse.AuditMessage
	lastUpdate time.Time

	// Cached parsed fields
	syscallFields map[string]string
	pathsFields   []map[string]string
	cwdFields     map[string]string
}

// Aggregator handles the reassembly of interleaved audit records.
type Aggregator struct {
	mu         sync.Mutex
	buffers    map[string]*eventBuffer
	timeout    time.Duration
	maxBuffers int
	emitChan   chan *AuditEvent
	stopChan   chan struct{}
	canaryMap  map[string]bool // Thread-safe set of paths to monitor
	names      map[string]string    // uid -> user name cache
	sessions   map[string]string    // audit session id -> SSH client address ("" = not an SSH session)
	emitted    map[string]time.Time // recently emitted audit IDs: late fragments of them are dropped
}

// NewAggregator creates a new stateful audit aggregator.
func NewAggregator(timeout time.Duration, maxBuffers int, emitChanSize int) *Aggregator {
	a := &Aggregator{
		buffers:    make(map[string]*eventBuffer),
		canaryMap:  make(map[string]bool),
		emitted:    make(map[string]time.Time),
		sessions:   make(map[string]string),
		names:      make(map[string]string),
		timeout:    timeout,
		maxBuffers: maxBuffers,
		emitChan:   make(chan *AuditEvent, emitChanSize),
		stopChan:   make(chan struct{}),
	}
	go a.janitor()
	return a
}

// Stop shuts down the aggregator and its janitor goroutine.
func (a *Aggregator) Stop() {
	close(a.stopChan)
}

// SetWatchPaths updates the in-memory registry of paths to monitor.
func (a *Aggregator) SetWatchPaths(paths []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.canaryMap = make(map[string]bool)
	for _, p := range paths {
		a.canaryMap[p] = true
	}
	log.Printf("[auditmon] Canary Map updated: %d paths", len(paths))
}

// ProcessRecord ingests a single raw record and attempts to complete an event.
func (a *Aggregator) ProcessRecord(rec *auparse.AuditMessage) {
	a.mu.Lock()
	defer a.mu.Unlock()

	// 11.02a: Manually parse the Audit ID and Metadata from the raw message
	// Audit records look like: type=SYSCALL msg=audit(17137123.123:456): ...
	if rec.RecordType == 1105 || rec.RecordType == 1112 { // USER_START, USER_LOGIN
		a.noteLogin(rec.RawData)
		return
	}
	auditID := extractAuditID(rec.RawData)

	// Key: AuditID (it's unique per event across all processes/threads)
	key := auditID

	// Trailing records (PROCTITLE, extra PATH items) of an event we already emitted would otherwise
	// start a new, syscall-less buffer and be flushed later as a duplicate PID-less partial event.
	if _, done := a.emitted[key]; done {
		return
	}

	buf, ok := a.buffers[key]
	if !ok {
		// Backpressure check
		if len(a.buffers) >= a.maxBuffers {
			a.evictOldest()
		}
		buf = &eventBuffer{
			id:         auditID,
			ts:         time.Now(), // Fallback TS
			lastUpdate: time.Now(),
		}
		a.buffers[key] = buf
	}

	buf.lastUpdate = time.Now()

	// Fallback for record type if it's missing (e.g. from manual test feeds)
	recType := rec.RecordType
	if recType == 0 {
		typeStr := extractField(rec.RawData, "type")
		switch typeStr {
		case "SYSCALL":
			recType = 1300
		case "PATH":
			recType = 1302
		case "CWD":
			recType = 1307
		case "PROCTITLE":
			recType = 1327
		}
	}

	// Parse fields using auparse library
	fields, _ := rec.Data()

	// Categorize the record by its Type (uint16)
	switch recType {
	case 1300: // AUDIT_SYSCALL
		buf.syscall = rec
		buf.syscallFields = fields
		if fields["success"] == "" { // auparse's Data() omits success; take it from the raw line
			fields["success"] = extractField(rec.RawData, "success")
		}
		fmt.Sscanf(fields["pid"], "%d", &buf.pid)
		fmt.Sscanf(fields["tid"], "%d", &buf.tid)
	case 1302: // AUDIT_PATH
		buf.paths = append(buf.paths, rec)
		buf.pathsFields = append(buf.pathsFields, fields)
	case 1307: // AUDIT_CWD
		buf.cwd = rec
		buf.cwdFields = fields
	case 1327: // AUDIT_PROCTITLE
		buf.proctitle = rec
	}

	// Check for "Event Driven Completion"
	if a.isComplete(buf) {
		a.emit(key)
	}
}

// 11.02a: Helper for raw AuditID extraction
func extractAuditID(raw string) string {
	// msg=audit(17137123.123:456)
	start := strings.Index(raw, "audit(")
	if start == -1 {
		return fmt.Sprintf("unknown-%d", time.Now().UnixNano())
	}
	end := strings.Index(raw[start:], ")")
	if end == -1 {
		return fmt.Sprintf("unknown-%d", time.Now().UnixNano())
	}
	return raw[start+6 : start+end]
}

// isComplete determines if we have enough context to mark the event as high-confidence.
func (a *Aggregator) isComplete(buf *eventBuffer) bool {
	if buf.syscall == nil {
		return false
	}
	// We require at least the syscall record + one path record for canary monitoring
	if len(buf.paths) == 0 {
		return false
	}

	// PROCTITLE is the last record of an event; wait for it so the command line is included.
	// If it never comes, the janitor flushes the event as INCOMPLETE after the timeout.
	if buf.proctitle == nil {
		return false
	}

	// 13.2.3: Worker-side filtering
	// Check if any of the paths are in our Canary Map
	_, ok := a.matchedCanaryPath(buf)
	return ok
}

// absPath resolves a PATH record name against the event's CWD. auditd logs the name as the process
// passed it, so `cd /etc/app && cat config.yml.old` records a relative name.
func absPath(name, cwd string) string {
	name = strings.Trim(name, "\"")
	if name == "" {
		return ""
	}
	if !filepath.IsAbs(name) {
		if cwd == "" {
			return name
		}
		name = filepath.Join(cwd, name)
	}
	return filepath.Clean(name)
}

// matchedCanaryPath returns the first PATH record of buf (resolved to an absolute path) that is a canary.
func (a *Aggregator) matchedCanaryPath(buf *eventBuffer) (string, bool) {
	cwd := strings.Trim(buf.cwdFields["cwd"], "\"")
	for _, fields := range buf.pathsFields {
		if p := absPath(fields["name"], cwd); a.canaryMap[p] {
			return p, true
		}
	}
	return "", false
}

func (a *Aggregator) emit(key string) {
	buf, ok := a.buffers[key]
	if !ok {
		return
	}
	delete(a.buffers, key)
	a.emitted[key] = time.Now()

	event := &AuditEvent{
		ID:         buf.id,
		Timestamp:  buf.ts,
		Confidence: ConfComplete,
	}
	cwd := strings.Trim(buf.cwdFields["cwd"], "\"")

	// 1. Extract from SYSCALL record
	if buf.syscall != nil {
		fields := buf.syscallFields
		event.Type = "AUDIT_SYSCALL"
		fmt.Sscanf(fields["uid"], "%d", &event.UID)
		a.fillProcess(event, fields)
		event.Comm = strings.Trim(fields["comm"], "\"")
		event.Exe = strings.Trim(fields["exe"], "\"")
		fmt.Sscanf(fields["pid"], "%d", &event.PID)
		if tidVal, ok := fields["tid"]; ok {
			fmt.Sscanf(tidVal, "%d", &event.TID)
		}
		event.Op = opFor(fields)
	}
	event.Cmdline = decodeProctitle(buf.proctitle)

	// 2. Extract from PATH records
	if len(buf.paths) > 0 {
		if event.Op == "RENAME" {
			// For rename: item=2 is source, item=3 is dest.
			// Order is not guaranteed, so we check the "item" field.
			for _, fields := range buf.pathsFields {
				item := fields["item"]
				if item == "2" {
					event.Path = absPath(fields["name"], cwd)
				} else if item == "3" {
					event.DestPath = absPath(fields["name"], cwd)
				}
			}
		} else {
			// Fallback to the first path that matches a canary, or the last path record.
			path, _ := a.matchedCanaryPath(buf)
			if path == "" {
				// Last record often contains the actual file acted upon
				lastFields := buf.pathsFields[len(buf.pathsFields)-1]
				path = absPath(lastFields["name"], cwd)
			}
			event.Path = path
		}
	}

	// 3. Extract CWD
	if buf.cwd != nil {
		event.CWD = strings.Trim(buf.cwdFields["cwd"], "\"")
	}

	select {
	case a.emitChan <- event:
	default:
		log.Printf("[auditmon] Backpressure: emit channel full, dropping completed event %s", key)
	}
}

// janitor cleans up abandoned or timed-out fragmented events.
func (a *Aggregator) janitor() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-a.stopChan:
			return
		case <-ticker.C:
			a.checkTimeouts()
		}
	}
}

func (a *Aggregator) checkTimeouts() {
	a.mu.Lock()
	now := time.Now()
	// Keep emitted IDs long enough to swallow late fragments (a few timeouts), then forget them.
	for id, at := range a.emitted {
		if now.Sub(at) > 4*a.timeout+10*time.Second {
			delete(a.emitted, id)
		}
	}
	var toEmit []string
	for key, buf := range a.buffers {
		if now.Sub(buf.lastUpdate) > a.timeout {
			toEmit = append(toEmit, key)
		}
	}
	a.mu.Unlock()

	for _, key := range toEmit {
		log.Printf("[auditmon] Timeout for event %s (Partial Emission)", key)
		a.emitPartial(key)
	}
}

func (a *Aggregator) emitPartialUnlocked(key string) {
	buf, ok := a.buffers[key]
	if !ok {
		return
	}
	delete(a.buffers, key)
	a.emitted[key] = time.Now()

	// C-02: Gate partial events on canaryMap (same requirement as isComplete).
	if len(buf.paths) == 0 {
		return
	}

	// Nothing to emit if path not in canary map
	path, ok := a.matchedCanaryPath(buf)
	if !ok {
		return
	}

	event := &AuditEvent{
		ID:         buf.id,
		Timestamp:  buf.ts,
		PID:        buf.pid,
		TID:        buf.tid,
		Confidence: ConfIncomplete,
		Path:       path,
	}
	if buf.syscall != nil {
		fields := buf.syscallFields
		fmt.Sscanf(fields["uid"], "%d", &event.UID)
		a.fillProcess(event, fields)
		event.Comm = strings.Trim(fields["comm"], "\"")
		event.Exe = strings.Trim(fields["exe"], "\"")
		event.Op = opFor(fields)
	}
	event.Cmdline = decodeProctitle(buf.proctitle)
	select {
	case a.emitChan <- event:
	default:
		log.Printf("[auditmon] Backpressure: emit channel full, dropping partial event %s", key)
	}
}

func (a *Aggregator) emitPartial(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.emitPartialUnlocked(key)
}


// extractField is kept for compatibility with manual recType fallback but uses auparse.Data internally if possible
func extractField(data string, fieldName string) string {
	// For fallback, we still use the old method if we don't have an AuditMessage yet
	// Search for fieldName=
	target := fieldName + "="
	start := strings.Index(data, target)
	if start == -1 {
		return ""
	}

	// Advance past the target
	valStart := start + len(target)

	// If it's a quoted string, capture everything until the next quote
	if valStart < len(data) && data[valStart] == '"' {
		valStart++
		end := strings.Index(data[valStart:], "\"")
		if end == -1 {
			return data[valStart:]
		}
		return data[valStart : valStart+end]
	}

	// Otherwise, capture until the next space
	end := strings.Index(data[valStart:], " ")
	if end == -1 {
		return data[valStart:]
	}
	return data[valStart : valStart+end]
}

func (a *Aggregator) evictOldest() {
	// Simple strategy for now: evict first map entry
	for k := range a.buffers {
		log.Printf("[auditmon] Backpressure: evicting event %s", k)
		a.emitPartialUnlocked(k)
		break
	}
}

// Events returns the channel for completed audit events.
func (a *Aggregator) Events() <-chan *AuditEvent {
	return a.emitChan
}

// opFor classifies a SYSCALL record. auparse's Data() yields the syscall as a NAME ("openat") for
// known architectures, so a numeric Sscanf silently produced 0 (= READ) for every event. Names are
// handled first (architecture independent); a bare number falls back to the x86_64 table.
func opFor(fields map[string]string) string {
	sc := fields["syscall"]
	if n, err := strconv.Atoi(sc); err == nil {
		return identifyOp(n)
	}
	switch sc {
	case "read", "pread64", "readv", "preadv", "preadv2":
		return "READ"
	case "write", "pwrite64", "writev", "pwritev", "pwritev2", "creat":
		return "WRITE"
	case "open": // open(path, flags, mode)
		return openOp(fields["a1"])
	case "openat": // openat(dirfd, path, flags, mode)
		return openOp(fields["a2"])
	case "openat2": // flags live behind a struct pointer; cannot tell read from write
		return "OPEN"
	case "rename", "renameat", "renameat2":
		return "RENAME"
	case "unlink", "unlinkat", "rmdir":
		return "DELETE"
	case "chmod", "fchmod", "fchmodat", "fchmodat2":
		return "CHMOD"
	case "chown", "fchown", "lchown", "fchownat":
		return "CHOWN"
	case "truncate", "ftruncate":
		return "TRUNCATE"
	case "symlink", "symlinkat":
		return "SYMLINK"
	case "link", "linkat":
		return "LINK"
	case "mknod", "mknodat":
		return "MKNOD"
	}
	return "OTHER"
}

// openOp tells a read-only open (OPEN) from one that can modify the file (WRITE). Flag values for
// these bits are the same on x86_64 and arm64.
func openOp(flagsHex string) string {
	const wrBits = 0x1 | 0x2 | 0x40 | 0x200 | 0x400 // O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND
	flags, err := strconv.ParseUint(flagsHex, 16, 64)
	if err != nil || flags&wrBits == 0 {
		return "OPEN"
	}
	return "WRITE"
}

// identifyOp maps a syscall number to a high-level operation name.
// These are standard x86_64 syscall numbers.
func identifyOp(sys int) string {
	switch sys {
	case 0, 17, 19: // read, pread64, readv
		return "READ"
	case 2, 257: // open, openat
		return "OPEN"
	case 1, 18, 20: // write, pwrite64, writev
		return "WRITE"
	case 82, 264, 316: // rename, renameat, renameat2
		return "RENAME"
	case 87, 263: // unlink, unlinkat
		return "DELETE"
	case 90, 91, 268: // chmod, fchmod, fchmodat
		return "CHMOD"
	case 92, 93, 94: // chown, fchown, lchown
		return "CHOWN"
	case 76, 77: // truncate, ftruncate
		return "TRUNCATE"
	case 88, 266: // symlink, symlinkat
		return "SYMLINK"
	case 86, 265: // link, linkat
		return "LINK"
	case 133, 259: // mknod, mknodat
		return "MKNOD"
	default:
		return "OTHER"
	}
}
