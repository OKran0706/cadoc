import { api } from "@/lib/api";
import type {
  LoginRequest,
  TokenResponse,
  UserRole,
  Permission,
} from "@/lib/types";
import { ROLE_PERMISSIONS, KNOWN_PERSONAS } from "@/lib/types";
import { normalizeRole as normalizeRoleShared } from "@/lib/roles";

const AUTH_KEY = "sentinel_authenticated";
const TOKEN_KEY = "auth_token";
const USER_KEY = "sentinel_user";

export interface UserSession {
  email: string;
  role: UserRole;
  name: string;
  companySlug?: string;
  permissions: Permission[];
}

/**
 * Normalizes an arbitrary role string from the login API or JWT into a canonical UserRole.
 */
export function normalizeRole(roleStr: unknown): UserRole | null {
  return normalizeRoleShared(roleStr); // rules live in @/lib/roles, shared with the server-side AI guard
}

/**
 * Resolves the role for a user given their login API response, token payload, or known persona definition.
 * Prioritizes the role returned by the login API.
 */
export function resolveUserRole(
  email: string,
  slug: string,
  payload?: Record<string, unknown>,
  apiResponse?: TokenResponse
): UserRole {
  // 1. Direct role from Login API response body (role, roles array, or user.role)
  const directApiRole =
    apiResponse?.role ||
    (Array.isArray(apiResponse?.roles) ? apiResponse?.roles[0] : undefined) ||
    apiResponse?.user?.role ||
    (Array.isArray(apiResponse?.user?.roles) ? apiResponse?.user?.roles[0] : undefined);

  const normalizedFromApi = normalizeRole(directApiRole);
  if (normalizedFromApi) {
    return normalizedFromApi;
  }

  // 2. Role from decoded JWT token payload
  const jwtRole =
    payload?.role ||
    (Array.isArray(payload?.roles) ? payload?.roles[0] : undefined) ||
    payload?.role_name ||
    payload?.user_role ||
    (payload?.realm_access as any)?.roles?.[0];

  const normalizedFromJwt = normalizeRole(jwtRole);
  if (normalizedFromJwt) {
    return normalizedFromJwt;
  }

  // 3. Fallback to Known Personas definition if email is explicitly registered
  if (KNOWN_PERSONAS[email]) {
    return KNOWN_PERSONAS[email].role;
  }

  // 4. Fallback based on tenant scope or email heuristics
  if (slug === "global" && (email === "admin@cadoc.io" || email.toLowerCase().includes("admin"))) {
    return "platform_owner";
  }
  if (email.toLowerCase().includes("admin") || email.toLowerCase().includes("alice")) {
    return "tenant-admin";
  }
  return "read-only";
}

/**
 * Authenticates against POST /api/v1/auth/login
 * Stores token + session info in localStorage, capturing the role from the login API response.
 */
export async function loginUser(
  email: string,
  password: string,
  companySlug?: string
): Promise<TokenResponse> {
  const slug = companySlug || "mock-acme";
  const data = await api.post<TokenResponse>("/api/v1/auth/login", {
    email,
    password,
    company_slug: slug,
  } satisfies LoginRequest);

  // Decode JWT payload
  let payload: Record<string, unknown> = {};
  let displayName = email.split("@")[0];
  try {
    payload = JSON.parse(atob(data.access_token.split(".")[1]));
    if (typeof payload.name === "string" && payload.name) {
      displayName = payload.name;
    }
  } catch {
    // ignore decode errors
  }

  if (data.user?.display_name || data.user?.name) {
    displayName = data.user.display_name || data.user.name || displayName;
  } else if (KNOWN_PERSONAS[email]?.displayName && !payload.name) {
    displayName = KNOWN_PERSONAS[email].displayName;
  }

  // Prioritize role coming from the login API response
  const role = resolveUserRole(email, slug, payload, data);
  const permissions = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS["read-only"];

  // Persist session
  localStorage.setItem(AUTH_KEY, "true");
  localStorage.setItem(TOKEN_KEY, data.access_token);
  localStorage.setItem(
    USER_KEY,
    JSON.stringify({
      email,
      name: displayName,
      role,
      companySlug: slug,
      permissions,
    } satisfies UserSession)
  );

  setAuthCookie(data.access_token);

  return data;
}

const COOKIE_NAME = "sentinel_token";

export function setAuthCookie(token: string): void {
  if (typeof document === "undefined") return;
  const secure = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; path=/; max-age=86400; SameSite=Strict${secure}`;
}

export function clearAuthCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Strict`;
}

/**
 * Populates a simulated or offline demo session for testing specific personas.
 */
export function setDemoSession(
  email: string,
  customRole?: UserRole,
  customSlug?: string,
  customName?: string
): UserSession {
  const persona = KNOWN_PERSONAS[email];
  const role: UserRole =
    customRole || persona?.role || (email === "admin@cadoc.io" ? "platform_owner" : "tenant-admin");
  const companySlug = customSlug || persona?.companySlug || "mock-acme";
  const name = customName || persona?.displayName || email.split("@")[0];
  const permissions = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS["read-only"];

  const session: UserSession = {
    email,
    name,
    role,
    companySlug,
    permissions,
  };

  if (typeof window !== "undefined") {
    const demoToken = `demo.${btoa(JSON.stringify({ email, name, role, company_slug: companySlug }))}.sig`;
    localStorage.setItem(AUTH_KEY, "true");
    localStorage.setItem(TOKEN_KEY, demoToken);
    localStorage.setItem(USER_KEY, JSON.stringify(session));
    setAuthCookie(demoToken);
  }

  return session;
}

export function isAuthenticated(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(AUTH_KEY) === "true";
}

export function getSessionUser(): UserSession | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (raw) {
    try {
      const user = JSON.parse(raw);
      if (user && user.role) {
        // Strictly honor role set from login API response
        const normalized = normalizeRole(user.role) || (user.role as UserRole);
        user.role = normalized;
        const defaultPerms = ROLE_PERMISSIONS[user.role as UserRole] || ROLE_PERMISSIONS["read-only"];
        user.permissions = Array.from(new Set([...(user.permissions || []), ...defaultPerms]));
        return user;
      }
    } catch {
      // fallback to token decode below
    }
  }

  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    try {
      const parts = token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(atob(parts[1]));
        const email = payload.email || payload.sub || "user@sentinel.local";
        const slug = payload.company_slug || "mock-acme";
        const role = resolveUserRole(email, slug, payload);
        const permissions = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS["read-only"];
        const session: UserSession = {
          email,
          name: payload.name || email.split("@")[0],
          role,
          companySlug: slug,
          permissions,
        };
        localStorage.setItem(USER_KEY, JSON.stringify(session));
        return session;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function logout(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  clearAuthCookie();
}

