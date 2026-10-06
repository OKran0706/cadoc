//go:build linux
// +build linux

package auditmon

import (
	"fmt"
	"log"
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
	Comm       string                 `json:"comm"`
	Exe        string                 `json:"exe"`
	Path       string                 `json:"path"`
	DestPath   string                 `json:"dest_path,omitempty"`
	CWD        string                 `json:"cwd"`
	Op         string                 `json:"op"`         // e.g. READ, WRITE, RENAME, DELETE
	Confidence Confidence             `json:"confidence"`
	RawRecords []map[string]string    `json:"-"` // Hidden from JSON by default
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
}

// Aggregator handles the reassembly of interleaved audit records.
type Aggregator struct {
	mu           sync.Mutex
	buffers      map[string]*eventBuffer
	timeout      time.Duration
	maxBuffers   int
	emitChan     chan *AuditEvent
	stopChan     chan struct{}
	canaryMap    map[string]bool // Thread-safe set of paths to monitor
}

// NewAggregator creates a new stateful audit aggregator.
func NewAggregator(timeout time.Duration, maxBuffers int) *Aggregator {
	a := &Aggregator{
		buffers:    make(map[string]*eventBuffer),
		canaryMap:  make(map[string]bool),
		timeout:    timeout,
		maxBuffers: maxBuffers,
		emitChan:   make(chan *AuditEvent, 1000),
		stopChan:   make(chan struct{}),
	}
	go a.janitor()
	return a
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
	auditID := extractAuditID(rec.RawData)
	
	// Key: AuditID (it's unique per event across all processes/threads)
	key := auditID

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
			recType = 1323
		}
	}

	// Categorize the record by its Type (uint16)
	switch recType {
	case 1300: // AUDIT_SYSCALL
		buf.syscall = rec
	case 1302: // AUDIT_PATH
		buf.paths = append(buf.paths, rec)
	case 1307: // AUDIT_CWD
		buf.cwd = rec
	case 1323: // AUDIT_PROCTITLE
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
		return "unknown"
	}
	end := strings.Index(raw[start:], ")")
	if end == -1 {
		return "unknown"
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

	// 13.2.3: Worker-side filtering
	// Check if any of the paths are in our Canary Map
	for _, pRec := range buf.paths {
		path := strings.Trim(extractString(pRec, "name"), "\"")
		if a.canaryMap[path] {
			return true
		}
	}
	
	return false
}

func (a *Aggregator) emit(key string) {
	buf, ok := a.buffers[key]
	if !ok {
		return
	}
	delete(a.buffers, key)

	event := &AuditEvent{
		ID:         buf.id,
		Timestamp:  buf.ts,
		Confidence: ConfComplete,
	}

	// 1. Extract from SYSCALL record
	if buf.syscall != nil {
		event.Type = "AUDIT_SYSCALL"
		event.UID = extractInt(buf.syscall, "uid")
		event.Comm = extractString(buf.syscall, "comm")
		event.Exe = extractString(buf.syscall, "exe")
		// Extract PID from SYSCALL data manually
		event.PID = extractInt(buf.syscall, "pid")
		event.Op = identifyOp(extractInt(buf.syscall, "syscall"))
	}

	// 2. Extract from PATH records
	if len(buf.paths) > 0 {
		// Usually index 0 or last index depending on syscall.
		// For rename: index 2 is source, index 3 is dest.
		if event.Op == "RENAME" && len(buf.paths) >= 4 {
			event.Path = extractString(buf.paths[2], "name")
			event.DestPath = extractString(buf.paths[3], "name")
		} else {
			// Fallback to the first path that matches or just the first path
			event.Path = extractString(buf.paths[len(buf.paths)-1], "name")
		}
	}

	// 3. Extract CWD
	if buf.cwd != nil {
		event.CWD = extractString(buf.cwd, "cwd")
	}

	a.emitChan <- event
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

func (a *Aggregator) emitPartial(key string) {
	a.mu.Lock()
	buf, ok := a.buffers[key]
	if !ok {
		a.mu.Unlock()
		return
	}
	delete(a.buffers, key)
	a.mu.Unlock()

	// C-02: Gate partial events on canaryMap — same requirement as isComplete().
	if len(buf.paths) == 0 {
		return
	}
	
	var path string
	found := false
	a.mu.Lock()
	for _, pRec := range buf.paths {
		p := strings.Trim(extractString(pRec, "name"), "\"")
		if a.canaryMap[p] {
			path = p
			found = true
			break
		}
	}
	a.mu.Unlock()
	
	if !found {
		return
	}

	event := &AuditEvent{
		ID:         buf.id,
		Timestamp:  buf.ts,
		PID:        buf.pid,
		Confidence: ConfIncomplete,
		Path:       path,
	}
	if buf.syscall != nil {
		event.UID = extractInt(buf.syscall, "uid")
		event.Comm = extractString(buf.syscall, "comm")
		event.Exe = extractString(buf.syscall, "exe")
		event.Op = identifyOp(extractInt(buf.syscall, "syscall"))
	}
	a.emitChan <- event
}

// 11.02a: Implementation of manual field extraction helpers
func extractString(msg *auparse.AuditMessage, fieldName string) string {
	return extractField(msg.RawData, fieldName)
}

func extractInt(msg *auparse.AuditMessage, fieldName string) int {
	val := extractField(msg.RawData, fieldName)
	var i int
	fmt.Sscanf(val, "%d", &i)
	return i
}

func extractField(data string, fieldName string) string {
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
		a.emitPartial(k) 
		break
	}
}

// Events returns the channel for completed audit events.
func (a *Aggregator) Events() <-chan *AuditEvent {
	return a.emitChan
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
	case 76, 77, 265, 266: // truncate, ftruncate
		return "TRUNCATE"
	default:
		return "OTHER"
	}
}
