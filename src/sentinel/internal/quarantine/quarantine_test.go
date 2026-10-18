package quarantine

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type fakeProc struct {
	exe     map[int]string
	comm    map[int]string
	killed  []int
	killErr error
}

func (f *fakeProc) deps() Deps {
	return Deps{
		Self:   100,
		Parent: 50,
		ReadExe: func(pid int) (string, error) {
			e, ok := f.exe[pid]
			if !ok {
				return "", errors.New("no such process")
			}
			return e, nil
		},
		ReadComm: func(pid int) (string, error) {
			c, ok := f.comm[pid]
			if !ok {
				return "", errors.New("no such process")
			}
			return c, nil
		},
		Kill: func(pid int) error {
			f.killed = append(f.killed, pid)
			return f.killErr
		},
	}
}

func TestExecuteRefusals(t *testing.T) {
	tests := []struct {
		name string
		act  Action
		exe  map[int]string
	}{
		{"unknown action", Action{Action: "RM_RF", PID: 4921, Exe: "/usr/bin/tail"}, map[int]string{4921: "/usr/bin/tail"}},
		{"pid 1", Action{Action: "KILL_PROCESS", PID: 1, Exe: "/sbin/init"}, map[int]string{1: "/sbin/init"}},
		{"pid 0", Action{Action: "KILL_PROCESS", PID: 0, Exe: "/x"}, nil},
		{"negative pid", Action{Action: "KILL_PROCESS", PID: -1, Exe: "/x"}, nil},
		{"self", Action{Action: "KILL_PROCESS", PID: 100, Exe: "/opt/sentinel"}, map[int]string{100: "/opt/sentinel"}},
		{"parent", Action{Action: "KILL_PROCESS", PID: 50, Exe: "/usr/lib/systemd/systemd"}, map[int]string{50: "/usr/lib/systemd/systemd"}},
		{"process gone", Action{Action: "KILL_PROCESS", PID: 4921, Exe: "/usr/bin/tail"}, nil},
		{"pid reused by other exe", Action{Action: "KILL_PROCESS", PID: 4921, Exe: "/usr/bin/tail"}, map[int]string{4921: "/usr/sbin/sshd"}},
		{"empty exe", Action{Action: "KILL_PROCESS", PID: 4921, Exe: ""}, map[int]string{4921: ""}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeProc{exe: tc.exe}
			ok, msg := Execute(tc.act, f.deps())
			if ok || msg == "" {
				t.Fatalf("want refusal with message, got ok=%v msg=%q", ok, msg)
			}
			if len(f.killed) != 0 {
				t.Fatalf("must not kill, killed %v", f.killed)
			}
		})
	}
}

func TestExecuteKillsMatchingProcess(t *testing.T) {
	f := &fakeProc{exe: map[int]string{4921: "/usr/bin/tail"}}
	ok, _ := Execute(Action{Action: "KILL_PROCESS", PID: 4921, Exe: "/usr/bin/tail"}, f.deps())
	if !ok || len(f.killed) != 1 || f.killed[0] != 4921 {
		t.Fatalf("ok=%v killed=%v", ok, f.killed)
	}
}

func TestExecuteDeletedBinarySuffixStillMatches(t *testing.T) {
	f := &fakeProc{exe: map[int]string{4921: "/tmp/evil (deleted)"}}
	ok, _ := Execute(Action{Action: "KILL_PROCESS", PID: 4921, Exe: "/tmp/evil"}, f.deps())
	if !ok {
		t.Fatal("deleted-binary process should still be killable")
	}
}

func TestExecuteKillError(t *testing.T) {
	f := &fakeProc{exe: map[int]string{4921: "/usr/bin/tail"}, killErr: errors.New("operation not permitted")}
	ok, msg := Execute(Action{Action: "KILL_PROCESS", PID: 4921, Exe: "/usr/bin/tail"}, f.deps())
	if ok || msg == "" {
		t.Fatalf("want failure, got ok=%v msg=%q", ok, msg)
	}
}

type fakeIC struct{ srv *httptest.Server }

func (f fakeIC) HTTPClient() *http.Client { return f.srv.Client() }
func (f fakeIC) BaseURL() string          { return f.srv.URL }

func TestFetch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/control/actions" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		io.WriteString(w, `{"actions":[{"action":"KILL_PROCESS","pid":4921,"exe":"/usr/bin/tail","alert_id":"a1"}]}`)
	}))
	defer srv.Close()
	acts, err := Fetch(context.Background(), fakeIC{srv})
	if err != nil || len(acts) != 1 || acts[0].PID != 4921 || acts[0].AlertID != "a1" {
		t.Fatalf("acts=%+v err=%v", acts, err)
	}
}

func TestFetchNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer srv.Close()
	if _, err := Fetch(context.Background(), fakeIC{srv}); err == nil {
		t.Fatal("want error on 503")
	}
}

func TestReport(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/control/actions/result" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&got)
	}))
	defer srv.Close()
	if err := Report(context.Background(), fakeIC{srv}, "a1", true, "killed"); err != nil {
		t.Fatal(err)
	}
	if got["alert_id"] != "a1" || got["ok"] != true || got["message"] != "killed" {
		t.Fatalf("body=%v", got)
	}
}

func TestPollExecutesAndReports(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reported := make(chan map[string]any, 1)
	served := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/control/actions":
			if !served {
				served = true
				io.WriteString(w, `{"actions":[{"action":"KILL_PROCESS","pid":4921,"exe":"/usr/bin/tail","alert_id":"a1"}]}`)
				return
			}
			io.WriteString(w, `{"actions":[]}`)
		case "/control/actions/result":
			var b map[string]any
			json.NewDecoder(r.Body).Decode(&b)
			reported <- b
		}
	}))
	defer srv.Close()
	f := &fakeProc{exe: map[int]string{4921: "/usr/bin/tail"}}
	go Poll(ctx, fakeIC{srv}, f.deps(), 10*time.Millisecond)
	select {
	case b := <-reported:
		if b["alert_id"] != "a1" || b["ok"] != true {
			t.Fatalf("report=%v", b)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no report")
	}
}

func killAct(pid int, ppid int, pcomm string) Action {
	return Action{Action: "KILL_PROCESS", PID: pid, Exe: "/usr/bin/cat", PPID: ppid, ParentComm: pcomm}
}

// The offender (`cat`) exits in milliseconds, so ending its parent shell is what disconnects the user.
func TestParentShellKilledWhenOffenderAlreadyGone(t *testing.T) {
	f := &fakeProc{comm: map[int]string{3250287: "bash"}}
	ok, msg := Execute(killAct(3250863, 3250287, "bash"), f.deps())
	if !ok || len(f.killed) != 1 || f.killed[0] != 3250287 {
		t.Fatalf("ok=%v killed=%v msg=%q", ok, f.killed, msg)
	}
}

func TestBothKilledTargetFirst(t *testing.T) {
	f := &fakeProc{exe: map[int]string{4921: "/usr/bin/cat"}, comm: map[int]string{300: "bash"}}
	ok, _ := Execute(killAct(4921, 300, "bash"), f.deps())
	if !ok || len(f.killed) != 2 || f.killed[0] != 4921 || f.killed[1] != 300 {
		t.Fatalf("ok=%v killed=%v", ok, f.killed)
	}
}

func TestParentNotKilledWhenCommDiffers(t *testing.T) {
	f := &fakeProc{comm: map[int]string{300: "sshd"}} // pid reused by something else
	ok, msg := Execute(killAct(4921, 300, "bash"), f.deps())
	if ok || len(f.killed) != 0 || msg == "" {
		t.Fatalf("ok=%v killed=%v msg=%q", ok, f.killed, msg)
	}
}

func TestParentNotKilledWhenGone(t *testing.T) {
	f := &fakeProc{}
	if ok, _ := Execute(killAct(4921, 300, "bash"), f.deps()); ok || len(f.killed) != 0 {
		t.Fatalf("killed=%v", f.killed)
	}
}

func TestParentRefusals(t *testing.T) {
	for name, ppid := range map[string]int{"init": 1, "zero": 0, "self": 100, "sentinel parent": 50, "negative": -4} {
		t.Run(name, func(t *testing.T) {
			f := &fakeProc{comm: map[int]string{ppid: "bash"}}
			if _, _ = Execute(killAct(4921, ppid, "bash"), f.deps()); len(f.killed) != 0 {
				t.Fatalf("must not kill ppid %d, killed %v", ppid, f.killed)
			}
		})
	}
}

func TestParentNotAttemptedWithoutRecordedComm(t *testing.T) {
	f := &fakeProc{comm: map[int]string{300: "bash"}}
	Execute(killAct(4921, 300, ""), f.deps())
	if len(f.killed) != 0 {
		t.Fatalf("killed=%v", f.killed)
	}
}

func TestParentKillErrorReportsFailure(t *testing.T) {
	f := &fakeProc{comm: map[int]string{300: "bash"}, killErr: errors.New("operation not permitted")}
	if ok, msg := Execute(killAct(4921, 300, "bash"), f.deps()); ok || msg == "" {
		t.Fatalf("ok=%v msg=%q", ok, msg)
	}
}

func TestUnsupportedActionNeverTouchesParent(t *testing.T) {
	f := &fakeProc{comm: map[int]string{300: "bash"}}
	a := killAct(4921, 300, "bash")
	a.Action = "RM_RF"
	if ok, _ := Execute(a, f.deps()); ok || len(f.killed) != 0 {
		t.Fatalf("killed=%v", f.killed)
	}
}
