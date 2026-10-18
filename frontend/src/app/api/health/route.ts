import { NextResponse } from "next/server";

// Force Node.js to ignore self-signed cert validation for this route handler process
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://ec2-3-89-18-5.compute-1.amazonaws.com";

export async function GET() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error(`[Health Proxy Error] Failed to fetch health:`, error.message);
    return NextResponse.json(
      { status: "error", error: error.message },
      { status: 502 }
    );
  }
}
