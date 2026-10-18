// Read-only data collection for the AI tab. It reuses the same backend endpoints the Forensics
// views use (decoys, dashboard alerts, audit logs, servers) and receives a get-only Backend, so
// it cannot write (INV-AI-12). Server ids are only ever resolved against the caller's own list (INV-AI-2).

import { AiHttpError, mapBackendError, statusOf } from "./errors.ts";
import type { AuditRec, Backend, DataRecord, DecoyRec, Filters, FindingRec, ServerRef, Source, TimeRange, Unavailable } from "./types.ts";

const MAX_ALERT_PAGES = 10;
const ALERT_PAGE_SIZE = 100;
const MAX_AUDIT_PAGES = 5;
const AUDIT_PAGE_SIZE = 200;
const TAMPER_STATUSES = new Set(["tampered", "verification_failed"]);

const asArray = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

export async function resolveServers(backend: Backend, requested: string[]): Promise<ServerRef[]> {
  let list: Record<string, unknown>[];
  try {
    const res = await backend.get("/api/v1/servers/");
    if (!Array.isArray(res)) throw new AiHttpError(502, "backend_unavailable");
    list = asArray(res);
  } catch (e) {
    throw mapBackendError(e);
  }
  const byId = new Map(list.map((s) => [str(s.id), s]));
  const byHost = new Map(list.map((s) => [str(s.hostname).toLowerCase(), s]));
  const out: ServerRef[] = [];
  for (const r of requested) {
    const hit = byId.get(r) ?? byHost.get(r.toLowerCase());
    if (!hit) throw new AiHttpError(404, "server_not_found");
    const ref = { id: str(hit.id), hostname: str(hit.hostname, str(hit.id)) };
    if (!out.some((s) => s.id === ref.id)) out.push(ref);
  }
  return out;
}

export interface CollectInput {
  backend: Backend;
  servers: ServerRef[];
  range: TimeRange;
  sources: Source[];
  filters: Filters;
}

export interface Collected {
  records: DataRecord[];
  unavailable: Unavailable[];
  notes: string[];
}

export async function collectData(input: CollectInput): Promise<Collected> {
  const { backend, servers, range, sources, filters } = input;
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const host = new Map(servers.map((s) => [s.id, s.hostname]));
  const inRange = (...stamps: unknown[]) =>
    stamps.some((s) => {
      const t = typeof s === "string" ? Date.parse(s) : NaN;
      return Number.isFinite(t) && t >= from && t <= to;
    });

  const records: DataRecord[] = [];
  const unavailable: Unavailable[] = [];
  const notes: string[] = [];
  const fail = (source: Source, e: unknown) => {
    const s = statusOf(e);
    unavailable.push({
      source,
      reason: s === 403 || s === 401 ? "not permitted for your account" : s === 404 ? "not available on this deployment" : "temporarily unavailable",
    });
  };

  const wantsDecoys = sources.includes("decoy_events") || sources.includes("tamper_history");
  const wantsAllDecoys = sources.includes("decoy_events");

  const tasks: Promise<void>[] = [];

  if (wantsDecoys) {
    tasks.push(
      (async () => {
        try {
          const params: Record<string, string | number> = {};
          if (filters.status) params.status = filters.status;
          const rows = asArray(await backend.get("/api/v1/decoys/", params));
          for (const d of rows) {
            const serverId = str(d.server_id);
            if (!host.has(serverId)) continue;
            if (filters.status && d.status !== filters.status) continue;
            if (filters.decoy_type && d.decoy_type !== filters.decoy_type) continue;
            const status = str(d.status);
            const include = wantsAllDecoys
              ? inRange(d.planted_at, d.last_verified, d.updated_at)
              : TAMPER_STATUSES.has(status) && inRange(d.updated_at, d.last_verified);
            if (!include) continue;
            const rec: DecoyRec = {
              kind: "decoy",
              id: str(d.id),
              server_id: serverId,
              hostname: host.get(serverId)!,
              file_path: str(d.file_path),
              decoy_type: str(d.decoy_type),
              original_hash: str(d.original_hash),
              status,
              planted_at: str(d.planted_at),
              last_verified: typeof d.last_verified === "string" ? d.last_verified : null,
              updated_at: str(d.updated_at),
            };
            records.push(rec);
          }
        } catch (e) {
          for (const s of ["decoy_events", "tamper_history"] as const) if (sources.includes(s)) fail(s, e);
        }
      })()
    );
  }

  if (sources.includes("forensic_findings")) {
    tasks.push(
      (async () => {
        try {
          let cursor: string | null = null;
          let page = 0;
          let more = false;
          do {
            const params: Record<string, string | number> = { limit: ALERT_PAGE_SIZE };
            if (cursor) params.cursor = cursor;
            const res = (await backend.get("/api/v1/dashboard/alerts", params)) as { data?: unknown; next_cursor?: string | null; has_more?: boolean };
            for (const a of asArray(res?.data)) {
              const serverId = str(a.server_id);
              if (!host.has(serverId) || !inRange(a.detected_at)) continue;
              const rec: FindingRec = {
                kind: "finding",
                id: str(a.id),
                server_id: serverId,
                hostname: host.get(serverId)!,
                event_type: str(a.event_type),
                severity: str(a.severity, "unknown"),
                detected_at: str(a.detected_at),
                details: a.details && typeof a.details === "object" ? (a.details as Record<string, unknown>) : {},
              };
              records.push(rec);
            }
            page++;
            more = Boolean(res?.has_more && res?.next_cursor);
            cursor = more ? (res.next_cursor as string) : null;
          } while (more && page < MAX_ALERT_PAGES);
          if (more) {
            notes.push(`Forensic findings were capped at ${MAX_ALERT_PAGES * ALERT_PAGE_SIZE} records; older findings were not examined.`);
          }
        } catch (e) {
          fail("forensic_findings", e);
        }
      })()
    );
  }

  if (sources.includes("system_logs")) {
    tasks.push(
      (async () => {
        try {
          let offset = 0;
          for (let page = 0; page < MAX_AUDIT_PAGES; page++) {
            const rows = asArray(await backend.get("/api/v1/admins/audit-logs", { limit: AUDIT_PAGE_SIZE, offset }));
            rows.forEach((e, i) => {
              const serverId = [e.node_id, e.resource_id, e.entity_id].map((x) => str(x)).find((x) => host.has(x));
              const byTarget = [...host.entries()].find(([, h]) => h === str(e.target))?.[0];
              const sid = serverId ?? byTarget;
              const when = str(e.timestamp) || str(e.ts) || str(e.created_at);
              if (!sid || !inRange(when)) return;
              const rec: AuditRec = {
                kind: "audit",
                id: str(e.id, `audit-${offset + i}`),
                server_id: sid,
                hostname: host.get(sid)!,
                action: str(e.action),
                actor: str(e.actor) || str(e.user),
                ts: when,
                details: e.details ?? null,
              };
              records.push(rec);
            });
            if (rows.length < AUDIT_PAGE_SIZE) break;
            offset += AUDIT_PAGE_SIZE;
            if (page === MAX_AUDIT_PAGES - 1) notes.push(`System/audit logs were capped at ${MAX_AUDIT_PAGES * AUDIT_PAGE_SIZE} records.`);
          }
        } catch (e) {
          fail("system_logs", e);
        }
      })()
    );
  }

  await Promise.all(tasks);
  return { records, unavailable, notes };
}
