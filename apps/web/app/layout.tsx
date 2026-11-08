import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { Footer } from "@/components/site/Footer";
import { Header } from "@/components/site/Header";
import "./globals.css";

// Newsreader for display (editorial serif, regular weight), Geist for text, Geist Mono for
// every number and label: the same family as our compute sponsor Naïve (usenaive.ai).
const display = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-display",
  display: "swap",
});
const body = Geist({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});
const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_ANYBENCH_WEB_URL || "https://anybench.jaxonp.com"),
  title: { default: "Anybench — The eval factory", template: "%s · Anybench" },
  description:
    "The eval factory. Turn any project into a benchmark: agents write the eval kit, fresh computers run it, and the report says whether it's better and why.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f1ea" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0c09" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
