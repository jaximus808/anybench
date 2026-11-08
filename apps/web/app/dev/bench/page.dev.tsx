// DEV ONLY (TDM-204): the public benchmark page from fixtures, before the publish API exists.
// ?case=failed adds a setup whose gate never passed; ?case=withdrawn shows the withdrawn notice.
// The `.dev.tsx` extension keeps it out of production builds (lib/page-extensions.ts).
import type { Metadata } from "next";
import { BenchmarkPage } from "../../../components/bench/BenchmarkPage";
import {
  benchPage,
  benchReport,
  benchReportWithFailedGate,
} from "../../../test/fixtures/tdm204-published";

export const metadata: Metadata = { title: "Benchmark (preview)", robots: { index: false } };

type Props = { searchParams: Promise<{ case?: string }> };

export default async function BenchPreview({ searchParams }: Props) {
  const c = (await searchParams).case;
  const data =
    c === "failed"
      ? benchPage(benchReportWithFailedGate())
      : c === "withdrawn"
        ? benchPage(benchReport(), { visibility: "withdrawn" })
        : benchPage();
  return (
    <div className="instrument" style={{ background: "var(--bg)", minHeight: "100%" }}>
      <BenchmarkPage data={data} />
    </div>
  );
}
