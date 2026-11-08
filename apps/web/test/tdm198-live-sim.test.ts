import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pageExtensionsFor } from "../lib/page-extensions";

// TDM-198: the simulated live run page exists only under `next dev`. Production builds treat only
// page.{tsx,ts,jsx,js} as routes, so app/dev/live-sim/page.dev.tsx (and the simulator it imports
// from test/fixtures) never ships.

const APP = path.join(import.meta.dirname, "..", "app");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(path.join(dir, d.name)) : [path.join(dir, d.name)],
  );
}

describe("dev-only /dev/live-sim (TDM-198)", () => {
  it("routes *.dev.tsx only in development", () => {
    expect(pageExtensionsFor("development")).toContain("dev.tsx");
    expect(pageExtensionsFor("production")).not.toContain("dev.tsx");
    expect(pageExtensionsFor("test")).not.toContain("dev.tsx");
    expect(pageExtensionsFor(undefined)).not.toContain("dev.tsx");
  });

  it("has no production page under app/dev, and every dev page is a .dev.tsx", () => {
    const dev = files(path.join(APP, "dev"));
    expect(dev.some((f) => f.endsWith("page.dev.tsx"))).toBe(true);
    const prodPages = dev.filter((f) => /\/page\.(tsx|ts|jsx|js)$/.test(f));
    expect(prodPages).toEqual([]);
  });

  it("no production route imports the simulator", async () => {
    const { readFileSync } = await import("node:fs");
    const prodRoutes = files(APP).filter(
      (f) => /\.(tsx|ts)$/.test(f) && !f.includes(`${path.sep}dev${path.sep}`),
    );
    for (const f of prodRoutes)
      expect(readFileSync(f, "utf8"), f).not.toMatch(/fixtures\/simulator/);
  });
});
