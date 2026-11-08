import type { NextConfig } from "next";
import { upstreamApiUrl, WEB_API_BASE } from "./lib/api-upstream";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // @anybench/core ships ESM from dist/; transpiling keeps its `.js` specifiers bundler-friendly.
  transpilePackages: ["@anybench/core"],
  // Same-origin API proxy (TDM-100): the browser calls /api/*, so the session cookie (and the
  // OAuth state cookie, when the GitHub callback is <web>/api/auth/github/callback) is first-party.
  async rewrites() {
    return [{ source: `${WEB_API_BASE}/:path*`, destination: `${upstreamApiUrl()}/:path*` }];
  },
};

export default nextConfig;
