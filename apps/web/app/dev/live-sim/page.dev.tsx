// DEV ONLY (TDM-198): the live run page driven by the deterministic simulator, so every phase can
// be watched in the browser without a real run. The `.dev.tsx` extension keeps it out of
// production builds (lib/page-extensions.ts).
import type { Metadata } from "next";
import { LiveSim } from "./LiveSim";

export const metadata: Metadata = { title: "Live run (simulated)", robots: { index: false } };

export default function LiveSimPage() {
  return (
    <div className="instrument" style={{ background: "var(--bg)", minHeight: "100%" }}>
      <LiveSim />
    </div>
  );
}
