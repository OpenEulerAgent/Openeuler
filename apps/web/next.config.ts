import type { NextConfig } from "next";

// The preview proxy (#108) lives on the daemon; the run detail Preview tab
// (#109) frames it SAME-ORIGIN at `/previews/:runId/:port/*`, so the web
// app transparently proxies the mount (query — including `?token=` when
// auth is on — rides along). Same-origin framing keeps the iframe free of
// CORS/framing concerns; the daemon stays the enforcement point.
const daemonUrl = (process.env.NEXT_PUBLIC_DAEMON_URL ?? "http://localhost:8787").replace(
  /\/+$/,
  "",
);

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/previews/:path*", destination: `${daemonUrl}/previews/:path*` }];
  },
};

export default nextConfig;
