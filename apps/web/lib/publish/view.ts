// Publications (E12): pure view helpers shared by the public page (/r/<slug>), the badge, the OG
// image, the embed card, oEmbed and the owner's share panel. No React, no fetch.
//
// Honest wording (plan.md 17.2 rule 10): the hero sentence says "better"/"worse" only when the
// published badge verdict (derived server-side from the decision rule) says so; otherwise "no
// detectable difference". The task scope ("on these 3 tasks") is never dropped.
import {
  PublicationSlugSchema,
  type Publication,
  type PublicationBadge,
  type Verdict,
} from "@anybench/core";

export const DEFAULT_WEB_URL = "https://anybench.jaxonp.com";

/** The web app's public origin (no trailing slash). */
export function webOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return (env.NEXT_PUBLIC_ANYBENCH_WEB_URL || DEFAULT_WEB_URL).replace(/\/+$/, "");
}

export function publicationUrls(slug: string, origin: string = webOrigin()) {
  const page = `${origin}/r/${slug}`;
  return {
    page,
    badge: `${page}/badge.svg`,
    badgeDark: `${page}/badge.svg?theme=dark`,
    embed: `${page}/embed`,
    og: `${page}/opengraph-image`,
    attestation: `${origin}/api/public/r/${slug}/attestation.json`,
    keys: `${origin}/api/.well-known/anybench-keys.json`,
    oembed: `${origin}/oembed?url=${encodeURIComponent(page)}`,
  };
}

/** "C · Tandem ×3" → "Tandem ×3". */
export function shortName(name: string): string {
  return name.replace(/^[A-Z]\s*·\s*/, "").trim() || name;
}

/** The hero sentence, from the badge verdict only. */
export function heroSentence(b: PublicationBadge): string {
  if (b.verdict === null || b.baseline === null)
    return `${b.subject}: no verdict at this sample size.`;
  if (b.verdict === "indistinguishable")
    return b.message.includes(": mixed")
      ? `${b.subject} vs ${b.baseline}: mixed results.`
      : `No detectable difference between ${b.subject} and ${b.baseline}.`;
  const on = b.requirement ? ` on ${b.requirement}` : "";
  return `${b.subject} did ${b.verdict === "better" ? "better" : "worse"} than ${b.baseline}${on}.`;
}

export type BadgeTone = "neutral" | "better" | "worse" | "withdrawn";

export function badgeTone(v: Verdict | null): BadgeTone {
  return v === "better" ? "better" : v === "worse" ? "worse" : "neutral";
}

/** "On these 3 tasks, 11 graded trials across 5 setups" (scope first when the claim is scoped). */
export function trialLine(p: Publication): string {
  const t = p.evaluation.trials;
  const n = p.evaluation.setups.length;
  const tasks = p.evaluation.tasks.length;
  const scope = p.badge.scope
    ? `${p.badge.scope[0]!.toUpperCase()}${p.badge.scope.slice(1)}, `
    : `On ${tasks} task${tasks === 1 ? "" : "s"}, `;
  return `${scope}${t.graded} graded trial${t.graded === 1 ? "" : "s"} across ${n} setups`;
}

/** Setup names for the OG image and the embed ("Claude Code solo (baseline)"). */
export function setupNames(p: Publication): string[] {
  return p.evaluation.setups.map(
    (s) => `${shortName(s.name)}${s.role === "baseline" ? " (baseline)" : ""}`,
  );
}

// ── Badge SVG (shields.io flat style) ────────────────────────────────────────────────────────

/** Approximate Verdana 11px advance widths: enough to size the boxes; textLength makes it exact. */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if ("iljI.,:;'|!·".includes(ch)) w += 3.6;
    else if (ch === " ") w += 3.9;
    else if ("mwMW×".includes(ch)) w += 9.6;
    else if (/[A-Z]/.test(ch)) w += 7.5;
    else if (/[0-9]/.test(ch)) w += 7;
    else if ("frt()[]".includes(ch)) w += 4.6;
    else w += 6.6;
  }
  return Math.ceil(w);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BADGE_COLORS = {
  light: {
    label: "#16170f",
    labelText: "#f3f1ea",
    markDim: "#5d6052",
    neutral: "#5d6052",
    better: "#1e7a43",
    worse: "#c2321f",
    withdrawn: "#8a8c7e",
    text: "#ffffff",
  },
  dark: {
    label: "#353c2e",
    labelText: "#eceee4",
    markDim: "#5e6557",
    neutral: "#5e6557",
    better: "#2f8f52",
    worse: "#c2321f",
    withdrawn: "#4a5143",
    text: "#ffffff",
  },
} as const;

/**
 * `anybench | <message>`: a 20px flat badge with the 3×3 trial-grid mark. `theme` picks colours
 * for light or dark backgrounds. The message is plain text (escaped).
 */
export function badgeSvg(opts: {
  message: string;
  tone: BadgeTone;
  theme?: "light" | "dark";
  title?: string;
}): string {
  const c = BADGE_COLORS[opts.theme ?? "light"];
  const label = "anybench";
  const mark = 14;
  const lw = 6 + mark + 4 + textWidth(label) + 7;
  const mw = 7 + textWidth(opts.message) + 7;
  const w = lw + mw;
  const fill = c[opts.tone];
  const title = esc(opts.title ?? `anybench: ${opts.message}`);
  // The mark (components/site/Mark.tsx): 7 passed, 1 failed its gate (dim), 1 running (orange).
  const cells: string[] = [];
  for (let i = 0; i < 9; i++) {
    const x = 6 + (i % 3) * 4.5;
    const y = 3 + Math.floor(i / 3) * 4.5 + 0.5;
    const color = i === 2 ? c.markDim : i === 4 ? "#ff7a1a" : c.labelText;
    cells.push(`<rect x="${x}" y="${y}" width="3.5" height="3.5" rx="0.6" fill="${color}"/>`);
  }
  const lx = 6 + mark + 4;
  const ltw = textWidth(label);
  const mtw = textWidth(opts.message);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}"><title>${title}</title><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="${c.label}"/><rect x="${lw}" width="${mw}" height="20" fill="${fill}"/></g>${cells.join("")}<g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-rendering="geometricPrecision"><text x="${lx}" y="14" fill="${c.labelText}" textLength="${ltw}" lengthAdjust="spacingAndGlyphs">${label}</text><text x="${lw + 7}" y="14" fill="${c.text}" textLength="${mtw}" lengthAdjust="spacingAndGlyphs">${esc(opts.message)}</text></g></svg>`;
}

// ── Snippets ─────────────────────────────────────────────────────────────────────────────────

export function badgeMarkdown(slug: string, message: string, origin?: string): string {
  const u = publicationUrls(slug, origin);
  return `[![anybench: ${message.replace(/[[\]]/g, "")}](${u.badge})](${u.page})`;
}

export function badgeHtml(slug: string, message: string, origin?: string): string {
  const u = publicationUrls(slug, origin);
  const alt = esc(`anybench: ${message}`);
  return `<a href="${u.page}"><picture><source media="(prefers-color-scheme: dark)" srcset="${u.badgeDark}"><img src="${u.badge}" alt="${alt}"></picture></a>`;
}

export const EMBED_SIZE = { width: 560, height: 272 } as const;

export function embedHtml(slug: string, title: string, origin?: string): string {
  const u = publicationUrls(slug, origin);
  return `<iframe src="${u.embed}" title="${esc(`Anybench: ${title}`)}" width="${EMBED_SIZE.width}" height="${EMBED_SIZE.height}" style="border:0;max-width:100%" loading="lazy"></iframe>`;
}

/** A prefilled X post: the honest one-liner, the scope, and the link. */
export function xIntentUrl(b: PublicationBadge, pageUrl: string): string {
  const scope = b.scope ? ` (${b.scope})` : "";
  const text = `${heroSentence(b).replace(/\.$/, "")}${scope}. Benchmarked and signed on Anybench:`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`;
}

/** The slug of a /r/<slug> or /r/<slug>/embed URL on this site, or null. */
export function slugFromUrl(raw: string, origin: string = webOrigin()): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.host !== new URL(origin).host) return null;
  const m = /^\/r\/([^/]+)(?:\/embed)?\/?$/.exec(u.pathname);
  return m && PublicationSlugSchema.safeParse(m[1]).success ? m[1]! : null;
}
