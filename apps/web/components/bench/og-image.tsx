// The link-preview image for a public benchmark (TDM-205): /b/<owner>/<slug>/opengraph-image,
// 1200×630, rendered by next/og (Satori: inline styles, flex layout, the bundled Geist font).
// Dark instrument palette, mono-style numbers, colour only for state. It shows the headline
// answer, then every setup: its score as a bar when the report has one, or its verdicts vs the
// baseline when it doesn't (no composite score is ever made up here). A setup without a gated
// score is hatched and never ranked.
import { apiRoutes, createApiClient, type RouteOutput } from "@anybench/core";
import type { ReactElement } from "react";
import { upstreamApiUrl } from "../../lib/api-upstream";
import { resultRows, splitAnswer } from "../report/model";

export type PublicBenchmark = RouteOutput<typeof apiRoutes.publish.page>;

export const OG_SIZE = { width: 1200, height: 630 } as const;

const C = {
  bg: "#0a0c09",
  surface: "#10130e",
  surface2: "#161a13",
  fg: "#eceee4",
  muted: "#8b9282",
  dim: "#5e6557",
  line: "#23281f",
  lineStrong: "#353c2e",
  accent: "#ff7a1a",
  pass: "#7bd88f",
  fail: "#ff6b5a",
  infra: "#4a5143",
} as const;

/** GET /public/benchmarks/:owner/:slug; null when it is missing or the API is down. */
export async function loadPublicBenchmark(
  owner: string,
  slug: string,
  client = createApiClient(upstreamApiUrl(), { kind: "none" }),
): Promise<PublicBenchmark | null> {
  try {
    return await client.call(apiRoutes.publish.page, { params: { owner, slug } });
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function score(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
}

function Mark() {
  const cells = ["p", "p", "f", "p", "r", "p", "p", "p", "p"];
  const fill: Record<string, string> = { p: C.fg, f: C.lineStrong, r: C.accent };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", width: 33, height: 33, gap: 3 }}>
      {cells.map((c, i) => (
        <div key={i} style={{ width: 9, height: 9, borderRadius: 2, background: fill[c] }} />
      ))}
    </div>
  );
}

type SetupLine = { name: string; role: string; score: number | null; verdicts: string[] };

function setupLines(data: PublicBenchmark): { scored: boolean; lines: SetupLine[] } {
  const report = data.version.report;
  const scored = report.contenders.some((c) => c.score !== null);
  const rows = resultRows(report);
  const lines = report.contenders.map((c) => ({
    name: c.name,
    role: c.role,
    score: c.score,
    verdicts: rows.flatMap((r) =>
      r.verdicts
        .filter((v) => v.contenderId === c.contender_id)
        .map((v) => `${r.requirementId}: ${v.word}`),
    ),
  }));
  if (scored) {
    // Ranked by score, highest first; setups without a gated score go last, unranked.
    lines.sort((a, b) =>
      a.score === null ? (b.score === null ? 0 : 1) : b.score === null ? -1 : b.score - a.score,
    );
  }
  return { scored, lines };
}

function Bars({ lines }: { lines: SetupLine[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {lines.slice(0, 4).map((l) => (
        <div key={l.name} style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ display: "flex", width: 300, alignItems: "baseline", gap: 12 }}>
            <div
              style={{ display: "flex", fontSize: 26, color: l.score === null ? C.muted : C.fg }}
            >
              {clip(l.name, 18)}
            </div>
            <div style={{ display: "flex", fontSize: 18, color: C.dim }}>{l.role}</div>
          </div>
          <div
            style={{
              display: "flex",
              flex: 1,
              height: 18,
              borderRadius: 3,
              background: C.surface2,
              border: `1px solid ${C.line}`,
              overflow: "hidden",
            }}
          >
            {l.score !== null ? (
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, l.score))}%`,
                  height: "100%",
                  background: l.role === "baseline" ? C.muted : C.fg,
                }}
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  backgroundImage: `repeating-linear-gradient(-45deg, ${C.infra} 0px, ${C.infra} 3px, transparent 3px, transparent 9px)`,
                }}
              />
            )}
          </div>
          <div
            style={{
              display: "flex",
              width: 170,
              justifyContent: "flex-end",
              fontSize: l.score === null ? 18 : 28,
              color: l.score === null ? C.dim : C.fg,
            }}
          >
            {l.score === null ? "no gated score" : score(l.score)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Verdicts({ lines }: { lines: SetupLine[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {lines.slice(0, 4).map((l) => (
        <div key={l.name} style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
          <div style={{ display: "flex", width: 300, alignItems: "baseline", gap: 12 }}>
            <div style={{ display: "flex", fontSize: 26, color: C.fg }}>{clip(l.name, 18)}</div>
            <div style={{ display: "flex", fontSize: 18, color: C.dim }}>{l.role}</div>
          </div>
          <div style={{ display: "flex", flex: 1, fontSize: 22, color: C.muted }}>
            {l.role === "baseline"
              ? "the baseline"
              : l.verdicts.length
                ? clip(l.verdicts.join(" · "), 70)
                : "no comparison vs the baseline"}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The preview image's element tree. `data` null: the benchmark is missing or unreachable. */
export function BenchmarkOg({
  data,
  owner,
  slug,
}: {
  data: PublicBenchmark | null;
  owner: string;
  slug: string;
}): ReactElement {
  const withdrawn = data?.benchmark.visibility === "withdrawn";
  const headline = data
    ? withdrawn
      ? "Withdrawn by its owner"
      : clip(splitAnswer(data.version.report.answer).headline, 150)
    : "A verified benchmark";
  const setups = data && !withdrawn ? setupLines(data) : null;
  const att = data?.version.attestation;
  const proofPassed = att ? att.proof.filter((p) => p.pass).length : 0;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: C.bg,
        color: C.fg,
        padding: "48px 64px",
        fontFamily: "Geist",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Mark />
          <div style={{ display: "flex", fontSize: 26, color: C.fg }}>Anybench · verified</div>
        </div>
        <div style={{ display: "flex", fontSize: 20, color: C.muted }}>
          {data
            ? `v${data.version.version} · ${data.version.attestation.trial_count} trials · ${data.benchmark.kind}`
            : `${owner}/${slug}`}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 40,
          fontSize: 24,
          color: C.muted,
          textTransform: "uppercase",
          letterSpacing: 2,
        }}
      >
        {clip(data?.benchmark.title ?? slug, 60)}
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 14,
          fontSize: headline.length > 100 ? 40 : 52,
          lineHeight: 1.15,
          letterSpacing: -1,
          color: withdrawn ? C.muted : C.fg,
        }}
      >
        {headline}
      </div>

      <div style={{ display: "flex", flex: 1 }} />

      {setups ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            paddingTop: 24,
            borderTop: `1px solid ${C.line}`,
          }}
        >
          {setups.scored ? <Bars lines={setups.lines} /> : <Verdicts lines={setups.lines} />}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 28,
          fontSize: 20,
          color: C.dim,
        }}
      >
        <div style={{ display: "flex" }}>{`anybench.jaxonp.com/b/${owner}/${slug}`}</div>
        <div style={{ display: "flex", gap: 18 }}>
          {att ? (
            <div
              style={{ display: "flex", color: proofPassed === att.proof.length ? C.pass : C.fail }}
            >
              {`proof ${proofPassed}/${att.proof.length}`}
            </div>
          ) : null}
          {att?.comped ? <div style={{ display: "flex" }}>comped run</div> : null}
          {att ? <div style={{ display: "flex" }}>Ed25519 signed</div> : null}
        </div>
      </div>
    </div>
  );
}
