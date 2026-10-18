import { getAiHandlers } from "@/lib/ai/runtime";

// Streams an SSE analysis. Never cache, never prerender; needs Node APIs (crypto, streams).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return getAiHandlers().query(request);
}
