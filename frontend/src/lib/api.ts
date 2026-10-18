/**
 * Centralized API client for the Cadoc Sentinel Dashboard.
 *
 * • Reads base URL from NEXT_PUBLIC_API_URL env var
 * • Automatically attaches Bearer token from localStorage
 * • On 401 → clears session and redirects to /login
 * • Provides typed get / post / put / patch / delete helpers
 */

const API_BASE_URL =
  typeof window !== "undefined"
    ? "" // Relative paths on client side to route through Next.js proxy rewrite
    : (process.env.NEXT_PUBLIC_API_URL || "https://ec2-3-89-18-5.compute-1.amazonaws.com");

const AUTH_KEY = "sentinel_authenticated";
const TOKEN_KEY = "auth_token";
const USER_KEY = "sentinel_user";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

function clearSession(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  if (typeof document !== "undefined") {
    document.cookie = "sentinel_token=; path=/; max-age=0; SameSite=Strict";
  }
}


// ─── Core fetch wrapper ──────────────────────────────────────────────────────

interface FetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean>;
}

export async function apiFetch<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { params, headers, ...restOptions } = options;

  // Normalise endpoint
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  let url = `${API_BASE_URL}${path}`;

  // Query string
  if (params) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => qs.append(k, String(v)));
    url += `?${qs.toString()}`;
  }

  // Default headers
  const defaultHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Attach token when available (skip for login requests)
  const token = getToken();
  if (token && !path.startsWith("/api/v1/auth/login")) {
    defaultHeaders["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...restOptions,
    headers: { ...defaultHeaders, ...headers },
  });

  // ── 401 handling: clear session & redirect ──
  // Skip for the login call itself, where 401 just means bad credentials.
  if (response.status === 401 && !path.startsWith("/api/v1/auth/login")) {
    clearSession();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new Error("Session expired. Redirecting to login.");
  }

  // ── Other errors ──
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const detail =
      typeof errBody.detail === "string"
        ? errBody.detail
        : Array.isArray(errBody.detail)
          ? errBody.detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join("; ")
          : undefined;
    throw new Error(
      detail ||
        errBody.message ||
        `API ${response.status}: ${response.statusText}`
    );
  }

  // 204 No Content
  if (response.status === 204) return {} as T;

  return response.json();
}

// ─── Semantic helpers ─────────────────────────────────────────────────────────

export const api = {
  get: <T>(endpoint: string, opts?: FetchOptions) =>
    apiFetch<T>(endpoint, { ...opts, method: "GET" }),

  post: <T>(endpoint: string, data?: unknown, opts?: FetchOptions) =>
    apiFetch<T>(endpoint, {
      ...opts,
      method: "POST",
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),

  put: <T>(endpoint: string, data?: unknown, opts?: FetchOptions) =>
    apiFetch<T>(endpoint, {
      ...opts,
      method: "PUT",
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),

  patch: <T>(endpoint: string, data?: unknown, opts?: FetchOptions) =>
    apiFetch<T>(endpoint, {
      ...opts,
      method: "PATCH",
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),

  delete: <T>(endpoint: string, opts?: FetchOptions) =>
    apiFetch<T>(endpoint, { ...opts, method: "DELETE" }),
};

// ─── SSE helper ───────────────────────────────────────────────────────────────

export class StreamingEventSource {
  url: string;
  onopen: ((this: EventSource, ev: Event) => any) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => any) | null = null;
  onerror: ((this: EventSource, ev: Event) => any) | null = null;
  private controller: AbortController | null = null;
  private isClosed = false;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private headers: Record<string, string>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
    this.connect();
  }

  private async connect() {
    if (this.isClosed) return;
    this.controller = new AbortController();

    try {
      const res = await fetch(this.url, {
        headers: {
          Accept: "text/event-stream",
          ...this.headers,
        },
        signal: this.controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE HTTP ${res.status}`);
      }

      if (this.onopen) {
        this.onopen.call(this as any, new Event("open"));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const block of lines) {
          const dataLines = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.replace(/^data:\s*/, ""));
          if (dataLines.length > 0 && this.onmessage) {
            this.onmessage.call(
              this as any,
              new MessageEvent("message", { data: dataLines.join("\n") })
            );
          }
        }
      }

      if (!this.isClosed) {
        this.scheduleReconnect();
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        if (this.onerror) {
          this.onerror.call(this as any, new Event("error"));
        }
        if (!this.isClosed) {
          this.scheduleReconnect();
        }
      }
    }
  }

  private scheduleReconnect() {
    if (this.isClosed || this.retryTimeout) return;
    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null;
      if (!this.isClosed) {
        const token = getToken();
        if (token) {
          this.headers["Authorization"] = `Bearer ${token}`;
        }
        this.connect();
      }
    }, 5000);
  }

  close() {
    this.isClosed = true;
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
    if (this.controller) {
      this.controller.abort();
    }
  }
}

/**
 * Creates an EventSource-compatible stream for server-sent events.
 * Transmits Bearer token strictly in Authorization header, preventing token leaks in URL query strings.
 */
export function createEventSource(endpoint: string): EventSource | null {
  if (typeof window === "undefined") return null;
  const token = getToken();
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const url = `${API_BASE_URL}${path}`;
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return new StreamingEventSource(url, headers) as unknown as EventSource;
}

