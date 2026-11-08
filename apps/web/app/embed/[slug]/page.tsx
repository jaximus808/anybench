import { createApiClient } from "@anybench/core";
import type { Metadata } from "next";
import { EmbedView } from "../../../components/bench/EmbedView";
import { loadEmbed, parseTheme, parseVersion } from "../../../components/bench/embed-model";
import { upstreamApiUrl } from "../../../lib/api-upstream";

// The iframe widget (TDM-205): /embed/<slug>?theme=light|dark|auto&version=<n>. Rendered on the
// server from GET /public/embed/:slug (public, no session), with no site chrome and no
// scrolling; EmbedFrame posts its height to the parent page. Each request reads the latest
// (or pinned) version, so a withdrawn benchmark reads "withdrawn" on every page that embeds it.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Embedded benchmark",
  robots: { index: false, follow: false },
};

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function EmbedPage({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const theme = parseTheme(query.theme);
  const client = createApiClient(upstreamApiUrl(), { kind: "none" });
  const state = await loadEmbed(client, slug, { theme, version: parseVersion(query.version) });
  return <EmbedView state={state} theme={theme} />;
}
