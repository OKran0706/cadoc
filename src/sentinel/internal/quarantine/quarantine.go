// Package quarantine runs remote KILL_PROCESS actions queued by the platform.
//
// A PID alone is not trustworthy: the offender may have exited and its PID been reused, so the
// target's /proc exe must still match the one recorded in the alert before anything is killed.
package quarantine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

type Action struct {
	Action  string `json:"action"`
	PID     int    `json:"pid"`
	Exe     string `json:"exe"`
	AlertID string `json:"alert_id"`
}

// Deps are the OS hooks, injectable so the safety checks are testable off Linux.
type Deps struct {
	Self, Parent int
	ReadExe      func(pid int) (string, error)
	Kill         func(pid int) error
}

// Execute kills a.PID only if it is a safe target whose exe still matches. It returns whether the
// process was killed and a short human-readable outcome for the dashboard.
func Execute(a Action, d Deps) (bool, string) {
	switch {
	case a.Action != "KILL_PROCESS":
		return false, "unsupported action"
	case a.PID <= 1:
		return false, fmt.Sprintf("refused: pid %d is not a valid target", a.PID)
	case a.PID == d.Self || a.PID == d.Parent:
		return false, fmt.Sprintf("refused: pid %d is the sentinel or its parent", a.PID)
	case a.Exe == "":
		return false, "refused: no exe recorded for identity check"
	}
	exe, err := d.ReadExe(a.PID)
	if err != nil {
		return false, fmt.Sprintf("pid %d is gone: %v", a.PID, err)
	}
	if strings.TrimSuffix(exe, " (deleted)") != a.Exe {
		return false, fmt.Sprintf("refused: pid %d is now %q, not %q (pid reused)", a.PID, exe, a.Exe)
	}
	if err := d.Kill(a.PID); err != nil {
		return false, fmt.Sprintf("kill pid %d failed: %v", a.PID, err)
	}
	return true, fmt.Sprintf("killed pid %d (%s)", a.PID, a.Exe)
}

// Client is the mTLS ingestion client (ingestclient.Client satisfies it).
type Client interface {
	HTTPClient() *http.Client
	BaseURL() string
}

// Fetch pops this agent's pending actions from ingestion.
func Fetch(ctx context.Context, ic Client) ([]Action, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ic.BaseURL()+"/control/actions", nil)
	if err != nil {
		return nil, err
	}
	resp, err := ic.HTTPClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch actions: status %d", resp.StatusCode)
	}
	var out struct {
		Actions []Action `json:"actions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Actions, nil
}

// Report tells the platform how an action ended.
func Report(ctx context.Context, ic Client, alertID string, ok bool, msg string) error {
	body, _ := json.Marshal(map[string]any{"alert_id": alertID, "ok": ok, "message": msg})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ic.BaseURL()+"/control/actions/result", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := ic.HTTPClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("report result: status %d", resp.StatusCode)
	}
	return nil
}

// Poll fetches and runs pending actions every interval until ctx is done.
func Poll(ctx context.Context, ic Client, d Deps, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			acts, err := Fetch(ctx, ic)
			if err != nil {
				log.Printf("[quarantine] poll failed: %v", err)
				continue
			}
			for _, a := range acts {
				log.Printf("[quarantine] executing %s pid=%d exe=%s", a.Action, a.PID, a.Exe)
				ok, msg := Execute(a, d)
				log.Printf("[quarantine] ok=%v: %s", ok, msg)
				if err := Report(ctx, ic, a.AlertID, ok, msg); err != nil {
					log.Printf("[quarantine] report failed: %v", err)
				}
			}
		}
	}
}
