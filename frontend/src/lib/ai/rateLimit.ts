// Per-user abuse controls (INV-AI-7). In-memory => per server instance.

export interface RateLimiter {
  check(key: string): { ok: true } | { ok: false; retryAfterSec: number };
}

export function createRateLimiter(opts: { max: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return {
    check(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < opts.windowMs);
      if (recent.length >= opts.max) {
        hits.set(key, recent);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + opts.windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 2000) {
        for (const [k, v] of hits) if (v.every((x) => t - x >= opts.windowMs)) hits.delete(k);
      }
      return { ok: true };
    },
  };
}

export interface ConcurrencyGate {
  /** Returns a release function (idempotent), or null when the user is at their cap. */
  acquire(key: string): (() => void) | null;
}

export function createConcurrencyGate(opts: { max: number }): ConcurrencyGate {
  const active = new Map<string, number>();
  return {
    acquire(key) {
      const n = active.get(key) ?? 0;
      if (n >= opts.max) return null;
      active.set(key, n + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const cur = (active.get(key) ?? 1) - 1;
        if (cur <= 0) active.delete(key);
        else active.set(key, cur);
      };
    },
  };
}
