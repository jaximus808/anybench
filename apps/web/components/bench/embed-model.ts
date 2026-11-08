// The embed widget's data (TDM-205): GET /public/embed/:slug (core publish.embed), loaded on the
// server and shaped for EmbedView. Rows with a gated score are ranked by it; a null score means
// the setup has no gated score, so it is listed after them and never ranked (design system
// principle 3: no number without a gate).
import {
  ApiClientError,
  apiRoutes,
  EMBED_THEMES,
  PublishSlugSchema,
  type ApiClient,
  type RouteOutput,
} from "@anybench/core";

export type EmbedPayload = RouteOutput<typeof apiRoutes.publish.embed>;
export type EmbedTheme = (typeof EMBED_THEMES)[number];

export type EmbedState =
  | { kind: "ok"; embed: EmbedPayload }
  | { kind: "missing"; slug: string }
  | { kind: "error"; slug: string; message: string };

/** The message the widget posts to its parent page whenever its height changes. */
export const EMBED_HEIGHT_MESSAGE = "anybench:height";

export type EmbedHeightMessage = {
  type: typeof EMBED_HEIGHT_MESSAGE;
  slug: string;
  height: number;
};

/** `?theme=` from the iframe URL; anything unknown is `auto`. */
export function parseTheme(raw: string | string[] | undefined): EmbedTheme {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (EMBED_THEMES as readonly string[]).includes(v ?? "") ? (v as EmbedTheme) : "auto";
}

/** `?version=` from the iframe URL: a positive integer, or the latest version. */
export function parseVersion(raw: string | string[] | undefined): number | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !/^[1-9]\d{0,8}$/.test(v)) return undefined;
  return Number(v);
}

export async function loadEmbed(
  client: ApiClient,
  slug: string,
  opts: { theme: EmbedTheme; version?: number | undefined },
): Promise<EmbedState> {
  const parsed = PublishSlugSchema.safeParse(slug);
  if (!parsed.success) return { kind: "missing", slug };
  try {
    const embed = await client.call(apiRoutes.publish.embed, {
      params: { slug: parsed.data },
      query: { theme: opts.theme, ...(opts.version ? { version: opts.version } : {}) },
    });
    return { kind: "ok", embed };
  } catch (e) {
    if (e instanceof ApiClientError && e.status === 404) return { kind: "missing", slug };
    return {
      kind: "error",
      slug,
      message: e instanceof ApiClientError ? e.message : "the results could not be loaded",
    };
  }
}

export type EmbedRow = {
  name: string;
  role: string;
  baseline: boolean;
  /** 0–100, or null: no gated score. */
  score: number | null;
  /** 1-based rank among scored rows; null when unscored (never ranked). */
  rank: number | null;
};

/** Scored rows by score (highest first, ties keep their order), then the unscored rows. */
export function embedRows(rows: EmbedPayload["rows"]): EmbedRow[] {
  const scored = rows
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.score !== null)
    .sort((a, b) => (b.r.score as number) - (a.r.score as number) || a.i - b.i);
  const out: EmbedRow[] = scored.map(({ r }, i) => ({
    name: r.name,
    role: r.role,
    baseline: r.role === "baseline",
    score: r.score,
    rank: i + 1,
  }));
  for (const r of rows)
    if (r.score === null)
      out.push({
        name: r.name,
        role: r.role,
        baseline: r.role === "baseline",
        score: null,
        rank: null,
      });
  return out;
}

/** Scores in mono: one decimal at most, no trailing zero. */
export function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1).replace(/\.0$/, "");
}
