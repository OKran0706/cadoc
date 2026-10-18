// Secret redaction applied to EVERYTHING that is sent to the LLM (INV-AI-4).
// Hashes, file paths, hostnames and timestamps are metadata and are left alone.

export interface RedactResult {
  text: string;
  count: number;
}

const R = "[REDACTED]";

const SENSITIVE_WORD =
  "passw(?:or)?d|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|auth[_-]?key";

// key (contains a sensitive word) [quote] =|: value
const KV_RE = new RegExp(
  `([A-Za-z0-9_.-]*(?:${SENSITIVE_WORD})[A-Za-z0-9_.-]*)(["']?\\s*[=:]\\s*)((?:Bearer|Basic)\\s+[^\\s,;&"']+|"[^"\\n]*"|'[^'\\n]*'|[^\\s,;&"'}\\]]+)`,
  "gi"
);

const SENSITIVE_KEY_RE = new RegExp(`(?:${SENSITIVE_WORD})|^pass$`, "i");
const CONTENT_KEY_RE = /^(?:file[_-]?)?contents?$|^env(?:[_-]?vars|ironment(?:[_-]?variables)?)?$/i;

const PEM_FULL = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g;
const JWT_RE = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
const BEARER_RE = /\bBearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{16,}/g;
const CONN_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):(?!\[REDACTED)([^@\s/]+)@/gi;
const ENV_LINE_RE = /^([A-Z][A-Z0-9_]{1,})=(.*)$/gm;
const TOKEN_PATTERNS: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/g, "aws-key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "github-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github-token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "api-key"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "google-api-key"],
];

export function redactText(input: string): RedactResult {
  if (typeof input !== "string" || input.length === 0) return { text: input, count: 0 };
  let count = 0;
  const swap = (re: RegExp, to: string | ((m: string, ...g: string[]) => string), s: string) =>
    s.replace(re, (...args: unknown[]) => {
      const m = args[0] as string;
      const out = typeof to === "string" ? to : to(m, ...(args.slice(1) as string[]));
      if (out !== m) count++;
      return out;
    });

  let t = input;
  t = swap(PEM_FULL, "[REDACTED:private-key]", t);
  t = swap(PEM_OPEN, "[REDACTED:private-key]", t);
  t = swap(JWT_RE, "[REDACTED:jwt]", t);
  for (const [re, label] of TOKEN_PATTERNS) t = swap(re, `[REDACTED:${label}]`, t);
  t = swap(BEARER_RE, "Bearer [REDACTED:token]", t);
  t = swap(CONN_RE, (_m, scheme, user) => `${scheme}${user}:${R}@`, t);
  t = swap(KV_RE, (m, key, sep, value) => (value.startsWith("[REDACTED") || value === R ? m : `${key}${sep}${R}`), t);
  t = swap(ENV_LINE_RE, (m, name, value) => (value.trim() === "" || value.startsWith("[REDACTED") ? m : `${name}=${R}`), t);
  return { text: t, count };
}

const MAX_DEPTH = 8;

/** Deep redaction: sensitive keys lose their value, every string goes through redactText. Never mutates. */
export function redactValue<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const r = redactText(v);
      count += r.count;
      return r.text;
    }
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH) {
      count++;
      return R;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== null && val !== undefined && val !== "" && (SENSITIVE_KEY_RE.test(k) || CONTENT_KEY_RE.test(k))) {
        if (val !== R) count++;
        out[k] = R;
      } else {
        out[k] = walk(val, depth + 1);
      }
    }
    return out;
  };
  return { value: walk(value, 0) as T, count };
}
