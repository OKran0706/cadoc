import type { HealthResponse } from "@/lib/types";

/**
 * GET /health — no auth required.
 * Routed through local Next.js proxy to avoid browser self-signed SSL block.
 */
export async function checkHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}
