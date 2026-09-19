// canary-system/src/pvc_watchdog/internal/config/config.go
// YAML configuration for PVC watchdog operator.
// Derived from: pvc-watchdog/SKILL.md

package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// WatchdogConfig is the top-level operator configuration.
type WatchdogConfig struct {
	SnapshotAllowlist []AllowlistEntry  `yaml:"allowlist"`
	MountBaseline     map[string]MountEntry `yaml:"mounts"`
	BaselineLocked    bool                  `yaml:"locked"`
}

// AllowlistEntry defines an approved VolumeSnapshot creator.
type AllowlistEntry struct {
	ServiceAccount string   `yaml:"service_account"`
	Namespace      string   `yaml:"namespace"`
	Reason         string   `yaml:"reason"`
	Windows        []Window `yaml:"windows"`
}

// Window is an approved time window for snapshot creation.
type Window struct {
	Cron           string `yaml:"cron"`
	StartHour      int    `yaml:"start_hour"`
	DurationHours  int    `yaml:"duration_hours"`
	DurationMinutes int   `yaml:"duration_minutes"`
}

// MountEntry describes a known-good app→PVC mount.
type MountEntry struct {
	Approved  bool   `yaml:"approved"`
	FirstSeen string `yaml:"first_seen"`
}

// Load reads and parses the watchdog configuration from a YAML file.
func Load(path string) (*WatchdogConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}

	var cfg WatchdogConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}

	if cfg.MountBaseline == nil {
		cfg.MountBaseline = make(map[string]MountEntry)
	}

	return &cfg, nil
}
