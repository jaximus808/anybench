// TDM-205: what GET /public/embed/:slug and GET /public/benchmarks/:owner/:slug return
// (packages/core/src/api/publish.ts). Parsed through the route's response schema so the fixture
// stays valid against the contract while the server (TDM-207) is built.
import { apiRoutes, PROOF_CHECKS, type RouteOutput } from "@anybench/core";
import { tdm103Report, TDM103_RUN_ID } from "./tdm103-report";

export type EmbedPayload = RouteOutput<typeof apiRoutes.publish.embed>;
export type PublicBenchmark = RouteOutput<typeof apiRoutes.publish.page>;

export const TDM205_SLUG = "tandem-vs-solo";
export const TDM205_OWNER = "jaxonp";
export const TDM205_PAGE_URL = `https://anybench.jaxonp.com/b/${TDM205_OWNER}/${TDM205_SLUG}`;

export function tdm205Embed(over: Partial<EmbedPayload> = {}): EmbedPayload {
  return apiRoutes.publish.embed.response.parse({
    slug: TDM205_SLUG,
    title: "Tandem vs Claude Code solo",
    answer:
      "tandem finishes 41 s faster than claude-code-solo on these 3 tasks, at twice the cost.",
    version: 3,
    withdrawn: false,
    rows: [
      { name: "claude-code-solo", role: "baseline", score: 62 },
      { name: "tandem", role: "subject", score: 81.5 },
      { name: "tandem-lite", role: "subject", score: null },
    ],
    page_url: TDM205_PAGE_URL,
    ...over,
  });
}

const BENCHMARK_ID = "019a5f3e-7c00-7000-8000-000000000205";

export function tdm205PublicBenchmark(
  over: { visibility?: "public" | "unlisted" | "withdrawn"; scores?: boolean } = {},
): PublicBenchmark {
  const base = tdm103Report();
  const report = over.scores
    ? tdm103Report({
        contenders: base.contenders.map((c, i) => ({ ...c, score: i === 0 ? 62 : 81.5 })),
      })
    : base;
  return apiRoutes.publish.page.response.parse({
    benchmark: {
      id: BENCHMARK_ID,
      owner: TDM205_OWNER,
      slug: TDM205_SLUG,
      run_id: TDM103_RUN_ID,
      title: "Tandem vs Claude Code solo",
      kind: "harness",
      visibility: over.visibility ?? "public",
      latest_version: 3,
      pinned_version: null,
      auto_publish: false,
      page_url: TDM205_PAGE_URL,
      badge_url: `https://api.anybench.jaxonp.com/badge/${TDM205_SLUG}.svg`,
      embed_url: `https://anybench.jaxonp.com/embed/${TDM205_SLUG}`,
      created_at: "2026-11-08T08:00:00.000Z",
    },
    version: {
      version: 3,
      status: "live",
      report,
      attestation: {
        v: 1,
        benchmark_id: BENCHMARK_ID,
        slug: TDM205_SLUG,
        version: 3,
        run_id: TDM103_RUN_ID,
        kit_hash: "a".repeat(64),
        contenders: report.contenders.map((c) => ({
          contender_id: c.contender_id,
          name: c.name,
          version: null,
          snapshot_hash: null,
          score: c.score,
          ci95: c.ci95,
        })),
        trial_count: 20,
        proof: PROOF_CHECKS.map((check) => ({ check, pass: true })),
        comped: report.comped,
        created_at: "2026-11-08T08:00:00.000Z",
      },
      signature: "c2lnbmF0dXJl",
      key_id: "k1",
      created_at: "2026-11-08T08:00:00.000Z",
    },
    versions: [
      { version: 1, created_at: "2026-11-01T08:00:00.000Z" },
      { version: 3, created_at: "2026-11-08T08:00:00.000Z" },
    ],
  });
}
