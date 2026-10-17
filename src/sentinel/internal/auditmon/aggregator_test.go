//go:build linux
// +build linux

package auditmon

import (
	"testing"
	"time"

	"github.com/elastic/go-libaudit/auparse"
)

// Real records captured on the arm64 EC2 host (audit.log), with and without the interpreted
// suffix that auditd's string format appends after a \x1d separator.
const interp = "\x1dARCH=aarch64 SYSCALL=openat AUID=\"unset\" UID=\"root\""

var catEvent = []string{ // `cat /opt/app/config/.env.staging` (read-only open)
	`type=SYSCALL msg=audit(1792233937.526:1246): arch=c00000b7 syscall=56 success=yes exit=3 a0=ffffffffffffff9c a1=ffffe5732c48 a2=80000 a3=0 items=1 ppid=1469213 pid=1469215 auid=1000 uid=0 gid=0 euid=0 suid=0 fsuid=0 egid=0 sgid=0 fsgid=0 tty=(none) ses=196 comm="cat" exe="/usr/lib/cargo/bin/coreutils/cat" subj=unconfined key="sys-integrity"` + interp,
	`type=CWD msg=audit(1792233937.526:1246): cwd="/home/ubuntu/cadoc"`,
	`type=PATH msg=audit(1792233937.526:1246): item=0 name="/opt/app/config/.env.staging" inode=546719 dev=103:01 mode=0100644 ouid=0 ogid=0 rdev=00:00 nametype=NORMAL cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0`,
	`type=PROCTITLE msg=audit(1792233937.526:1246): proctitle=636174002F6F70742F6170702F636F6E6669672F2E656E762E73746167696E67`, // "cat /opt/app/config/.env.staging"
}

var agentCreate = []string{ // the agent itself creating a decoy: openat O_WRONLY|O_CREAT|O_TRUNC (a2=0x80241)
	`type=SYSCALL msg=audit(1792235044.766:1941): arch=c00000b7 syscall=56 success=yes exit=8 a0=ffffffffffffff9c a1=18ad656505b8 a2=80241 a3=1a4 items=2 ppid=1 pid=1479313 auid=4294967295 uid=0 gid=0 euid=0 suid=0 fsuid=0 egid=0 sgid=0 fsgid=0 tty=(none) ses=4294967295 comm="sentinel" exe="/opt/canary/sentinel" subj=unconfined key="sys-integrity"` + interp,
	`type=CWD msg=audit(1792235044.766:1941): cwd="/"`,
	`type=PATH msg=audit(1792235044.766:1941): item=0 name="/etc/app/" inode=3459 dev=103:01 mode=040755 ouid=0 ogid=0 rdev=00:00 nametype=PARENT cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0`,
	`type=PATH msg=audit(1792235044.766:1941): item=1 name="/etc/app/config.yml.old" inode=3540 dev=103:01 mode=0100644 ouid=0 ogid=0 rdev=00:00 nametype=CREATE cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0`,
}

func feed(t *testing.T, a *Aggregator, lines []string) {
	t.Helper()
	for _, l := range lines {
		rec, err := auparse.ParseLogLine(l)
		if err != nil {
			t.Fatalf("parse %q: %v", l[:40], err)
		}
		a.ProcessRecord(rec)
	}
}

func next(t *testing.T, a *Aggregator, wait time.Duration) *AuditEvent {
	t.Helper()
	select {
	case e := <-a.Events():
		return e
	case <-time.After(wait):
		return nil
	}
}

func TestProbeParsedFields(t *testing.T) {
	rec, err := auparse.ParseLogLine(catEvent[0])
	if err != nil {
		t.Fatal(err)
	}
	f, derr := rec.Data()
	t.Logf("PROBE syscall=%q arch=%q pid=%q a1=%q a2=%q SYSCALL=%q (data err=%v)", f["syscall"], f["arch"], f["pid"], f["a1"], f["a2"], f["SYSCALL"], derr)
}

func TestReadOfDecoyIsOpenWithPID(t *testing.T) {
	a := NewAggregator(300*time.Millisecond, 100, 10)
	defer a.Stop()
	a.SetWatchPaths([]string{"/opt/app/config/.env.staging"})
	feed(t, a, catEvent)
	e := next(t, a, time.Second)
	if e == nil {
		t.Fatal("no event emitted for a read of a decoy")
	}
	if e.Confidence != ConfComplete || e.PID != 1469215 || e.Path != "/opt/app/config/.env.staging" {
		t.Fatalf("bad event: %+v", e)
	}
	if e.Op != "OPEN" {
		t.Errorf("op = %q, want OPEN (openat, read-only)", e.Op)
	}
	if e.Cmdline != "cat /opt/app/config/.env.staging" || e.PPID != 1469213 || !e.Success || e.Exit != "3" || e.User != "root" {
		t.Errorf("process info wrong: cmdline=%q ppid=%d success=%v exit=%q user=%q", e.Cmdline, e.PPID, e.Success, e.Exit, e.User)
	}
}

// The agent's own create is seen BEFORE the canary map contains the new path (map is set after deploy),
// so it is flushed later as a partial event. It must still carry the agent's PID and a WRITE op.
func TestPartialEventKeepsPIDAndOp(t *testing.T) {
	a := NewAggregator(300*time.Millisecond, 100, 10)
	defer a.Stop()
	feed(t, a, agentCreate) // map empty: not complete, buffered
	a.SetWatchPaths([]string{"/etc/app/config.yml.old"})
	e := next(t, a, 3*time.Second)
	if e == nil {
		t.Fatal("partial event was never emitted")
	}
	if e.Confidence != ConfIncomplete {
		t.Errorf("confidence = %q, want INCOMPLETE", e.Confidence)
	}
	if e.PID != 1479313 {
		t.Errorf("pid = %d, want 1479313 (the agent): partial events lose the PID", e.PID)
	}
	if e.Op != "WRITE" {
		t.Errorf("op = %q, want WRITE (openat with O_CREAT|O_WRONLY)", e.Op)
	}
}

// `cd /etc/app && cat config.yml.old` records a RELATIVE name plus the cwd; it must still match.
func TestRelativePathResolvedAgainstCWD(t *testing.T) {
	a := NewAggregator(300*time.Millisecond, 100, 10)
	defer a.Stop()
	a.SetWatchPaths([]string{"/etc/app/config.yml.old"})
	feed(t, a, []string{
		`type=SYSCALL msg=audit(1792236000.100:2000): arch=c00000b7 syscall=56 success=yes exit=3 a0=ffffffffffffff9c a1=1 a2=80000 a3=0 items=1 ppid=1 pid=4242 auid=1000 uid=0 gid=0 euid=0 suid=0 fsuid=0 egid=0 sgid=0 fsgid=0 tty=(none) ses=1 comm="cat" exe="/usr/bin/cat" key="sys-integrity"`,
		`type=CWD msg=audit(1792236000.100:2000): cwd="/etc/app"`,
		`type=PATH msg=audit(1792236000.100:2000): item=0 name="config.yml.old" inode=3540 dev=103:01 mode=0100644 ouid=0 ogid=0 rdev=00:00 nametype=NORMAL`,
			`type=PROCTITLE msg=audit(1792236000.100:2000): proctitle="cat"`,
	})
	e := next(t, a, time.Second)
	if e == nil {
		t.Fatal("relative-path access to a decoy was missed")
	}
	if e.Path != "/etc/app/config.yml.old" || e.PID != 4242 {
		t.Fatalf("bad event: %+v", e)
	}
}

// A trailing record of an already-emitted event (PROCTITLE, a late PATH item) must not start a new
// buffer that is flushed later as a duplicate, PID-less partial event.
func TestLateFragmentsDoNotDuplicate(t *testing.T) {
	a := NewAggregator(200*time.Millisecond, 100, 10)
	defer a.Stop()
	a.SetWatchPaths([]string{"/opt/app/config/.env.staging"})
	feed(t, a, catEvent)
	if next(t, a, time.Second) == nil {
		t.Fatal("no event")
	}
	feed(t, a, []string{
		`type=PATH msg=audit(1792233937.526:1246): item=1 name="/opt/app/config/.env.staging" inode=546719 dev=103:01 mode=0100644 nametype=NORMAL`,
		`type=PROCTITLE msg=audit(1792233937.526:1246): proctitle=636174`,
	})
	if e := next(t, a, 2*time.Second); e != nil {
		t.Fatalf("duplicate event from late fragments: %+v", e)
	}
}

func TestOpFor(t *testing.T) {
	cases := []struct {
		f    map[string]string
		want string
	}{
		{map[string]string{"syscall": "openat", "a2": "80000"}, "OPEN"},   // O_RDONLY|O_CLOEXEC
		{map[string]string{"syscall": "openat", "a2": "80241"}, "WRITE"},  // O_WRONLY|O_CREAT|O_TRUNC
		{map[string]string{"syscall": "openat", "a2": "2"}, "WRITE"},      // O_RDWR
		{map[string]string{"syscall": "open", "a1": "441"}, "WRITE"},      // O_WRONLY|O_CREAT|O_APPEND
		{map[string]string{"syscall": "open", "a1": "0"}, "OPEN"},
		{map[string]string{"syscall": "unlinkat"}, "DELETE"},
		{map[string]string{"syscall": "renameat2"}, "RENAME"},
		{map[string]string{"syscall": "fchmodat"}, "CHMOD"},
		{map[string]string{"syscall": "truncate"}, "TRUNCATE"},
		{map[string]string{"syscall": "87"}, "DELETE"}, // bare x86_64 number still handled
		{map[string]string{"syscall": "something_new"}, "OTHER"},
		{map[string]string{}, "OTHER"}, // missing field is no longer silently READ
	}
	for _, c := range cases {
		if got := opFor(c.f); got != c.want {
			t.Errorf("opFor(%v) = %q, want %q", c.f, got, c.want)
		}
	}
}

func TestSSHSourceIPFromUserStart(t *testing.T) {
	a := NewAggregator(300*time.Millisecond, 100, 10)
	defer a.Stop()
	a.SetWatchPaths([]string{"/opt/app/config/.env.staging"})
	feed(t, a, []string{
		`type=USER_START msg=audit(1792233900.100:1200): pid=1469000 uid=0 auid=1000 ses=196 subj=unconfined msg='op=PAM:session_open grantors=pam_loginuid acct="ubuntu" exe="/usr/sbin/sshd" hostname=? addr=203.0.113.7 terminal=ssh res=success'`,
		`type=USER_START msg=audit(1792233910.100:1201): pid=1469100 uid=1000 auid=1000 ses=196 subj=unconfined msg='op=PAM:session_open acct="root" exe="/usr/bin/sudo" hostname=? addr=? terminal=/dev/pts/0 res=success'`,
	})
	feed(t, a, catEvent) // ses=196
	e := next(t, a, time.Second)
	if e == nil || e.SrcIP != "203.0.113.7" || e.AUID != "1000" || e.Session != "196" {
		t.Fatalf("want src_ip 203.0.113.7 (sudo's addr=? must not overwrite it), got %+v", e)
	}
}
