import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomePage, { metadata } from "../app/(marketing)/page";
import { normalizeRepoUrl } from "../components/marketing/repo-url";

// Vitest runs from apps/web (jsdom gives import.meta.url an http: scheme).
const WEB_DIR = process.cwd();
const MARKETING_DIR = resolve(WEB_DIR, "components/marketing");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SECTION_HEADINGS = [
  "Five steps from your repo to an answer",
  "A faster number only counts if the screen is right",
  "Watch every agent work, on one page",
  "What using it looks like",
  "Three kinds of project, one way in",
  "Or type /anybench in Claude Code",
  "Connect GitHub, and it proposes a benchmark for every repo",
  "It knows what to compare against, and it can't be gamed",
  "Pay for what runs",
  "Anybench is a company run by agents",
];

describe("landing page (TDM-99)", () => {
  it("renders the hero and every section heading in order", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Find out if what you built is actually better.",
      }),
    ).toBeTruthy();
    const h2s = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2s).toEqual(SECTION_HEADINGS);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("ships no placeholder text", () => {
    const { container } = render(<HomePage />);
    // Include hidden tab panels: textContent covers them too.
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/lorem|ipsum|placeholder|coming soon/i);
    // Case-sensitive so the example task id "todo-api" doesn't count.
    expect(text).not.toMatch(/\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b/);
    expect(text).not.toMatch(/undefined|\[object Object\]|NaN/);
  });

  it("has no TODO/lorem left in the landing page source", () => {
    const files = [
      ...readdirSync(MARKETING_DIR).map((f) => join(MARKETING_DIR, f)),
      resolve(WEB_DIR, "app/(marketing)/page.tsx"),
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/lorem|ipsum/i);
      expect(src, file).not.toMatch(/\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b/);
    }
  });

  it("gives the header's anchors something to land on", () => {
    const { container } = render(<HomePage />);
    for (const id of ["how-it-works", "pricing", "company"])
      expect(container.querySelector(`#${id}`)?.tagName).toBe("SECTION");
  });

  it("states pricing simply in words and links to /pricing for every amount (TDM-226)", () => {
    render(<HomePage />);
    const pricing = screen.getByRole("region", { name: "Pay for what runs" });
    const text = pricing.textContent ?? "";
    expect(text).toContain("Freeyour first benchmark");
    expect(text).toContain("Free, on your own model key. No card.");
    expect(text).toContain("A run fee per benchmark, plus computer time at cost plus a markup.");
    expect(text).toContain("A hard cap");
    expect(text).toContain("Infrastructure failures and our retries are never billed.");
    // The landing page is static: no amount is typed here; /pricing renders them from the API.
    expect(text).not.toMatch(/\$\d|\d+%/);
    expect(
      within(pricing)
        .getByRole("link", { name: "See pricing and two worked examples" })
        .getAttribute("href"),
    ).toBe("/pricing");
  });

  it("uses one cost and duration model everywhere ($17 for 60 trials, about 2 h)", () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? "";
    // The Test plan screen and the /anybench transcript.
    expect(text.match(/≈ \$15 compute \+ \$2 run fee ≈ \$17/g)).toHaveLength(2);
    expect(text).toContain("about 2 h, 14 at a time");
    expect(text).not.toMatch(/\$19|40 min|\$40–120|\$0\.08 per vCPU/);
    expect(text).toContain("$1.58 tokens");
  });

  it("carries no trace of the old per-trial price", () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("$0.25");
    expect(text).not.toMatch(/\$15 run fee|60 trials: \$15/i);
  });

  it("carries no example or made-up disclaimer labels", () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Made-up|hypothetical|not a real run/i);
    const labels = [...container.querySelectorAll("[aria-label]")]
      .map((el) => el.getAttribute("aria-label") ?? "")
      .join("\n");
    expect(labels).not.toMatch(/Made-up|hypothetical|not a real run/i);
    // The hero figure is a still of the run page.
    expect(container.querySelector("figure[aria-label^='Run page']")).not.toBeNull();
  });

  it("has no simulated live demo: no /runs/demo link and no live claim in the hero", () => {
    const { container } = render(<HomePage />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.filter((h) => h.includes("/runs/"))).toEqual([]);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/live demo|simulated run|watch a run live/i);
  });

  it("example report follows plan.md 17.2: verdicts with n, no composite, no human minutes", () => {
    render(<HomePage />);
    const panel = screen.getByRole("tabpanel"); // Results is selected by default
    const text = panel.textContent ?? "";
    expect(text).toContain(
      "On these 3 tasks, Tandem ×3 solves faster than Claude Code with subagents (−9 min, 95% CI −14 to −3). Pass rate: no detectable difference at n=15 per setup (+13 pts, CI −19 to +42; smallest detectable ≈45 pts). ×5 vs ×3: no detectable difference.",
    );
    expect(text).toMatch(/\b(better|worse|no detectable difference)\b/);
    expect(text).toContain("n=");
    expect(text).toContain("11/15, Wilson 48–89%");
    expect(text).toContain("Trials passed");
    expect(text).toContain("Time to solve (failures counted at the cap)");
    expect(text).toContain("Cost per solved task (all spend ÷ solved)");
    expect(text).toContain("Simulated approvals");
    expect(text).toContain(
      "looked worse in this sample (2/5 vs 3/5), no detectable difference at n=5",
    );
    expect(text).not.toMatch(/Human minutes|points above|% faster|Score|Tasks solved|Median time/);
    expect(text).not.toMatch(/How C got/);
  });

  it("never claims a difference without a verdict anywhere on the page", () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/points above|% faster|Human minutes/);
    expect(text).not.toMatch(/score for each contender/i);
    expect(text.toLowerCase()).toContain("a verdict on each comparison and the reasons behind it");
    expect(metadata.description).toContain(
      "a verdict on each comparison and the reasons behind it",
    );
  });

  it("calls the bug-hunt task a planted bug, never your repo's history", () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? "";
    expect(text).toContain("planted bug");
    expect(text).not.toMatch(/3f2a1c|reverted commit|from your repo's history|from your commit/i);
  });

  it("states only linkable facts about Velocitty; the chart uses generic terminals", () => {
    const { container } = render(<HomePage />);
    const section = screen.getByRole("region", {
      name: "A faster number only counts if the screen is right",
    });
    const text = section.textContent ?? "";
    expect(text).toContain(
      "Added automated Ghostty throughput comparisons with raw samples and generated charts.",
    );
    expect([...section.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://github.com/valvesky/velocitty/releases/tag/v1.3.0",
    ]);
    expect(text).toContain("A terminal that drops output");
    // No deleted post, no invented mechanism, no numbers attributed to the project.
    const page = container.textContent ?? "";
    expect(page).not.toMatch(/Hashimoto|x\.com|read the source|64 KiB|1 MiB|velocitty 1\.3/i);
    const chart = section.querySelector("figure")?.textContent ?? "";
    expect(chart).not.toMatch(/velocitty|ghostty|alacritty/i);
  });

  it("shows the four product screens, Results first, and switches with the keyboard", () => {
    render(<HomePage />);
    const tablist = screen.getByRole("tablist", { name: "Anybench screens" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["1Ask", "2Test plan", "3Running", "4Results"]);
    const results = tabs[3]!;
    expect(results.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(results.id);

    fireEvent.keyDown(results, { key: "ArrowRight" });
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[0]);
    expect(screen.getByRole("tabpanel").textContent).toContain("Setups to compare");

    fireEvent.keyDown(tabs[0]!, { key: "End" });
    expect(tabs[3]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(tabs[2]!);
    expect(screen.getByRole("tabpanel").textContent).toContain("38 / 60");
    expect(tabs.filter((t) => t.tabIndex === 0)).toEqual([tabs[2]]);
  });

  it("hero form copies the repo URL and shows the early-access contact; no network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<HomePage />);

    expect(screen.getByText(/Early access:/).closest("p")?.textContent).toContain(
      "jaxonp808@gmail.com",
    );
    const input = screen.getByLabelText("Your project's repo URL");
    const button = screen.getByRole("button", { name: "Start a bench" });

    fireEvent.click(button);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("status").textContent).toMatch(/doesn't look like a repo/);

    fireEvent.change(input, { target: { value: "https://github.com/You/your-project.git" } });
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Copied github.com/You/your-project",
      ),
    );
    expect(writeText).toHaveBeenCalledWith("https://github.com/You/your-project");
    expect(screen.getByRole("status").textContent).toContain("jaxonp808@gmail.com");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to telling the visitor what to send when the clipboard is blocked", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<HomePage />);
    fireEvent.change(screen.getByLabelText("Your project's repo URL"), {
      target: { value: "you/project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start a bench" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Send github.com/you/project to jaxonp808@gmail.com",
      ),
    );
  });

  it("scrollable tables and terminal panels are keyboard reachable and labelled", () => {
    const { container } = render(<HomePage />);
    for (const el of container.querySelectorAll("pre, table")) {
      const scroller = el.tagName === "PRE" ? el : el.parentElement;
      expect(scroller, el.outerHTML.slice(0, 80)).not.toBeNull();
      expect(scroller!.getAttribute("tabindex")).toBe("0");
    }
    for (const img of container.querySelectorAll("img, [role='img']"))
      expect(img.getAttribute("alt") ?? img.getAttribute("aria-label")).toBeTruthy();
  });

  it("exports title, description, Open Graph and Twitter metadata", () => {
    expect(metadata.title).toEqual({ absolute: expect.stringContaining("Anybench") });
    expect(metadata.description).toMatch(/correctness gate/);
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      siteName: "Anybench",
      title: expect.any(String),
      description: metadata.description,
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary",
      title: expect.any(String),
      description: metadata.description,
    });
  });
});

describe("normalizeRepoUrl (TDM-99)", () => {
  it.each([
    ["github.com/you/project", "github.com/you/project"],
    ["https://github.com/you/project", "github.com/you/project"],
    ["https://www.GitHub.com/you/project.git/", "github.com/you/project"],
    ["git@github.com:you/project.git", "github.com/you/project"],
    ["you/project", "github.com/you/project"],
    ["https://gitlab.com/group/sub/project?x=1#readme", "gitlab.com/group/sub/project"],
    ["  github.com/you/project  ", "github.com/you/project"],
  ])("%s → %s", (input, display) => {
    expect(normalizeRepoUrl(input)).toEqual({ display, url: `https://${display}` });
  });

  it.each(["", "   ", "github.com", "github.com/you", "not a url", "https://", "a b/c"])(
    "rejects %j",
    (input) => {
      expect(normalizeRepoUrl(input)).toBeNull();
    },
  );
});
