import { NextRequest, NextResponse } from "next/server";

// Suppress TLS validation only during local dev or when explicitly configured for self-signed staging certs
if (process.env.NODE_ENV !== "production" || process.env.ALLOW_SELF_SIGNED_CERTS === "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export const dynamic = "force-dynamic";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://ec2-3-89-18-5.compute-1.amazonaws.com";

// Catch all HTTP methods and proxy them to the backend
export async function GET(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const { path } = await props.params;
  return handleProxy(request, path);
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const { path } = await props.params;
  return handleProxy(request, path);
}

export async function PUT(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const { path } = await props.params;
  return handleProxy(request, path);
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const { path } = await props.params;
  return handleProxy(request, path);
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const { path } = await props.params;
  return handleProxy(request, path);
}

async function handleProxy(request: NextRequest, pathSegments: string[]) {
  const path = pathSegments.join("/");
  const url = new URL(request.url);

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    // Forward all headers but filter out host to avoid proxy host mismatch
    if (key.toLowerCase() !== "host") {
      headers.set(key, value);
    }
  });

  // Extract token from query params (e.g. SSE alerts stream) and inject as Bearer Authorization header
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${queryToken}`);
    }
    // Strip token from query parameters to prevent query-string logging in upstream proxies/access logs
    url.searchParams.delete("token");
  }

  // Guard against unauthenticated open-proxy relay for protected routes
  const isPublic = path.startsWith("auth/login") || path.startsWith("health");
  if (!isPublic && !headers.has("Authorization")) {
    return NextResponse.json(
      { detail: "Missing administrative credentials" },
      { status: 401 }
    );
  }

  const searchParams = url.search;

  // Resolve target backend URL. FastAPI strictly requires trailing slashes on list/create endpoints for decoys, keys, admins, projects, servers, and agents.
  // Next.js client redirects strip trailing slashes, so we force-append them here for matching paths.
  const forceTrailingSlashPaths = ["decoys", "keys", "admins", "projects", "servers", "agents"];
  const needsTrailingSlash = forceTrailingSlashPaths.includes(path.toLowerCase()) || url.pathname.endsWith("/");
  const targetUrl = `${BACKEND_URL}/api/v1/${path}${needsTrailingSlash ? "/" : ""}${searchParams}`;

  const method = request.method;
  let body: any = undefined;
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = await request.arrayBuffer();
    } catch {
      // No body or error reading it
    }
  }

  try {
    const res = await fetch(targetUrl, {
      method,
      headers,
      body,
      // @ts-ignore
      duplex: "half",
    });

    const resHeaders = new Headers();
    res.headers.forEach((value, key) => {
      // Don't forward transfer-encoding chunked or content-encoding gzip to prevent corrupt compression payloads
      if (
        key.toLowerCase() !== "transfer-encoding" &&
        key.toLowerCase() !== "content-encoding" &&
        // fetch() already decompressed the body, so the upstream length is wrong
        key.toLowerCase() !== "content-length"
      ) {
        resHeaders.set(key, value);
      }
    });

    const contentType = res.headers.get("content-type") || "";
    const isEventStream = contentType.toLowerCase().includes("text/event-stream");

    if (isEventStream && res.body) {
      resHeaders.set("Content-Type", "text/event-stream");
      resHeaders.set("Cache-Control", "no-cache, no-transform");
      resHeaders.set("Connection", "keep-alive");
      resHeaders.set("X-Accel-Buffering", "no");

      return new Response(res.body as any, {
        status: res.status,
        statusText: res.statusText,
        headers: resHeaders,
      });
    }

    const resBody = await res.arrayBuffer();
    return new NextResponse(resBody, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    });
  } catch (error: any) {
    console.error(`[Proxy Route Error] Failed to fetch ${targetUrl}:`, error.message);
    return NextResponse.json(
      { error: "Proxy connection failed", details: error.message },
      { status: 502 }
    );
  }
}
