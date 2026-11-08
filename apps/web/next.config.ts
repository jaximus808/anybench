import type { NextConfig } from "next";
import { upstreamApiUrl, WEB_API_BASE } from "./lib/api-upstream";
import { pageExtensionsFor } from "./lib/page-extensions";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `*.dev.tsx` routes (the /dev/live-sim simulator) exist only under `next dev`.
  pageExtensions: pageExtensionsFor(process.env.NODE_ENV),
  // @anybench/core ships ESM from dist/; transpiling keeps its `.js` specifiers bundler-friendly.
  transpilePackages: ["@anybench/core"],
  // Same-origin API proxy (TDM-100): the browser calls /api/*, so the session cookie (and the
  // OAuth state cookie, when the GitHub callback is <web>/api/auth/github/callback) is first-party.
  // The retired TDM-204/205 public routes point at their /r equivalents (the signed publication
  // page and its embed card); query strings (?theme=) carry over and unknown slugs 404 at /r.
  async redirects() {
    return [
      { source: "/b/:owner/:slug", destination: "/r/:slug", permanent: false },
      { source: "/embed/:slug", destination: "/r/:slug/embed", permanent: false },
    ];
  },
  async rewrites() {
    return [{ source: `${WEB_API_BASE}/:path*`, destination: `${upstreamApiUrl()}/:path*` }];
  },
};

export default nextConfig;
