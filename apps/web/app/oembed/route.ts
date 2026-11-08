import { fetchPublication } from "../../lib/publish/fetch";
import {
  EMBED_SIZE,
  embedHtml,
  heroSentence,
  publicationUrls,
  slugFromUrl,
  webOrigin,
} from "../../lib/publish/view";

// GET /oembed?url=<web>/r/<slug>[/embed] (E12 12.5): oEmbed 1.0 `rich` so Notion, Ghost, Medium
// and others unfurl a published benchmark into the embed card.
export const revalidate = 300;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=300, s-maxage=3600" : "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const format = q.get("format") ?? "json";
  if (format !== "json") return json({ error: "only format=json is supported" }, 501);
  const slug = slugFromUrl(q.get("url") ?? "");
  if (!slug) return json({ error: "url must be an Anybench /r/<slug> link" }, 404);
  const got = await fetchPublication(slug);
  if (got.kind !== "found" || got.data.status !== "live")
    return json({ error: "no live publication at this url" }, 404);
  const p = got.data.signed.payload;
  const maxw = Number(q.get("maxwidth")) || Infinity;
  const width = Math.min(EMBED_SIZE.width, Math.max(280, maxw));
  const title = heroSentence(p.badge);
  return json({
    type: "rich",
    version: "1.0",
    title,
    provider_name: "Anybench",
    provider_url: webOrigin(),
    html: embedHtml(slug, title).replace(`width="${EMBED_SIZE.width}"`, `width="${width}"`),
    width,
    height: EMBED_SIZE.height,
    thumbnail_url: publicationUrls(slug).og,
    thumbnail_width: 1200,
    thumbnail_height: 630,
  });
}
