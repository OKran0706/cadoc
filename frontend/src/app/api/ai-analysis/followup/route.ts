import { getAiHandlers } from "@/lib/ai/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return getAiHandlers().followup(request);
}
