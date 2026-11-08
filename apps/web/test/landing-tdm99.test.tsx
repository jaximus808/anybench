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
  "Three kinds of project, one way in",
  "What using it looks like",
  "The benchmark that skips the work",
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

  it("states the founder's pricing: $2 per run, compute at cost + 50%, own key, $5 credit", () => {
    render(<HomePage />);
    const pricing = screen.getByRole("region", { name: "Pay for what runs" });
    const text = pricing.textContent ?? "";
    expect(text).toContain("$2per benchmark run");
    expect(text).toContain("Plus computer time at cost + 50%, plus model tokens on your own key.");
    expect(text).toContain("about $0.08 per vCPU-hour, billed in 10-minute blocks");
    expect(text).toContain("Infrastructure failures are never billed.");
    expect(text).toContain("$5 free credit when you sign up");
    expect(text).toContain("Billed monthly by usage, to the card on file.");
    expect(text).toContain(
      "estimateA Tandem vs Claude Code benchmark (60 agent trials, ~30 min each) is about $19 plus your tokens; a typical CLI or API benchmark is $2–4.",
    );
  });

  it("carries no trace of the old per-trial price", () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("$0.25");
    expect(text).not.toMatch(/\$15 run fee|60 trials: \$15/i);
  });

  it("labels every illustrative number as an example", () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? "";
    expect(text).toContain("example numbers");
    expect(text).toContain("example report · made-up numbers");
    expect(text).toContain("illustrative, not a real run");
    expect(text).toContain("example scan");
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
