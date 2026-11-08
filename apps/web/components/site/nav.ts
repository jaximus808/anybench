// Site navigation links, shared by the header, the mobile menu and the footer (TDM-98).
export interface NavLink {
  readonly href: string;
  readonly label: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/runs/demo", label: "Live demo" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
];

export const SIGN_IN_LINK: NavLink = { href: "/signin", label: "Sign in" };

export const LEGAL_LINKS: readonly NavLink[] = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/refunds", label: "Refunds" },
  { href: "/aup", label: "Acceptable use" },
];
