import { badgeSvg, badgeTone, type BadgeTone } from "../../../../lib/publish/view";
import { fetchPublication } from "../../../../lib/publish/fetch";

// GET /r/<slug>/badge.svg[?theme=dark] (E12 12.4): a shields.io-style badge. The message comes
// from the signed snapshot's badge (verdict words only). Withdrawn reads "withdrawn".
export const revalidate = 300;

const CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

function svg(body: string, status = 200, cache = CACHE): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const theme = new URL(req.url).searchParams.get("theme") === "dark" ? "dark" : "light";
  const got = await fetchPublication(slug);
  const one = (message: string, tone: BadgeTone, status = 200, cache = CACHE) =>
    svg(badgeSvg({ message, tone, theme }), status, cache);
  if (got.kind === "missing") return one("not found", "withdrawn", 404, "public, max-age=60");
  if (got.kind === "error") return one("unavailable", "withdrawn", 503, "no-store");
  if (got.data.status === "withdrawn")
    return one("withdrawn", "withdrawn", 200, "public, max-age=60");
  const b = got.data.signed.payload.badge;
  // A called verdict keeps its scope ("on these 3 tasks"); "no detectable difference" needs none.
  const message =
    b.scope && b.verdict !== "indistinguishable" ? `${b.message} ${b.scope}` : b.message;
  return one(message, badgeTone(b.verdict));
}
