// Real read-only Backend: GET-only calls to the platform API with the CALLER's bearer token,
// so the backend's own tenant scoping and RBAC apply to every record we read.
//
// allowSelfSigned: the deployed backend may present a certificate Node does not trust. When (and only when)
// the operator opts in, THIS client accepts it via its own https.Agent. It never touches the process-wide
// NODE_TLS_REJECT_UNAUTHORIZED flag, so no other outbound call (e.g. to Gemini) loses certificate checks.

import http from "node:http";
import https from "node:https";
import { BackendError } from "./errors.ts";
import type { Backend } from "./types.ts";

const MAX_BYTES = 10 * 1024 * 1024;
let insecureAgent: https.Agent | undefined;

/** Short, secret-free description of a network failure (error code only), for operator logs. */
function describe(e: unknown): string {
  const x = e as { name?: string; code?: string; cause?: { code?: string; name?: string; message?: string } } | null;
  if (x?.name === "TimeoutError" || x?.name === "AbortError" || x?.cause?.name === "TimeoutError") return "timeout";
  return x?.cause?.code ?? x?.code ?? x?.cause?.message?.slice(0, 60) ?? x?.name ?? "network error";
}

function rawGet(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    insecureAgent ??= new https.Agent({ rejectUnauthorized: false });
    const req = (secure ? https : http).request(
      url,
      { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs), ...(secure ? { agent: insecureAgent } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) req.destroy(Object.assign(new Error("response too large"), { code: "RESPONSE_TOO_LARGE" }));
          else chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

export function createHttpBackend(opts: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowSelfSigned?: boolean;
}): Backend {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return {
    async get(path, params = {}) {
      if (!path.startsWith("/api/v1/") || path.includes("..")) throw new BackendError(400, "bad path");
      const url = new URL(`${opts.baseUrl}${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const headers = { authorization: `Bearer ${opts.token}`, accept: "application/json" };

      let status: number;
      let body: string;
      try {
        if (opts.allowSelfSigned && !opts.fetchImpl) {
          ({ status, body } = await rawGet(url, headers, timeoutMs));
        } else {
          const res = await (opts.fetchImpl ?? fetch)(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
          if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw Object.assign(new Error("too large"), { code: "RESPONSE_TOO_LARGE" });
          status = res.status;
          body = status >= 200 && status < 300 ? await res.text() : "";
        }
      } catch (e) {
        // path only (no query string, no token): safe for operator logs
        throw new BackendError(0, `GET ${path} failed: ${describe(e)}`);
      }
      if (status < 200 || status >= 300) throw new BackendError(status, `GET ${path} returned ${status}`);
      try {
        return JSON.parse(body);
      } catch {
        throw new BackendError(502, `GET ${path} returned invalid JSON`);
      }
    },
  };
}
