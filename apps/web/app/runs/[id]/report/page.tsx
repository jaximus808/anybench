import { RunIdSchema } from "@anybench/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportPage } from "../../../../components/report/ReportPage";

// The run's report (TDM-103 [11.6]). Run ids are UUIDs; anything else is a 404 before the API.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Run report", robots: { index: false } };

type Props = { params: Promise<{ id: string }> };

export default async function RunReportPage({ params }: Props) {
  const parsed = RunIdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  return (
    <div className="instrument" style={{ background: "var(--bg)", minHeight: "100%" }}>
      <ReportPage runId={parsed.data} />
    </div>
  );
}
