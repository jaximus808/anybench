import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicReport, WithdrawnNotice } from "../../../components/publish/PublicReport";
import { fetchPublication } from "../../../lib/publish/fetch";
import { heroSentence, publicationUrls, setupNames } from "../../../lib/publish/view";
import { questionTitle } from "../../../lib/question-title";

// The public benchmark page (E12 12.3): no login, server-rendered from the signed snapshot.
// Unlisted: the unguessable slug is the permission, so search engines are asked not to index it.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

function versionOf(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const got = await fetchPublication(slug, { version: versionOf((await searchParams).version) });
  if (got.kind !== "found") return { title: "Benchmark", robots: { index: false } };
  const urls = publicationUrls(slug);
  if (got.data.status === "withdrawn")
    return { title: "Withdrawn benchmark", robots: { index: false } };
  const p = got.data.signed.payload;
  const title = heroSentence(p.badge).replace(/\.$/, "");
  const description = `${questionTitle(p.title)} ${p.badge.scope ? `${p.badge.scope}, ` : ""}${p.evaluation.trials.graded} graded trials. Setups: ${setupNames(p).join(", ")}. Signed by Anybench.`;
  return {
    title,
    description,
    robots: { index: false, follow: true },
    alternates: {
      canonical: urls.page,
      types: { "application/json+oembed": urls.oembed },
    },
    openGraph: { type: "article", title, description, url: urls.page, siteName: "Anybench" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicationPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const got = await fetchPublication(slug, { version: versionOf((await searchParams).version) });
  if (got.kind === "missing") notFound();
  if (got.kind === "error")
    throw new Error(`Couldn't load this benchmark: ${got.message}. Try again in a minute.`);
  if (got.data.status === "withdrawn")
    return <WithdrawnNotice withdrawnAt={got.data.withdrawn_at} />;
  return <PublicReport data={got.data} />;
}
