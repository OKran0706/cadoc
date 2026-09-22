// canary-system/src/sentinel/internal/config/config.go
// YAML configuration loader for sentinel daemon.
// Derived from: sentinel-daemon/SKILL.md

package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config is the top-level sentinel configuration.
type Config struct {
	Signing        SigningConfig        `yaml:"signing"`
	Telemetry      TelemetryConfig      `yaml:"telemetry"`
	OOBAlert       OOBAlertConfig       `yaml:"oob_alert"`
	Watchdog       WatchdogConfig       `yaml:"watchdog"`
	LogIntegrity   LogIntegrityConfig   `yaml:"log_integrity"`
	SelfProtection SelfProtectionConfig `yaml:"self_protection"`
	Maintenance    MaintenanceConfig    `yaml:"maintenance"`
}

// MaintenanceConfig configures cryptographic authorization for lifecycle operations.
// The public key is fetched from Vault at startup and held in memory only.
type MaintenanceConfig struct {
	VaultPath string `yaml:"vault_path"` // Vault secret path (default: secret/canary/maintenance)
	VaultField string `yaml:"vault_field"` // Field name in the Vault secret (default: ed25519_pubkey)
}

// SigningConfig configures the Ed25519 signing key source.
type SigningConfig struct {
	Algorithm string `yaml:"algorithm"`
	KeySource string `yaml:"key_source"` // "tpm" | "file" | "vault"
	TPMHandle string `yaml:"tpm_handle"`
	KeyFile   string `yaml:"key_file"`
	VaultPath string `yaml:"vault_path"`
	VaultField string `yaml:"vault_field"` // Field name in the Vault secret (default: ed25519_privkey)
}

// TelemetryConfig configures the Kafka connection.
type TelemetryConfig struct {
	KafkaBrokers []string `yaml:"kafka_brokers"`
	Topic        string   `yaml:"topic"`
	TLS          bool     `yaml:"tls"`
	ClientCert   string   `yaml:"client_cert"`
	ClientKey    string   `yaml:"client_key"`
	CACert       string   `yaml:"ca_cert"`
}

// OOBAlertConfig configures the out-of-band alert webhook.
type OOBAlertConfig struct {
	URL           string `yaml:"url"`
	Method        string `yaml:"method"`
	TimeoutSec    int    `yaml:"timeout_seconds"`
	RetryCount    int    `yaml:"retry_count"`
}

// WatchdogConfig configures the mutual heartbeat mechanism.
type WatchdogConfig struct {
	HeartbeatIntervalSeconds int    `yaml:"heartbeat_interval_seconds"`
	AlertThresholdSeconds    int    `yaml:"alert_threshold_seconds"`
	PeerSocket               string `yaml:"peer_socket"`
}

// LogIntegrityConfig configures the local Merkle chain log.
type LogIntegrityConfig struct {
	ChainAlgorithm string `yaml:"chain_algorithm"`
	LocalLog       string `yaml:"local_log"`
}

// SelfProtectionConfig configures eBPF self-monitoring.
type SelfProtectionConfig struct {
	MonitorOwnPID       bool     `yaml:"monitor_own_pid"`
	MonitorSignals      []string `yaml:"monitor_signals"`
	AlertOnPtrace       bool     `yaml:"alert_on_ptrace_attach"`
	AlertOnProcModify   bool     `yaml:"alert_on_proc_modification"`
}

// Load reads and parses the sentinel configuration YAML file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}

	// Defaults
	if cfg.Telemetry.Topic == "" {
		cfg.Telemetry.Topic = "canary-events"
	}
	if cfg.Watchdog.HeartbeatIntervalSeconds == 0 {
		cfg.Watchdog.HeartbeatIntervalSeconds = 5
	}
	if cfg.Watchdog.AlertThresholdSeconds == 0 {
		cfg.Watchdog.AlertThresholdSeconds = 15
	}
	if cfg.Maintenance.VaultPath == "" {
		cfg.Maintenance.VaultPath = "secret/canary/maintenance"
	}
	if cfg.Maintenance.VaultField == "" {
		cfg.Maintenance.VaultField = "ed25519_pubkey"
	}
	if cfg.Signing.VaultField == "" {
		cfg.Signing.VaultField = "ed25519_privkey"
	}

	return &cfg, nil
}
