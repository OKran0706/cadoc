import { useState, useEffect } from "react";
import type { UserRole, Permission } from "@/lib/types";
import { ROLE_PERMISSIONS } from "@/lib/types";
import { getSessionUser, type UserSession } from "@/services/authService";

/**
 * Returns the declared permissions for a given role name.
 */
export function getRolePermissions(role: string): Permission[] {
  const normalized = (role || "").toLowerCase() as UserRole;
  if (normalized in ROLE_PERMISSIONS) {
    return ROLE_PERMISSIONS[normalized];
  }
  if (normalized.includes("owner") && /(tenant|client|organi[sz]ation)/.test(normalized)) {
    return ROLE_PERMISSIONS["tenant-admin"];
  }
  // Fallbacks for display role names
  if (normalized.includes("platform") || normalized.includes("owner")) {
    return ROLE_PERMISSIONS.platform_owner;
  }
  if (normalized.includes("admin")) {
    return ROLE_PERMISSIONS["tenant-admin"];
  }
  if (normalized.includes("analyst")) {
    return ROLE_PERMISSIONS["security-analyst"];
  }
  if (normalized.includes("read") || normalized.includes("viewer")) {
    return ROLE_PERMISSIONS["read-only"];
  }
  return ROLE_PERMISSIONS["read-only"];
}

/**
 * Checks whether a given user session has the required permission.
 * Wildcard permission ('*') grants access to all capabilities.
 */
export function hasPermission(
  permission: Permission,
  sessionUser?: UserSession | null
): boolean {
  if (!sessionUser) return false;

  const role = sessionUser.role || "read-only";
  const defaultPerms = getRolePermissions(role);
  const userPerms =
    Array.isArray(sessionUser.permissions) && sessionUser.permissions.length > 0
      ? sessionUser.permissions
      : defaultPerms;

  const perms = Array.from(new Set([...userPerms, ...defaultPerms]));

  if (perms.includes("*")) {
    return true;
  }

  return perms.includes(permission);
}

/**
 * React hook to access role permissions & authorization checks in client components.
 */
export function usePermissions() {
  const [session, setSession] = useState<UserSession | null>(null);

  useEffect(() => {
    setSession(getSessionUser());
  }, []);

  const role = session?.role || "read-only";
  const permissions =
    Array.isArray(session?.permissions) && session!.permissions.length > 0
      ? session!.permissions
      : getRolePermissions(role);

  const can = (permission: Permission): boolean =>
    hasPermission(permission, session);

  const isPlatformAdmin = role === "platform_owner" || permissions.includes("*");
  const isTenantAdmin = role === "tenant-admin";
  const isAnalyst = role === "security-analyst";
  const isReadOnly = role === "read-only";

  return {
    user: session,
    role,
    permissions,
    can,
    isPlatformAdmin,
    isTenantAdmin,
    isAnalyst,
    isReadOnly,
  };
}
