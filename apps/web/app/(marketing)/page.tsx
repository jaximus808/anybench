import type { Metadata } from "next";
import { LandingPage } from "../../components/marketing/LandingPage";

const TITLE = "Anybench — The eval factory";
const DESCRIPTION =
  "Point Anybench at an agent, a harness or any other software. Agents generate an eval kit with a correctness gate for every number, cloud computers run it, and you get a verdict on each comparison and the reasons behind it.";

// The landing page is static: no API calls, no cookies, built once at deploy time.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Anybench",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function HomePage() {
  return <LandingPage />;
}
