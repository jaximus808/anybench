import { act, cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmbedPage from "../app/embed/[slug]/page";
import BadgesDocsPage from "../app/docs/badges/page";
import { EmbedView } from "../components/bench/EmbedView";
import {
  embedRows,
  formatScore,
  loadEmbed,
  parseTheme,
  parseVersion,
  type EmbedState,
} from "../components/bench/embed-model";
import { createWebApiClient } from "../lib/api";
import { TDM205_PAGE_URL, TDM205_SLUG, tdm205Embed } from "./fixtures/tdm205-embed";

// TDM-205: the /embed/<slug> widget renders GET /public/embed/:slug in light and dark, shows
// "withdrawn", hatches (never ranks) a setup without a gated score, and posts its height to the
// parent page; public/embed.js turns data-anybench-embed divs into resized iframes.

const ok = (over: Parameters<typeof tdm205Embed>[0] = {}): EmbedState => ({
  kind: "ok",
  embed: tdm205Embed(over),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function root(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-anybench-embed-root]");
  if (!el) throw new Error("no embed root");
  return el;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("embed model", () => {
  it("ranks scored rows by score and lists unscored rows last, unranked", () => {
    const rows = embedRows(tdm205Embed().rows);
    expect(rows.map((r) => [r.name, r.rank, r.score])).toEqual([
      ["tandem", 1, 81.5],
      ["claude-code-solo", 2, 62],
      ["tandem-lite", null, null],
    ]);
    expect(rows[1]?.baseline).toBe(true);
    expect(formatScore(81.5)).toBe("81.5");
    expect(formatScore(62)).toBe("62");
  });

  it("reads ?theme= and ?version= defensively", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme(["dark", "light"])).toBe("dark");
    expect(parseTheme("neon")).toBe("auto");
    expect(parseTheme(undefined)).toBe("auto");
    expect(parseVersion("4")).toBe(4);
    expect(parseVersion("0")).toBeUndefined();
    expect(parseVersion("2abc")).toBeUndefined();
  });

  it("loads the embed payload; a 404 or a bad slug is missing", async () => {
    const calls: string[] = [];
    const client = createWebApiClient("https://api.test", {
      fetch: async (url) => {
        calls.push(url);
        return url.includes("gone-bench") ? json(404, {}) : json(200, tdm205Embed());
      },
    });
    const state = await loadEmbed(client, TDM205_SLUG, { theme: "light", version: 2 });
    expect(state.kind).toBe("ok");
    expect(calls[0]).toBe(`https://api.test/public/embed/${TDM205_SLUG}?theme=light&version=2`);
    expect(await loadEmbed(client, "gone-bench", { theme: "auto" })).toEqual({
      kind: "missing",
      slug: "gone-bench",
    });
    expect((await loadEmbed(client, "Not A Slug", { theme: "auto" })).kind).toBe("missing");
    expect(calls).toHaveLength(2);
    const down = createWebApiClient("https://api.test", { fetch: async () => json(500, {}) });
    expect((await loadEmbed(down, TDM205_SLUG, { theme: "auto" })).kind).toBe("error");
  });
});

describe("EmbedView", () => {
  it("renders the title, the answer, every setup and the link in light", () => {
    const { container } = render(<EmbedView state={ok()} theme="light" />);
    const el = root(container);
    expect(el.dataset.theme).toBe("light");
    expect(el.className).not.toContain("instrument");

    const title = screen.getByRole("link", { name: "Tandem vs Claude Code solo" });
    expect(title.getAttribute("href")).toBe(TDM205_PAGE_URL);
    expect(title.getAttribute("target")).toBe("_blank");
    expect(title.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/finishes 41 s faster/)).toBeTruthy();

    const chart = screen.getByRole("list", { name: /Score per setup/ });
    const items = within(chart).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^1tandemsubject81\.5$/),
      expect.stringMatching(/^2claude-code-solobaseline62$/),
      expect.stringMatching(/^–tandem-litesubjectno gated score$/),
    ]);
    expect(items[1]?.hasAttribute("data-baseline")).toBe(true);
    expect(items[2]?.hasAttribute("data-unscored")).toBe(true);
    // The unscored setup is hatched, not given a bar length.
    expect(items[2]?.querySelector("[style*='--w']")).toBeNull();
    expect(items[0]?.querySelector("[style*='--w']")?.getAttribute("style")).toContain("81.5%");
    // The baseline is marked on the other setups' tracks.
    expect(items[0]?.querySelector("[style*='--x']")?.getAttribute("style")).toContain("62%");

    expect(container.textContent).toContain("verified by Anybench · v3");
    expect(container.textContent).toContain("hatched: no gated score, not ranked");
    const more = screen.getByRole("link", { name: /Full benchmark/ });
    expect(more.getAttribute("href")).toBe(TDM205_PAGE_URL);
    expect(more.getAttribute("target")).toBe("_blank");
  });

  it("renders in dark with the instrument palette, and auto follows the system", () => {
    const { container, unmount } = render(<EmbedView state={ok()} theme="dark" />);
    expect(root(container).dataset.theme).toBe("dark");
    expect(root(container).className).toContain("instrument");
    unmount();
    const auto = render(<EmbedView state={ok()} theme="auto" />);
    expect(root(auto.container).dataset.theme).toBe("auto");
    expect(root(auto.container).className).not.toContain("instrument");
  });

  it("shows withdrawn instead of results", () => {
    const { container } = render(<EmbedView state={ok({ withdrawn: true })} theme="light" />);
    expect(screen.getByText("withdrawn")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(container.textContent).not.toContain("81.5");
    expect(container.textContent).toContain("no longer published");
  });

  it("never ranks when no setup has a gated score", () => {
    const rows = tdm205Embed().rows.map((r) => ({ ...r, score: null }));
    const { container } = render(<EmbedView state={ok({ rows })} theme="light" />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.every((li) => li.textContent?.endsWith("no gated score"))).toBe(true);
    expect(screen.queryByLabelText(/^rank /)).toBeNull();
    expect(container.textContent).not.toContain("baseline ·");
  });

  it("says when the benchmark is missing or can't load", () => {
    render(<EmbedView state={{ kind: "missing", slug: "nope-bench" }} theme="auto" />);
    expect(screen.getByRole("status").textContent).toMatch(/No published benchmark/);
    cleanup();
    render(
      <EmbedView state={{ kind: "error", slug: "x-bench", message: "HTTP 500" }} theme="auto" />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/can't be loaded/);
  });
});

describe("height messages", () => {
  let observed: (() => void) | undefined;
  beforeEach(() => {
    observed = undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observed = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  it("posts its height to the parent on mount and on resize", () => {
    let height = 287.2;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ height }) as DOMRect,
    );
    // In jsdom the window is its own parent.
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    render(<EmbedView state={ok()} theme="light" />);
    expect(post).toHaveBeenLastCalledWith(
      { type: "anybench:height", slug: TDM205_SLUG, height: 288 },
      "*",
    );
    act(() => observed?.());
    expect(post).toHaveBeenCalledTimes(1); // unchanged height: no new message
    height = 410;
    act(() => observed?.());
    expect(post).toHaveBeenLastCalledWith(
      { type: "anybench:height", slug: TDM205_SLUG, height: 410 },
      "*",
    );
  });
});

describe("/embed/[slug] page", () => {
  it("fetches the public embed with the theme and version, and renders it", async () => {
    vi.stubEnv("ANYBENCH_API_URL", "https://api.example");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return json(200, tdm205Embed());
    });
    const el = await EmbedPage({
      params: Promise.resolve({ slug: TDM205_SLUG }),
      searchParams: Promise.resolve({ theme: "dark", version: "3" }),
    });
    const { container } = render(el);
    expect(urls).toEqual([`https://api.example/public/embed/${TDM205_SLUG}?theme=dark&version=3`]);
    expect(root(container).dataset.theme).toBe("dark");
    expect(screen.getByText("Tandem vs Claude Code solo")).toBeTruthy();
  });
});

describe("public/embed.js", () => {
  const code = readFileSync(join(__dirname, "../public/embed.js"), "utf8");
  afterEach(() => {
    delete (window as unknown as { AnybenchEmbed?: unknown }).AnybenchEmbed;
    document.body.innerHTML = "";
  });

  it("is under 2 KB", () => {
    expect(Buffer.byteLength(code)).toBeLessThan(2048);
  });

  it("injects an iframe per embed div and resizes it from its height message", () => {
    document.body.innerHTML = `
      <div data-anybench-embed="${TDM205_SLUG}" data-theme="dark" data-version="2"></div>
      <div data-anybench-embed="other-bench"></div>
      <div data-anybench-embed="Bad Slug!"></div>`;
    new Function(code)();
    const frames = [...document.querySelectorAll("iframe")];
    expect(frames).toHaveLength(2);
    const origin = window.location.origin;
    expect(frames[0]?.getAttribute("src")).toBe(
      `${origin}/embed/${TDM205_SLUG}?theme=dark&version=2`,
    );
    expect(frames[1]?.getAttribute("src")).toBe(`${origin}/embed/other-bench?theme=auto`);
    expect(frames[0]?.getAttribute("scrolling")).toBe("no");

    const send = (data: unknown, source: Window | null, from = origin) =>
      window.dispatchEvent(new MessageEvent("message", { data, origin: from, source }));
    send({ type: "anybench:height", height: 301.4 }, frames[0]?.contentWindow ?? null);
    expect(frames[0]?.style.height).toBe("302px");
    expect(frames[1]?.style.height).toBe("320px");
    // Another origin, another message type or a silly height is ignored.
    send(
      { type: "anybench:height", height: 50 },
      frames[1]?.contentWindow ?? null,
      "https://evil.test",
    );
    send({ type: "other", height: 50 }, frames[1]?.contentWindow ?? null);
    send({ type: "anybench:height", height: 1e9 }, frames[1]?.contentWindow ?? null);
    expect(frames[1]?.style.height).toBe("320px");

    // Loading it twice mounts only new divs.
    document.body.insertAdjacentHTML("beforeend", `<div data-anybench-embed="third-bench"></div>`);
    new Function(code)();
    expect(document.querySelectorAll("iframe")).toHaveLength(3);
  });
});

describe("docs", () => {
  it("/docs/badges shows the iframe and script-tag embed snippets", () => {
    const { container } = render(<BadgesDocsPage />);
    expect(screen.getByRole("heading", { name: "Embed a benchmark" })).toBeTruthy();
    expect(screen.getByText("Embed (script tag)")).toBeTruthy();
    expect(container.textContent).toContain('data-anybench-embed="<slug>"');
    expect(container.textContent).toContain("https://anybench.jaxonp.com/embed.js");
    expect(container.textContent).toContain("anybench:height");
  });
});
