import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // @anybench/core ships ESM from dist/; transpiling keeps its `.js` specifiers bundler-friendly.
  transpilePackages: ["@anybench/core"],
};

export default nextConfig;
