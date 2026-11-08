// @vitest-environment node
import { createApiClient } from "@anybench/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { afterEach, describe, expect, it, vi } from "vitest";
import OgImage, { contentType, size } from "../app/b/[owner]/[slug]/opengraph-image";
import TwitterImage from "../app/b/[owner]/[slug]/twitter-image";
import { BenchmarkOg, loadPublicBenchmark } from "../components/bench/og-image";
import { TDM205_OWNER, TDM205_SLUG, tdm205PublicBenchmark } from "./fixtures/tdm205-embed";

// TDM-205: /b/<owner>/<slug>/opengraph-image (and twitter-image) render a 1200×630 PNG from
// GET /public/benchmarks/:owner/:slug: the headline answer and every setup, scored bars when
// the report has scores, verdicts vs the baseline when it doesn't, "withdrawn" when unpublished,
// and a generic card when the benchmark can't be read.

const PNG = [0x89, 0x50, 0x4e, 0x47];
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Set TDM205_OG_OUT=<dir> to write the rendered PNGs there for a look. */
async function png(res: Response, name: string): Promise<Uint8Array> {
  expect(res.headers.get("content-type")).toBe("image/png");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const out = process.env.TDM205_OG_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.png`), bytes);
  }
  return bytes;
}

function dims(bytes: Uint8Array): [number, number] {
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  return [v.getUint32(16), v.getUint32(20)];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("benchmark OG image", () => {
  const cases = {
    verdicts: tdm205PublicBenchmark(),
    scores: tdm205PublicBenchmark({ scores: true }),
    withdrawn: tdm205PublicBenchmark({ visibility: "withdrawn" }),
    missing: null,
  };
  for (const [name, data] of Object.entries(cases)) {
    it(`renders a 1200×630 PNG (${name})`, async () => {
      const res = new ImageResponse(
        <BenchmarkOg data={data} owner={TDM205_OWNER} slug={TDM205_SLUG} />,
        size,
      );
      const bytes = await png(res, `og-${name}`);
      expect([...bytes.slice(0, 4)]).toEqual(PNG);
      expect(dims(bytes)).toEqual([1200, 630]);
    }, 30_000);
  }

  it("the routes fetch the public benchmark and return the image", async () => {
    vi.stubEnv("ANYBENCH_API_URL", "https://api.example");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return json(200, tdm205PublicBenchmark({ scores: true }));
    });
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    const params = Promise.resolve({ owner: TDM205_OWNER, slug: TDM205_SLUG });
    for (const [name, route] of [
      ["route-og", OgImage],
      ["route-twitter", TwitterImage],
    ] as const) {
      const bytes = await png(await route({ params }), name);
      expect([...bytes.slice(0, 4)]).toEqual(PNG);
    }
    expect(urls[0]).toBe(`https://api.example/public/benchmarks/${TDM205_OWNER}/${TDM205_SLUG}`);
  }, 60_000);

  it("a missing or unreachable benchmark loads as null (the generic card)", async () => {
    const client = (status: number) =>
      createApiClient(
        "https://api.test",
        { kind: "none" },
        { fetch: async () => json(status, {}) },
      );
    expect(await loadPublicBenchmark(TDM205_OWNER, TDM205_SLUG, client(404))).toBeNull();
    expect(await loadPublicBenchmark(TDM205_OWNER, TDM205_SLUG, client(500))).toBeNull();
    const down = createApiClient(
      "https://api.test",
      { kind: "none" },
      {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      },
    );
    expect(await loadPublicBenchmark(TDM205_OWNER, TDM205_SLUG, down)).toBeNull();
  });
});
