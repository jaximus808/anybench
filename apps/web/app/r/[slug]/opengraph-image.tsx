import { ImageResponse } from "next/og";
import { fetchPublication } from "../../../lib/publish/fetch";
import { heroSentence, setupNames, trialLine } from "../../../lib/publish/view";
import { questionTitle } from "../../../lib/question-title";

// OG image for /r/<slug> (E12 12.6): the verdict in big type plus the setups, for link unfurls
// on X, Slack and LinkedIn. Instrument palette (dark); colour only for a called verdict.
export const alt = "Anybench benchmark result";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 300;

const C = {
  bg: "#0a0c09",
  fg: "#eceee4",
  muted: "#8b9282",
  dim: "#5e6557",
  line: "#353c2e",
  pass: "#7bd88f",
  fail: "#ff6b5a",
  accent: "#ff7a1a",
};

/** A Google Fonts TTF (the CSS API serves TTF to a plain fetch), or null within 2.5 s. */
async function googleFont(query: string): Promise<ArrayBuffer | null> {
  try {
    const css = await (
      await fetch(`https://fonts.googleapis.com/css2?family=${query}&display=swap`, {
        signal: AbortSignal.timeout(2500),
      })
    ).text();
    const url = /src: url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

function Mark({ cell = 14 }: { cell?: number }) {
  const colors = [C.fg, C.fg, C.line, C.fg, C.accent, C.fg, C.fg, C.fg, C.fg];
  return (
    <div style={{ display: "flex", flexWrap: "wrap", width: cell * 3 + 8, gap: 4 }}>
      {colors.map((c, i) => (
        <div key={i} style={{ width: cell, height: cell, borderRadius: 2, background: c }} />
      ))}
    </div>
  );
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [got, serif, sans] = await Promise.all([
    fetchPublication(slug),
    googleFont("Newsreader:opsz@72"),
    googleFont("Geist:wght@400"),
  ]);
  // Both or neither: passing fonts replaces ImageResponse's bundled Geist.
  const fonts =
    serif && sans
      ? [
          { name: "Newsreader", data: serif, weight: 400 as const, style: "normal" as const },
          { name: "Geist", data: sans, weight: 400 as const, style: "normal" as const },
        ]
      : undefined;
  const family = fonts ? "Newsreader" : "Geist";

  let question = "";
  let verdict = "Benchmark not found.";
  let tone = C.fg;
  let setups: string[] = [];
  let facts = "";
  let signed = false;
  if (got.kind === "found" && got.data.status === "live") {
    const p = got.data.signed.payload;
    question = questionTitle(p.title);
    verdict = heroSentence(p.badge);
    tone = p.badge.verdict === "better" ? C.pass : p.badge.verdict === "worse" ? C.fail : C.fg;
    setups = setupNames(p);
    facts = trialLine(p);
    signed = got.data.verification.valid;
  } else if (got.kind === "found") {
    verdict = "This benchmark was withdrawn.";
  }
  const vsize = verdict.length > 70 ? 64 : verdict.length > 44 ? 76 : 92;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: C.bg,
        color: C.fg,
        padding: "56px 72px",
        fontFamily: "Geist",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Mark />
          <div style={{ fontSize: 30, letterSpacing: -0.5 }}>Anybench</div>
        </div>
        {signed ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 22,
              color: C.pass,
              border: `1.5px solid ${C.line}`,
              borderRadius: 8,
              padding: "8px 16px",
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                background: C.pass,
                display: "flex",
              }}
            />
            Signed result
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", fontSize: 26, color: C.muted, marginTop: 44, maxWidth: 980 }}>
        {question}
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 18,
          fontFamily: family,
          fontSize: vsize,
          lineHeight: 1.04,
          letterSpacing: -2.4,
          maxWidth: 1040,
          color: C.fg,
          borderBottom: tone === C.fg ? "none" : `5px solid ${tone}`,
          paddingBottom: tone === C.fg ? 0 : 6,
        }}
      >
        {verdict}
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {setups.map((s) => (
            <div
              key={s}
              style={{
                display: "flex",
                fontSize: 21,
                padding: "6px 14px",
                border: `1.5px solid ${C.line}`,
                borderRadius: 6,
                color: s.endsWith("(baseline)") ? C.muted : C.fg,
              }}
            >
              {s}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", fontSize: 20, color: C.dim }}>{facts}</div>
      </div>
    </div>,
    { ...size, ...(fonts ? { fonts } : {}) },
  );
}
