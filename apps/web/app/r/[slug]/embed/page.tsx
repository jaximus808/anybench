import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmbedCard } from "../../../../components/publish/EmbedCard";
import { fetchPublication } from "../../../../lib/publish/fetch";

// /r/<slug>/embed (E12 12.5): a compact card for an iframe (?theme=light|dark, default follows
// the viewer's system). The site header and footer are hidden on this route.
export const revalidate = 60;
export const metadata: Metadata = { title: "Benchmark card", robots: { index: false } };

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ theme?: string }>;
};

export default async function EmbedPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const t = (await searchParams).theme;
  const theme = t === "light" || t === "dark" ? t : "auto";
  const got = await fetchPublication(slug);
  if (got.kind === "missing") notFound();
  if (got.kind === "error") throw new Error(`Couldn't load this benchmark: ${got.message}.`);
  return <EmbedCard data={got.data} theme={theme} />;
}
