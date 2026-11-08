import { ApiClientError, apiRoutes, createApiClient, PublishSlugSchema } from "@anybench/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BenchmarkPage, type BenchPageData } from "../../../../components/bench/BenchmarkPage";
import { splitAnswer } from "../../../../components/report/model";
import { upstreamApiUrl } from "../../../../lib/api-upstream";

// The public benchmark page (TDM-204): what a shared Anybench link opens. Server-rendered from
// GET /public/benchmarks/:owner/:slug (?version=), no session. A withdrawn benchmark renders with
// a "withdrawn" notice (it never silently disappears); an unknown one is a 404. The OG and Twitter
// images live beside this file (TDM-205).
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ owner: string; slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

type Loaded =
  { kind: "ok"; data: BenchPageData } | { kind: "missing" } | { kind: "error"; message: string };

async function load(owner: string, slug: string, version?: string): Promise<Loaded> {
  if (!PublishSlugSchema.safeParse(slug).success || owner.length > 100) return { kind: "missing" };
  const v = version && /^\d+$/.test(version) ? Number(version) : undefined;
  try {
    const data = await createApiClient(upstreamApiUrl(), { kind: "none" }).call(
      apiRoutes.publish.page,
      { params: { owner, slug }, ...(v ? { query: { version: v } } : {}) },
    );
    return { kind: "ok", data };
  } catch (e) {
    if (e instanceof ApiClientError && e.status === 404) return { kind: "missing" };
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { owner, slug } = await params;
  const r = await load(owner, slug, (await searchParams).version);
  if (r.kind !== "ok") return { title: "Benchmark", robots: { index: false } };
  const b = r.data.benchmark;
  const description = splitAnswer(r.data.version.report.answer).headline;
  return {
    title: b.title,
    description,
    alternates: { canonical: b.page_url },
    robots: { index: b.visibility === "public" },
    openGraph: { title: b.title, description, url: b.page_url, type: "article" },
    twitter: { card: "summary_large_image", title: b.title, description },
  };
}

export default async function PublicBenchmark({ params, searchParams }: Props) {
  const { owner, slug } = await params;
  const r = await load(owner, slug, (await searchParams).version);
  if (r.kind === "missing") notFound();
  return (
    <div className="instrument" style={{ background: "var(--bg)", minHeight: "100%" }}>
      {r.kind === "ok" ? (
        <BenchmarkPage data={r.data} />
      ) : (
        <p
          role="alert"
          style={{ padding: "4rem 1rem", textAlign: "center", color: "var(--muted)" }}
        >
          Couldn’t load this benchmark right now. {r.message}
        </p>
      )}
    </div>
  );
}
