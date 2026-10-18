// Conversation store (INV-AI-3). In-memory: owner-bound, TTL'd and size-bounded.
// Swap for Redis before running more than one instance.

import { randomUUID } from "node:crypto";
import type { DataUsed, Filters, LlmMessage, ServerRef, Source, TimeRange } from "./types.ts";

export interface SessionScope {
  servers: ServerRef[];
  range: TimeRange;
  sources: Source[];
  filters: Filters;
}

export interface Session {
  id: string;
  owner: string;
  scope: SessionScope;
  messages: LlmMessage[];
  dataUsed: DataUsed | null;
  truncation: string[];
  lastUsed: number;
}

export interface SessionStore {
  create(owner: string, scope: SessionScope): Session;
  get(owner: string, id: string): Session | null;
  append(owner: string, id: string, message: LlmMessage): boolean;
  delete(owner: string, id: string): void;
}

interface Options {
  now?: () => number;
  ttlMs?: number;
  maxPerUser?: number;
  maxTotal?: number;
  maxMessages?: number;
  maxChars?: number;
}

const size = (m: LlmMessage) => (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length);

export function createSessionStore(opts: Options = {}): SessionStore {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 2 * 60 * 60 * 1000;
  const maxPerUser = opts.maxPerUser ?? 5;
  const maxTotal = opts.maxTotal ?? 500;
  const maxMessages = opts.maxMessages ?? 24;
  const maxChars = opts.maxChars ?? 600_000;
  const sessions = new Map<string, Session>(); // insertion order == age

  const alive = (s: Session) => now() - s.lastUsed < ttlMs;

  function sweep() {
    for (const [id, s] of sessions) if (!alive(s)) sessions.delete(id);
  }

  function trim(s: Session) {
    // Always keep message 0 (it carries the data) and the newest message; drop the oldest follow-up turns.
    const over = () => s.messages.length > maxMessages || s.messages.reduce((n, m) => n + size(m), 0) > maxChars;
    while (over() && s.messages.length > 3) {
      s.messages.splice(1, 1);
      while (s.messages.length > 3 && s.messages[1]?.role === "user") s.messages.splice(1, 1);
    }
  }

  function owned(owner: string, id: string): Session | null {
    const s = sessions.get(id);
    if (!s || s.owner !== owner) return null;
    if (!alive(s)) {
      sessions.delete(id);
      return null;
    }
    return s;
  }

  return {
    create(owner, scope) {
      sweep();
      const mine = [...sessions.values()].filter((s) => s.owner === owner);
      for (const old of mine.slice(0, Math.max(0, mine.length - (maxPerUser - 1)))) sessions.delete(old.id);
      while (sessions.size >= maxTotal) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      const s: Session = { id: randomUUID(), owner, scope, messages: [], dataUsed: null, truncation: [], lastUsed: now() };
      sessions.set(s.id, s);
      return s;
    },
    get(owner, id) {
      const s = owned(owner, id);
      if (s) s.lastUsed = now();
      return s;
    },
    append(owner, id, message) {
      const s = owned(owner, id);
      if (!s) return false;
      s.messages.push(message);
      s.lastUsed = now();
      trim(s);
      return true;
    },
    delete(owner, id) {
      if (owned(owner, id)) sessions.delete(id);
    },
  };
}
