// Single source of truth for turning role strings (login response, JWT claims) into canonical roles.
// Pure and dependency-free so both the browser (authService) and the AI server guard use the SAME rules.

import { ROLE_PERMISSIONS } from "./types.ts";
import type { Permission, UserRole } from "./types.ts";

/** Normalizes an arbitrary role string from the login API or a JWT into a canonical UserRole. */
export function normalizeRole(roleStr: unknown): UserRole | null {
  if (typeof roleStr !== "string") return null;
  const r = roleStr.trim().toLowerCase();
  if (r in ROLE_PERMISSIONS) return r as UserRole;
  if (r.includes("owner") && /(tenant|client|organi[sz]ation)/.test(r)) {
    return "tenant-admin";
  }
  if (r.includes("platform") || r.includes("owner") || r.includes("superadmin") || r.includes("global")) {
    return "platform_owner";
  }
  if (r.includes("admin")) {
    return "tenant-admin";
  }
  if (r.includes("analyst") || r.includes("operator")) {
    return "security-analyst";
  }
  if (r.includes("read") || r.includes("viewer") || r.includes("audit") || r.includes("readonly")) {
    return "read-only";
  }
  return null;
}

const MAX_ROLES = 10;
const MAX_ROLE_LEN = 64;

/** Every role string a token claims, using the same claim shapes the login flow understands. Bounded and de-duplicated. */
export function claimRoles(claims: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim() && out.length < MAX_ROLES) out.push(v.trim().slice(0, MAX_ROLE_LEN));
  };
  const addAll = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(add);
  };
  add(claims.role);
  addAll(claims.roles);
  add(claims.role_name);
  add(claims.user_role);
  const realm = claims.realm_access;
  if (realm && typeof realm === "object") addAll((realm as Record<string, unknown>).roles);
  return [...new Set(out)];
}

/**
 * Do these roles grant `permission`? `determined` is false when no role string maps to a known role
 * (so the caller can fall back to asking the backend instead of guessing). Permissions are a union.
 */
export function roleGrants(roles: string[], permission: Permission): { determined: boolean; allowed: boolean } {
  const canonical = roles.map(normalizeRole).filter((r): r is UserRole => r !== null);
  if (canonical.length === 0) return { determined: false, allowed: false };
  const allowed = canonical.some((r) => {
    const perms = ROLE_PERMISSIONS[r] as Permission[];
    return perms.includes("*") || perms.includes(permission);
  });
  return { determined: true, allowed };
}
