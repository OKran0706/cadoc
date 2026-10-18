// Admin-only gate (INV-AI-1). Order matters and fails closed:
//   1. Authorization: Bearer header required (cookie is NOT accepted => no CSRF surface)
//   2. cheap deny from the token itself (malformed / expired)
//   3. the token's role claims, read with the SAME rules as the UI (src/lib/roles.ts):
//        - a known role without ai.analyze (analyst / read-only)  => 403 reason=role, no backend call
//        - a known admin role                                    => the backend must still accept the token
//                                                                   (a tenant-scoped read) before the claim is trusted
//        - no usable role claim                                  => the backend decides, via an admin-only probe
//   The /admins/* endpoints work on global_admins (platform owners), so they are NOT used for tenant admins.

import { createHash } from "node:crypto";
import { claimRoles, roleGrants } from "../roles.ts";
import { AiHttpError, mapBackendError } from "./errors.ts";
import type { AuditActor } from "./audit.ts";
import type { Backend } from "./types.ts";

export interface Identity extends AuditActor {
  token: string;
}

const BEARER_RE = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,4096})$/i;
const NEEDED = "ai.analyze";
export const TOKEN_VALIDITY_PATH = "/api/v1/servers/";

function decodeClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export async function authorizeAdmin(opts: {
  headers: Headers;
  createBackend: (token: string) => Backend;
  /** Admin-only GET used only when the token states no usable role. */
  probePath: string;
  now: () => number;
}): Promise<Identity> {
  const m = BEARER_RE.exec(opts.headers.get("authorization") ?? "");
  if (!m) throw new AiHttpError(401, "unauthenticated");
  const token = m[1];

  const claims = decodeClaims(token);
  if (!claims) throw new AiHttpError(401, "unauthenticated");
  if (typeof claims.exp === "number" && claims.exp * 1000 <= opts.now()) throw new AiHttpError(401, "unauthenticated");

  const roles = claimRoles(claims);
  const identity: Identity = {
    id: s(claims.sub) ?? s(claims.email) ?? createHash("sha256").update(token).digest("hex").slice(0, 16),
    email: s(claims.email),
    role: roles[0],
    company: s(claims.company_slug),
    token,
  };

  const verdict = roleGrants(roles, NEEDED);
  if (verdict.determined && !verdict.allowed) {
    throw Object.assign(new AiHttpError(403, "forbidden", `token role "${roles.join(",")}" does not hold ${NEEDED}`), { identity });
  }

  const backend = opts.createBackend(token);
  try {
    // Admin by claim: prove the token is genuine with a read every dashboard role may do.
    // No usable claim: ask the backend whether this account passes its own admin-only check.
    await backend.get(verdict.determined ? TOKEN_VALIDITY_PATH : opts.probePath, { limit: 1 });
  } catch (e) {
    const he = mapBackendError(e);
    if (he.status === 403 && !verdict.determined) {
      he.reason = `token states no role and the backend admin check ${opts.probePath} answered 403; set AI_ADMIN_PROBE_PATH to an endpoint your admin role may read, or make the login token carry a role claim`;
    }
    throw Object.assign(he, { identity });
  }
  return identity;
}
