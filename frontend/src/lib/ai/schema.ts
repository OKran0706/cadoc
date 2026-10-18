// Strict request validation (INV-AI-8). Unknown fields are rejected so a client can
// never smuggle role / company_slug / owner_id style fields into the pipeline.

import { DECOY_STATUSES, SOURCES } from "./types.ts";
import type { DecoyStatus, FollowupRequest, QueryRequest, Source } from "./types.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_SERVERS = 10;
export const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TYPE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

function parseMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim();
  return m.length >= 1 && m.length <= MAX_MESSAGE_CHARS ? m : null;
}

/** Parses an ISO-8601 timestamp (with timezone) to epoch ms, or null. */
export function parseIso(v: unknown): number | null {
  if (typeof v !== "string" || !ISO_RE.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Shared by the request validator and the get_logs tool. */
export function parseRange(v: unknown, now: number): { from: string; to: string } | null {
  if (!isObj(v) || !onlyKeys(v, ["from", "to"])) return null;
  const from = parseIso(v.from);
  const to = parseIso(v.to);
  if (from === null || to === null) return null;
  if (from >= to || to - from > MAX_RANGE_MS || to > now + FUTURE_SKEW_MS) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function parseQueryRequest(body: unknown, now: number): Parsed<QueryRequest> {
  if (!isObj(body) || !onlyKeys(body, ["servers", "range", "sources", "filters", "message"])) return { ok: false, field: "body" };

  const rawServers = body.servers;
  if (!Array.isArray(rawServers) || rawServers.length < 1 || rawServers.length > MAX_SERVERS) return { ok: false, field: "servers" };
  if (!rawServers.every((s) => typeof s === "string" && ID_RE.test(s))) return { ok: false, field: "servers" };
  const servers = [...new Set(rawServers as string[])];

  const range = parseRange(body.range, now);
  if (!range) return { ok: false, field: "range" };

  const rawSources = body.sources;
  if (!Array.isArray(rawSources) || rawSources.length < 1 || rawSources.length > SOURCES.length) return { ok: false, field: "sources" };
  if (!rawSources.every((s) => (SOURCES as readonly unknown[]).includes(s))) return { ok: false, field: "sources" };
  const sources = [...new Set(rawSources as Source[])];

  const filters: QueryRequest["filters"] = {};
  if (body.filters !== undefined) {
    const f = body.filters;
    if (!isObj(f) || !onlyKeys(f, ["decoy_type", "status"])) return { ok: false, field: "filters" };
    if (f.decoy_type !== undefined) {
      if (typeof f.decoy_type !== "string" || !TYPE_RE.test(f.decoy_type)) return { ok: false, field: "filters" };
      filters.decoy_type = f.decoy_type;
    }
    if (f.status !== undefined) {
      if (!(DECOY_STATUSES as readonly unknown[]).includes(f.status)) return { ok: false, field: "filters" };
      filters.status = f.status as DecoyStatus;
    }
  }

  const message = parseMessage(body.message);
  if (message === null) return { ok: false, field: "message" };

  return { ok: true, value: { servers, range, sources, filters, message } };
}

export function parseFollowupRequest(body: unknown): Parsed<FollowupRequest> {
  if (!isObj(body) || !onlyKeys(body, ["session_id", "message"])) return { ok: false, field: "body" };
  if (typeof body.session_id !== "string" || !SESSION_ID_RE.test(body.session_id)) return { ok: false, field: "session_id" };
  const message = parseMessage(body.message);
  if (message === null) return { ok: false, field: "message" };
  return { ok: true, value: { session_id: body.session_id, message } };
}
