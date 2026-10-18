import type { NextConfig } from "next";
import path from "path";

const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // 'unsafe-eval' is required because @bible-strong/avatar-core relies on Ajv schema compilation
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:",
              "worker-src 'self' blob:",
              "child-src 'self' blob:",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https: blob:",
              "font-src 'self' data: https://tiles.openfreemap.org",
              "connect-src 'self' https://ec2-3-89-18-5.compute-1.amazonaws.com https://tiles.openfreemap.org https://*.openfreemap.org",
              "object-src 'none'",
              "base-uri 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
