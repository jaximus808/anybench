// Docs routes (TDM-106 [11.9]). The docs left nav renders DOCS_NAV, so a new page is added here
// once. Legal routes come from LEGAL_LINKS in components/site/nav.ts.

export interface SiteLink {
  href: string;
  label: string;
}

export const DOCS_NAV: readonly SiteLink[] = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/kits", label: "How a kit works" },
  { href: "/docs/proof-checks", label: "Proof checks" },
  { href: "/docs/cli", label: "CLI" },
  { href: "/docs/mcp", label: "MCP tools" },
  { href: "/docs/badges", label: "Badges and embeds" },
];

export const CONTACT_EMAIL = "jaxonp808@gmail.com";
