// DEV ONLY: the public benchmark page (/r/<slug>) from the delivered-run fixture (01a1b9ee…), for
// design work and screenshots without the API. ?theme=light|dark forces a theme. The `.dev.tsx`
// extension keeps it out of production builds (lib/page-extensions.ts).
import type { Metadata } from "next";
import { PublicReport } from "../../../components/publish/PublicReport";
import { ForceTheme } from "./ForceTheme";
import { deliveredPublication } from "../../../test/fixtures/publication-delivered";

export const metadata: Metadata = { title: "Benchmark (preview)", robots: { index: false } };

type Props = { searchParams: Promise<{ theme?: string }> };

export default async function PublicationPreview({ searchParams }: Props) {
  const t = (await searchParams).theme;
  const theme = t === "light" || t === "dark" ? t : null;
  return (
    <>
      {theme ? <ForceTheme theme={theme} /> : null}
      <PublicReport data={deliveredPublication()} />
    </>
  );
}
