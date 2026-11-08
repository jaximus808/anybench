// Publish worktree: the public page (/r/<slug>), the badge SVG, the embed card, oEmbed URL
// parsing and the owner's share panel, from the Tandem-shaped fixture.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createApiClient, type PublicationSummary } from "@anybench/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedCard } from "../components/publish/EmbedCard";
import { PublicReport, WithdrawnNotice } from "../components/publish/PublicReport";
import { SharePanel } from "../components/publish/SharePanel";
import {
  badgeMarkdown,
  badgeSvg,
  heroSentence,
  slugFromUrl,
  xIntentUrl,
} from "../lib/publish/view";
import { PUB_RUN_ID, PUB_SLUG, publicationFixture } from "./fixtures/publication";

afterEach(cleanup);
const ORIGIN = "https://anybench.jaxonp.com";

describe("public page", () => {
  it("leads with an honest verdict, the scope and n, and never names a winner", () => {
    render(<PublicReport data={publicationFixture()} origin={ORIGIN} />);
    const hero = screen.getByTestId("public-verdict");
    expect(hero.textContent).toBe("No detectable difference between Tandem and Claude Code solo.");
    expect(hero.dataset.verdict).toBe("indistinguishable");
    expect(screen.getByTestId("public-scope").textContent).toContain(
      "On these 3 tasks, 11 graded trials across 5 setups.",
    );
    expect(screen.getByTestId("public-scope").textContent).toContain("doesn't generalise");
    // The run's own question may say "beat"; nothing we write does.
    const title = publicationFixture().signed.payload.title;
    const page = screen.getByTestId("public-report").textContent!.replace(title, "");
    expect(page).not.toMatch(/\bbeats?\b|\bwinner\b/i);
    expect(page).not.toContain("better than");
  });

  it("shows the disclosure, setups with versions, per-task scope and how it was evaluated", () => {
    render(<PublicReport data={publicationFixture()} origin={ORIGIN} />);
    expect(screen.getByTestId("public-disclosure").textContent).toContain(
      "tokens: naive-proxy, effort: naive-min, thinking: off",
    );
    const page = screen.getByTestId("public-report").textContent!;
    expect(page).toContain("anthropic/claude-opus-5.5, Claude Code 2.1.319");
    expect(page).toContain("Tandem 0.2.0");
    expect(screen.getByTestId("public-per-task-scope").textContent).toContain("3 tasks:");
    const how = screen.getByTestId("public-how").textContent!;
    expect(how).toContain("16 hidden tests");
    expect(how).toContain("The reference solution passes the gate");
    expect(how).toContain("A do-nothing contender fails the gate");
    expect(how).toContain("Holm-corrected across 4 comparisons");
    expect(screen.getByTestId("public-trials").textContent).toContain(
      "2 failed on our infrastructure and were excluded from the result and not billed",
    );
    expect(screen.getByTestId("public-kit-hash").textContent).toMatch(/^3f2a9c41/);
    expect(screen.getByTestId("public-seal").textContent).toContain("Signature verified");
    expect(screen.getByRole("link", { name: "Run your own benchmark" }).getAttribute("href")).toBe(
      "/runs/new",
    );
  });

  it("says plainly when wall clock and cost were not recorded, and not when they were", () => {
    render(<PublicReport data={publicationFixture()} origin={ORIGIN} />);
    expect(screen.getByTestId("public-metrics-note").textContent).toContain(
      "did not record wall-clock time or cost",
    );
    cleanup();
    render(<PublicReport data={publicationFixture({ withMetrics: true })} origin={ORIGIN} />);
    expect(screen.getByTestId("public-metrics-note").textContent).toContain("did not record cost");
    expect(screen.getByTestId("public-report").textContent).toContain("1,260 s");
  });

  it("flags a signature that didn't verify, and renders a withdrawal", () => {
    render(<PublicReport data={publicationFixture({ valid: false })} origin={ORIGIN} />);
    expect(screen.getByTestId("public-seal").textContent).toContain("Signature not verified");
    cleanup();
    render(<WithdrawnNotice withdrawnAt="2026-11-09T10:00:00.000Z" />);
    expect(screen.getByTestId("public-withdrawn").textContent).toContain("withdrawn");
  });
});

describe("hero sentence", () => {
  const b = publicationFixture().signed.payload.badge;
  it("says better/worse only when the verdict called it", () => {
    expect(heroSentence({ ...b, verdict: "better", subject: "Tandem ×3" })).toBe(
      "Tandem ×3 did better than Claude Code solo on tests-pass.",
    );
    expect(heroSentence({ ...b, verdict: null })).toBe("Tandem: no verdict at this sample size.");
  });
});

describe("badge SVG", () => {
  it("is a two-part flat badge, escaped, with a tone per verdict", () => {
    const svg = badgeSvg({ message: 'A <b> & "c"', tone: "neutral" });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="\d+" height="20"/);
    expect(svg).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(svg).not.toContain("<b>");
    expect(badgeSvg({ message: "x", tone: "better" })).toContain("#1e7a43");
    expect(badgeSvg({ message: "x", tone: "neutral", theme: "dark" })).toContain("#353c2e");
  });

  it("snippets link the badge to the page", () => {
    expect(
      badgeMarkdown(PUB_SLUG, "Tandem vs Claude Code solo: no detectable difference", ORIGIN),
    ).toBe(
      `[![anybench: Tandem vs Claude Code solo: no detectable difference](${ORIGIN}/r/${PUB_SLUG}/badge.svg)](${ORIGIN}/r/${PUB_SLUG})`,
    );
  });
});

describe("embed and oEmbed", () => {
  it("the card carries the verdict, the primary requirement per setup and a link out", () => {
    render(<EmbedCard data={publicationFixture()} theme="dark" origin={ORIGIN} />);
    const card = screen.getByTestId("embed-card");
    expect(card.textContent).toContain(
      "No detectable difference between Tandem and Claude Code solo.",
    );
    expect(card.textContent).toContain("Tandem ×3100%");
    expect(screen.getByRole("link", { name: "Full report and method" }).getAttribute("href")).toBe(
      `${ORIGIN}/r/${PUB_SLUG}`,
    );
  });

  it("oEmbed only accepts this site's /r/<slug> links", () => {
    expect(slugFromUrl(`${ORIGIN}/r/${PUB_SLUG}`, ORIGIN)).toBe(PUB_SLUG);
    expect(slugFromUrl(`${ORIGIN}/r/${PUB_SLUG}/embed`, ORIGIN)).toBe(PUB_SLUG);
    expect(slugFromUrl(`https://evil.example/r/${PUB_SLUG}`, ORIGIN)).toBeNull();
    expect(slugFromUrl(`${ORIGIN}/r/short`, ORIGIN)).toBeNull();
  });
});

describe("share panel", () => {
  const summary = (status: "live" | "withdrawn"): PublicationSummary => ({
    slug: PUB_SLUG,
    run_id: PUB_RUN_ID as PublicationSummary["run_id"],
    status,
    latest_version: 1,
    published_at: "2026-11-08T00:12:00.000Z",
    withdrawn_at: status === "withdrawn" ? "2026-11-08T01:00:00.000Z" : null,
    page_url: `${ORIGIN}/r/${PUB_SLUG}`,
    badge_url: `${ORIGIN}/r/${PUB_SLUG}/badge.svg`,
    embed_url: `${ORIGIN}/r/${PUB_SLUG}/embed`,
    badge: publicationFixture().signed.payload.badge,
    verdict: "x",
  });

  function fakeClient(initial: PublicationSummary | null) {
    let pub = initial;
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (u.pathname.endsWith("/publication/unpublish")) {
        pub = summary("withdrawn");
        return json({ publication: pub });
      }
      if (u.pathname.endsWith("/publication") && init?.method === "POST") {
        pub = summary("live");
        return json({ publication: pub }, 201);
      }
      return json({ publication: pub });
    });
    return { client: createApiClient("http://api.test", { kind: "session" }, { fetch }), calls };
  }

  it("publishes, then offers the link, badge, embed, X and unpublish", async () => {
    const { client, calls } = fakeClient(null);
    render(<SharePanel runId={PUB_RUN_ID} runState="delivered" client={client} />);
    const publish = await screen.findByTestId("share-publish");
    fireEvent.click(publish);
    await waitFor(() =>
      expect((screen.getByTestId("share-url") as HTMLInputElement).value).toBe(
        `${ORIGIN}/r/${PUB_SLUG}`,
      ),
    );
    expect(calls).toContain(`POST /runs/${PUB_RUN_ID}/publication`);
    const x = screen.getByTestId("share-x").getAttribute("href")!;
    expect(x).toMatch(/^https:\/\/x\.com\/intent\/post\?text=/);
    expect(decodeURIComponent(x)).toContain(
      "No detectable difference between Tandem and Claude Code solo (on these 3 tasks)",
    );
    fireEvent.click(screen.getByTestId("share-unpublish"));
    await screen.findByText(/Unpublished\. The page and badge now read/);
    expect(screen.getByTestId("share-publish").textContent).toBe("Publish again");
  });

  it("the X text keeps the scope", () => {
    const b = publicationFixture().signed.payload.badge;
    expect(decodeURIComponent(xIntentUrl(b, "https://x.y/r/a"))).toContain("(on these 3 tasks)");
  });
});
