import type { Metadata } from "next";
import { PricingPage } from "../../../components/marketing/PricingPage";
import { fetchFreePool, fetchPublicPricing } from "../../../lib/pricing/fetch";

// TDM-226: rendered per request from the API's public billing reads (each cached for 60 s), so
// the rates, the worked examples and the free-run status are always the deployed config's own.
export const dynamic = "force-dynamic";

const DESCRIPTION =
  "Your first Anybench benchmark is free, on your own model key with no card. Then a run fee, computer time at cost plus a markup, and model tokens only if they are ours.";

export const metadata: Metadata = {
  title: "Pricing",
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    type: "website",
    url: "/pricing",
    title: "Anybench pricing",
    description: DESCRIPTION,
  },
};

export default async function PricingRoute() {
  const [pricing, pool] = await Promise.all([fetchPublicPricing(), fetchFreePool()]);
  return <PricingPage pricing={pricing} pool={pool} />;
}
