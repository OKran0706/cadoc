import { NextRequest, NextResponse } from "next/server";
import { explainIncidentWithGemini } from "@/lib/geminiExplainer";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { node, incident, context } = body;

    if (!node) {
      return NextResponse.json({ error: "Missing node in payload" }, { status: 400 });
    }

    const headerKey = req.headers.get("x-gemini-api-key");
    const apiKey = headerKey || body.apiKey;

    const result = await explainIncidentWithGemini(node, incident, {
      allNodes: context?.allNodes || [],
      apiKey,
    });

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("API /api/incident-brief error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to generate incident brief" },
      { status: 500 }
    );
  }
}
