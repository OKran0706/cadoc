import type { NodeIncident } from './holisticData';
import type { IncidentSignal, TelemetryEvent } from './incidentBrief';
import type { SeededAlertType } from './incidentRules';

export const MOCK_SNAPSHOT_AT = '2026-10-18T10:08:00.000Z';
const at = (time: string) => '2026-10-18T' + time + '.000Z';
const meta = (id: string, sensor: string, sourceField: string, time: string) => ({id, sensor, sourceField, timestamp: at(time), severity: 'high' as const});
const event = (id: string, time: string, source: string, category: TelemetryEvent['category'], description: string): TelemetryEvent => ({id, timestamp: at(time), source, category, event: description});
const incident = (nodeId: string, alertType: SeededAlertType, time: string, vector: string, signals: IncidentSignal[], events: TelemetryEvent[]): NodeIncident => ({
  id: 'INC-20261018-' + alertType, nodeId, alertType, state: 'active', vector,
  detectedAt: at(time), observedAt: MOCK_SNAPSHOT_AT, signals, events,
});

// Offline fixture records. These are the telemetry source, not rule-generated evidence.
// IPs, process IDs, paths and hashes are synthetic; credential contents are never stored.
export const MOCK_INCIDENTS: Record<string, NodeIncident> = {
  'srv-eu-fintech-ledger': incident('srv-eu-fintech-ledger', 'ledger_tamper', '10:02:00', 'Ledger file hash mismatch', [
    {...meta('ledger-hash','ledger-verifier','telemetry.ledger.fileHash','10:02:00'),kind:'hash_mismatch',path:'/var/data/ledger.db',expectedHash:'7f4b8c93a120ee61',actualHash:'9a1e32bd7810fa42'},
    {...meta('ledger-write','auditd','auditd.fileWrite','10:01:46'),kind:'ledger_write',path:'/var/data/ledger.db',pid:9104,authorized:false},
    {...meta('ledger-peers','replica-monitor','consensus.replicaHash','10:02:15'),kind:'replica_divergence',path:'/var/data/ledger.db',matchingPeers:1,totalPeers:5},
  ], [
    event('ledger-1','09:59:00','ledger-verifier','baseline','Scheduled ledger checksum matched the trusted checkpoint.'),
    event('ledger-2','10:01:46','auditd','trigger','PID 9104 wrote /var/data/ledger.db outside the authorized writer policy.'),
    event('ledger-3','10:02:00','ledger-verifier','trigger','Ledger file checksum mismatch raised the integrity alert.'),
    event('ledger-4','10:02:15','replica-monitor','response','Only one of five peer checksums matched the local ledger.'),
    event('ledger-5','10:02:30','incident-router','response','Integrity alert entered the analyst queue; containment is pending.'),
  ]),
  'srv-canary-db-01': incident('srv-canary-db-01', 'canary_access', '10:04:00', 'Decoy credential file and honeytoken accessed', [
    {...meta('canary-token','canary-monitor','telemetry.canary.tokenRead','10:04:00'),kind:'canary_access',tokenName:'pg_admin_legacy',pid:4829,path:'/var/www/.env.vault'},
    {...meta('canary-file','auditd','auditd.fileRead','10:03:58'),kind:'credential_file_read',pid:4829,path:'/var/www/.env.vault',credentialKind:'config'},
  ], [
    event('canary-1','10:00:00','canary-monitor','baseline','The pg_admin_legacy honeytoken was armed.'),
    event('canary-2','10:03:58','auditd','trigger','PID 4829 read the decoy credential file /var/www/.env.vault.'),
    event('canary-3','10:04:00','canary-monitor','trigger','The pg_admin_legacy token access triggered an alert.'),
    event('canary-4','10:04:06','incident-router','response','Canary access was added to the analyst queue.'),
    event('canary-5','10:04:20','canary-monitor','response','No additional token accesses were recorded in the next 20 seconds.'),
  ]),
  'srv-us-east-worker': incident('srv-us-east-worker', 'credential_read', '10:02:10', 'Unexpected /etc/shadow read', [
    {...meta('shadow-read','auditd','auditd.syscall.openat','10:02:10'),kind:'credential_file_read',pid:4829,path:'/etc/shadow',credentialKind:'shadow'},
    {...meta('shadow-sensor','file-access-monitor','telemetry.files.sensitiveRead','10:02:11'),kind:'credential_file_read',pid:4829,path:'/etc/shadow',credentialKind:'shadow'},
  ], [
    event('cred-1','10:00:00','agent-health','baseline','The node health check completed successfully.'),
    event('cred-2','10:02:08','process-monitor','inbound','Process kworker_sys_update started as PID 4829.'),
    event('cred-3','10:02:10','auditd','trigger','PID 4829 opened /etc/shadow for reading.'),
    event('cred-4','10:02:11','file-access-monitor','trigger','A second sensor recorded access to /etc/shadow by PID 4829.'),
    event('cred-5','10:02:20','incident-router','response','Sensitive-file read alert entered the analyst queue.'),
  ]),
  'srv-agent-sentinel-01': incident('srv-agent-sentinel-01','agent_disabled','10:05:00','Security agent stopped and disabled',[
    {...meta('agent-kill','kernel-audit','kernel.signal.kill','10:05:00'),kind:'agent_killed',pid:1088,actorPid:7712,signal:'SIGKILL'},
    {...meta('agent-service','service-manager','systemd.sentinel.enabled','10:05:02'),kind:'agent_disabled',service:'sentinel-agent',enabled:false},
  ],[
    event('agent-1','10:04:30','agent-health','baseline','Sentinel agent PID 1088 reported healthy.'),
    event('agent-2','10:05:00','kernel-audit','trigger','PID 7712 sent SIGKILL to security agent PID 1088.'),
    event('agent-3','10:05:02','service-manager','trigger','The sentinel-agent service was recorded as disabled.'),
    event('agent-4','10:05:10','incident-router','response','Security agent impairment alert entered the analyst queue.'),
    event('agent-5','10:05:30','service-manager','response','The sentinel-agent service remained inactive at the next status check.'),
  ]),
  'srv-ap-edge-waf': incident('srv-ap-edge-waf','heartbeat_lost','10:06:00','Heartbeat gap exceeded the configured threshold',[
    {...meta('heartbeat-gap','heartbeat-monitor','telemetry.heartbeat.gapSeconds','10:06:00'),kind:'heartbeat_gap',gapSeconds:90,thresholdSeconds:30,lastSeenAt:at('10:04:30')},
  ],[
    event('heart-1','10:04:30','heartbeat-monitor','baseline','The last heartbeat was received.'),
    event('heart-2','10:05:00','heartbeat-monitor','trigger','The expected heartbeat did not arrive within 30 seconds.'),
    event('heart-3','10:06:00','heartbeat-monitor','trigger','A 90-second gap raised the heartbeat-lost alert.'),
    event('heart-4','10:06:05','incident-router','response','Heartbeat-lost alert entered the analyst queue.'),
    event('heart-5','10:07:00','heartbeat-monitor','response','No new heartbeat had arrived at the next poll.'),
  ]),
  'srv-ap-edge-cache': incident('srv-ap-edge-cache','memory_injection','10:03:00','Cross-process memory write detected',[
    {...meta('memory-write','kernel-audit','kernel.processVmWritev','10:03:00'),kind:'memory_write',pid:6621,targetPid:2304,bytes:4096},
    {...meta('memory-thread','thread-monitor','telemetry.process.remoteThread','10:03:01'),kind:'remote_thread',pid:6621,targetPid:2304},
    {...meta('memory-exec','memory-scanner','telemetry.memory.privateExecutable','10:03:02'),kind:'executable_private_memory',pid:2304,bytes:4096},
  ],[
    event('mem-1','10:01:00','memory-scanner','baseline','No private executable region was present in PID 2304.'),
    event('mem-2','10:03:00','kernel-audit','trigger','PID 6621 wrote 4096 bytes into PID 2304.'),
    event('mem-3','10:03:01','thread-monitor','trigger','PID 6621 started a thread in PID 2304.'),
    event('mem-4','10:03:02','memory-scanner','response','The scanner found a 4096-byte private executable region in PID 2304.'),
    event('mem-5','10:03:10','incident-router','response','Cross-process memory alert entered the analyst queue.'),
  ]),
};
