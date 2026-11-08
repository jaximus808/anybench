// Which files Next treats as routes. `*.dev.tsx` pages (e.g. app/dev/live-sim/page.dev.tsx, the
// simulated live run) exist only under `next dev`: production builds never see them, so the
// simulator can't ship (TDM-198). test/tdm198-live-sim.test.ts asserts this.
const BASE = ["tsx", "ts", "jsx", "js"];

export function pageExtensionsFor(nodeEnv: string | undefined): string[] {
  return nodeEnv === "development" ? ["dev.tsx", ...BASE] : BASE;
}
