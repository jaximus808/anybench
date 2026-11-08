import type { Metadata } from "next";
import { LiveRunPage } from "../../../components/live/LiveRunPage";

// The live run page (plan.md section 6). "demo" replays a simulated run through the same page.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return id === "demo"
    ? {
        title: "Live demo run",
        description:
          "Watch a simulated Anybench run: every trial, every agent and every event on one page.",
      }
    : { title: "Live run", robots: { index: false } };
}

export default async function RunPage({ params }: Props) {
  const { id } = await params;
  return (
    <div className="instrument" style={{ background: "var(--bg)", minHeight: "100%" }}>
      <LiveRunPage runId={id} />
    </div>
  );
}
