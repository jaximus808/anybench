import { RunIdSchema } from "@anybench/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LiveRunPage } from "../../../components/live/LiveRunPage";

// The live run page (plan.md section 6). Run ids are UUIDs; anything else is a 404 before we
// call the API. A well-formed id the API doesn't know shows the page's own error state.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Live run", robots: { index: false } };

type Props = { params: Promise<{ id: string }> };

export default async function RunPage({ params }: Props) {
  const parsed = RunIdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  return (
    <div className="instrument" style={{ background: "var(--bg)", minHeight: "100%" }}>
      <LiveRunPage runId={parsed.data} />
    </div>
  );
}
