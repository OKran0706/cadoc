# Graph Report - cadoc  (2026-05-08)

## Corpus Check
- 59 files · ~97,543 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 371 nodes · 628 edges · 23 communities detected
- Extraction: 67% EXTRACTED · 33% INFERRED · 0% AMBIGUOUS · INFERRED: 210 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 24|Community 24]]

## God Nodes (most connected - your core abstractions)
1. `main()` - 33 edges
2. `main()` - 18 edges
3. `AlertRouter` - 16 edges
4. `Tier2RuleEngine` - 15 edges
5. `SlidingWindowCounter` - 14 edges
6. `Tier1RuleEngine` - 14 edges
7. `DetectionEngine` - 13 edges
8. `pollKillSwitch()` - 11 edges
9. `Aggregator` - 11 edges
10. `Start()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `SlidingWindowCounter` --uses--> `Evaluates Tier 2 (behavioral, windowed) detection rules.`  [INFERRED]
  src\detection_engine\sliding_window.py → src\detection_engine\rules\tier2.py
- `SlidingWindowCounter` --uses--> `Evaluate an event against Tier 2 rules. Returns list of alerts.`  [INFERRED]
  src\detection_engine\sliding_window.py → src\detection_engine\rules\tier2.py
- `SlidingWindowCounter` --uses--> `Check if event matches any suppression rule.`  [INFERRED]
  src\detection_engine\sliding_window.py → src\detection_engine\rules\tier2.py
- `main()` --calls--> `NewAuditctlManager()`  [INFERRED]
  src\sentinel\cmd\sentinel-a\main.go → src\sentinel\internal\auditmon\auditctl.go
- `hashFile()` --calls--> `New()`  [INFERRED]
  src\canary_verify\main.go → src\telemetry\internal\verifier\verifier.go

## Communities

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (30): AlertRouter, Execute an automated response action., Routes alerts to the appropriate channels based on the routing matrix., Lazy-load automated response handlers., Route an alert through all configured channels., Emit alert in SIEM-compatible format., post_alert(), Post an alert to Slack via Incoming Webhook. (+22 more)

### Community 1 - "Community 1"
Cohesion: 0.09
Nodes (36): BroadcastControlMessage(), handleConnection(), StartServer(), main(), CheckPeer(), MonitorPeer(), sendOOBAlert(), Serve() (+28 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (21): Action, SignedTicket, Ticket, NewVerifierFromBytes(), Verifier, BaseModel, Verifies that the payload timestamp is within the ±window_seconds window.     Pa, Verifies an Ed25519 signature of a payload. (+13 more)

### Community 3 - "Community 3"
Cohesion: 0.1
Nodes (14): AllowlistEntry, Config, Load(), LogIntegrityConfig, MountEntry, OOBAlertConfig, SelfProtectionConfig, SigningConfig (+6 more)

### Community 4 - "Community 4"
Cohesion: 0.15
Nodes (11): Aggregator, extractAuditID(), extractField(), identifyOp(), NewAggregator(), AuditEvent, Confidence, eventBuffer (+3 more)

### Community 5 - "Community 5"
Cohesion: 0.14
Nodes (18): CanaryEntry, CanaryMap, hostname(), removeOldCanariesBruteForce(), StartDaemon(), blendTimestamp(), Deploy(), DetectProfile() (+10 more)

### Community 6 - "Community 6"
Cohesion: 0.2
Nodes (9): BatchResults, ChainVerifier, envelope, innerEvent, loadPublicKeys(), main(), printReport(), splitBrokers() (+1 more)

### Community 7 - "Community 7"
Cohesion: 0.16
Nodes (13): enrich_alert(), _get_pod_by_container(), _get_process_lineage(), _ldap_lookup(), Enrich an alert with contextual information:     - Process lineage (parent PID, Get process lineage by walking /proc/{pid}/stat parent PIDs.     Returns list o, Find the Kubernetes pod containing a specific container ID., Look up user identity via LDAP/SSO.     Returns dict with display_name, email, (+5 more)

### Community 8 - "Community 8"
Cohesion: 0.19
Nodes (8): main(), PostgresCanaryListener, Listens for PostgreSQL NOTIFY events from canary triggers., Start listening for canary alerts., Connect to Kafka for forwarding events., Connect to PostgreSQL and listen with reconnect logic., Poll for NOTIFY events., Process a single NOTIFY event.

### Community 9 - "Community 9"
Cohesion: 0.15
Nodes (7): Thread-safe sliding window counter per (host, actor) pair., Get current count for a key within the window., Reset counter for a key., Remove expired entries to prevent memory growth., SlidingWindowCounter, Build a counter key from template and event data., Check if current time is outside the specified hours.

### Community 10 - "Community 10"
Cohesion: 0.25
Nodes (6): main(), MySQLLogWatcher, Tails MySQL general log and fires alerts on canary table access., Start watching the MySQL general log., Tail the log file and check each line against canary patterns., Send a canary alert event to Kafka.

### Community 11 - "Community 11"
Cohesion: 0.22
Nodes (6): NewAuditctlManager(), validatePath(), AuditctlManager, MonitorHealth(), HealthStatus, SubsystemEvent

### Community 12 - "Community 12"
Cohesion: 0.39
Nodes (8): Config, hashFile(), isMaintenanceActive(), isProcessRunning(), isTetragonPolicyLoaded(), main(), postWebhook(), runChecks()

### Community 13 - "Community 13"
Cohesion: 0.25
Nodes (4): TemplateData, RandomAlpha(), RandomBase64(), RandomHex()

### Community 14 - "Community 14"
Cohesion: 0.43
Nodes (3): refreshVaultAccess(), Client, New()

### Community 15 - "Community 15"
Cohesion: 0.38
Nodes (6): _format_summary(), _get_runbook_url(), page(), Send a PagerDuty alert via Events API v2., Format a human-readable alert summary for PagerDuty., Get the runbook URL for a given rule ID.

### Community 16 - "Community 16"
Cohesion: 0.38
Nodes (6): _get_pod_app_label(), isolate_pod(), _log_response_action(), Apply a restrictive NetworkPolicy to quarantine the pod.     Allows only DNS (p, Get the 'app' label from a pod., Log the response action for audit trail.

### Community 17 - "Community 17"
Cohesion: 0.47
Nodes (1): PodReconciler

### Community 18 - "Community 18"
Cohesion: 0.5
Nodes (4): quarantine_host(), Apply iptables rules to isolate a host.     Allows SSH from security team IP an, Log to syslog via logger command., _syslog()

### Community 19 - "Community 19"
Cohesion: 0.67
Nodes (3): freeze_unauthorized_snapshot(), _log_response_action(), Freeze a VolumeSnapshot by adding a finalizer and quarantine annotations.     P

### Community 20 - "Community 20"
Cohesion: 0.67
Nodes (2): Terminate the specific database backend that triggered the alert.     Logs the, revoke_db_session()

### Community 21 - "Community 21"
Cohesion: 1.0
Nodes (2): EnsureCertificates(), IsProvisioned()

### Community 24 - "Community 24"
Cohesion: 0.67
Nodes (1): WebhookHandler

## Knowledge Gaps
- **72 isolated node(s):** `Send a PagerDuty alert via Events API v2.`, `Format a human-readable alert summary for PagerDuty.`, `Get the runbook URL for a given rule ID.`, `Routes alerts to the appropriate channels based on the routing matrix.`, `Lazy-load automated response handlers.` (+67 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 17`** (6 nodes): `PodReconciler`, `.alert()`, `.deployTetragonPolicy()`, `.Reconcile()`, `.SetupWithManager()`, `pod.go`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 20`** (3 nodes): `Terminate the specific database backend that triggered the alert.     Logs the`, `revoke_db_session()`, `revoke_db_session.py`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 21`** (3 nodes): `EnsureCertificates()`, `IsProvisioned()`, `provisioning.go`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (3 nodes): `server.py`, `WebhookHandler`, `.do_POST()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `main()` connect `Community 1` to `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 7`, `Community 11`, `Community 14`, `Community 21`?**
  _High betweenness centrality (0.222) - this node is a cross-community bridge._
- **Why does `main()` connect `Community 1` to `Community 3`, `Community 14`, `Community 7`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **Why does `SlidingWindowCounter` connect `Community 9` to `Community 0`, `Community 7`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Are the 29 inferred relationships involving `main()` (e.g. with `runAuditConsumer()` and `.String()`) actually correct?**
  _`main()` has 29 INFERRED edges - model-reasoned connections that need verification._
- **Are the 16 inferred relationships involving `main()` (e.g. with `.String()` and `New()`) actually correct?**
  _`main()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **Are the 9 inferred relationships involving `AlertRouter` (e.g. with `AlertDeduplicator` and `DetectionEngine`) actually correct?**
  _`AlertRouter` has 9 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `Tier2RuleEngine` (e.g. with `AlertDeduplicator` and `DetectionEngine`) actually correct?**
  _`Tier2RuleEngine` has 10 INFERRED edges - model-reasoned connections that need verification._