import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import AupPage from "../app/(legal)/aup/page";
import PrivacyPage from "../app/(legal)/privacy/page";
import RefundsPage from "../app/(legal)/refunds/page";
import TermsPage from "../app/(legal)/terms/page";
import { DRAFT_NOTICE } from "../components/docs/Notices";
import { LEGAL_LINKS } from "../components/site/nav";

afterEach(cleanup);

const PAGES: readonly {
  path: string;
  title: string;
  Page: () => ReactElement;
  mustSay: RegExp[];
}[] = [
  {
    path: "/terms",
    title: "Terms of service",
    Page: TermsPage,
    mustSay: [
      /isolated computers created for your eval and destroyed when your trials finish/,
      /Runs that fail because of us are never billed/,
      /never show it back/,
      /unpublish/i,
    ],
  },
  {
    path: "/privacy",
    title: "Privacy policy",
    Page: PrivacyPage,
    mustSay: [
      /90 days/,
      /1 year for paid runs, 30 days for free runs/,
      /Transcripts are never public/,
      /isolated computers created for your eval and destroyed when your trials finish/,
      /unsubscribe/,
      /AES-256-GCM/,
    ],
  },
  {
    path: "/refunds",
    title: "Refunds and billing",
    Page: RefundsPage,
    mustSay: [
      /never billed/,
      /\$2 per benchmark run/,
      /cost plus 50%/,
      /\$50/,
      /Stripe/,
      /monthly/i,
      /dispute/,
      /Credit granted/,
    ],
  },
  {
    path: "/aup",
    title: "Acceptable use policy",
    Page: AupPage,
    mustSay: [
      /Cryptocurrency mining/,
      /scanning anyone else/i,
      /Malware/,
      /Getting around limits/,
      /Illegal content/,
    ],
  },
];

describe("legal pages (TDM-106)", () => {
  for (const { path, title, Page, mustSay } of PAGES) {
    describe(path, () => {
      it("renders its title with the draft notice above it", () => {
        const { container } = render(<Page />);
        const h1 = screen.getByRole("heading", { level: 1, name: title });
        const note = screen.getByRole("note", { name: "Draft notice" });
        expect(note.textContent).toContain(DRAFT_NOTICE);
        // The banner comes before the title, so nobody reads the page without seeing it.
        expect(note.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(container.querySelector("article")?.firstElementChild).toBe(note);
      });

      it("says how Anybench actually works", () => {
        const { container } = render(<Page />);
        for (const re of mustSay) expect(container.textContent).toMatch(re);
      });

      it("links every legal page, marks this one current, and gives the contact email", () => {
        render(<Page />);
        const nav = screen.getByRole("navigation", { name: "Legal pages" });
        const links = within(nav).getAllByRole("link");
        expect(links.map((a) => a.getAttribute("href"))).toEqual(LEGAL_LINKS.map((l) => l.href));
        const current = links.filter((a) => a.getAttribute("aria-current") === "page");
        expect(current.map((a) => a.getAttribute("href"))).toEqual([path]);
        expect(
          screen.getAllByRole("link", { name: "jaxonp808@gmail.com" })[0]?.getAttribute("href"),
        ).toBe("mailto:jaxonp808@gmail.com");
      });

      it("leaves the entity and address as marked placeholders instead of guessing", () => {
        const { container } = render(<Page />);
        const text = container.textContent ?? "";
        expect(text).toContain("[Placeholder: company postal address]");
        expect(text).not.toMatch(/\b(LLC|Inc\.|Ltd\.?|GmbH|Corp\.|Delaware)\b/);
      });
    });
  }

  it("terms leave the legal entity and jurisdiction as placeholders", () => {
    const { container } = render(<TermsPage />);
    expect(container.textContent).toContain("[Placeholder: company legal name and entity type]");
    expect(container.textContent).toContain("[Placeholder: jurisdiction]");
  });

  it("refunds bill each run outcome by the billing rules", () => {
    render(<RefundsPage />);
    const table = screen.getByRole("table", { name: "Billing by run outcome" });
    const rows = Object.fromEntries(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => {
          const cells = [...r.children].map((c) => c.textContent?.replace(/\s+/g, " ").trim());
          return [cells[0], cells.slice(1)];
        }),
    );
    const row = (start: string) => Object.entries(rows).find(([k]) => k?.startsWith(start))?.[1];
    expect(row("Delivered")).toEqual(["Billed", "Billed"]);
    expect(row("Failed because of the subject")).toEqual(["Billed", "Billed"]);
    expect(row("Failed because of us")).toEqual(["Not billed", "Not billed"]);
    expect(row("You cancelled")).toEqual(["Not billed", "Billed for the time used"]);
    expect(row("We cancelled")).toEqual(["Not billed", "Not billed"]);
  });

  it("caps stop new trials but running trials are billed", () => {
    const { container } = render(<RefundsPage />);
    expect(container.textContent).toMatch(
      /No new trials start once a run reaches its cap; trials\s+already running finish and are billed/,
    );
    expect(container.textContent).not.toMatch(/Anything past your cap/);
  });

  it("no legal page promises per-trial computers or a scoring computer that never ran your code", () => {
    for (const { Page } of PAGES) {
      const { container } = render(<Page />);
      expect(container.textContent).not.toMatch(
        /its own (isolated )?(cloud )?computer|never ran your code/,
      );
      cleanup();
    }
  });
});
