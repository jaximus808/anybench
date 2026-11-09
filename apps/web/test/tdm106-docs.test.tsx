import { DriverTypeSchema, MCP_SETUP_COMMAND, MCP_TOOLS } from "@anybench/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import BadgesDocsPage from "../app/docs/badges/page";
import CliDocsPage from "../app/docs/cli/page";
import KitsDocsPage from "../app/docs/kits/page";
import McpDocsPage from "../app/docs/mcp/page";
import DocsOverviewPage from "../app/docs/page";
import ProofChecksDocsPage from "../app/docs/proof-checks/page";
import { MINIMAL_KIT_YAML } from "../components/docs/kit-example";
import { DOCS_NAV } from "../components/docs/links";

afterEach(cleanup);

const PAGES: Record<string, { title: string; Page: () => ReactElement }> = {
  "/docs": { title: "Anybench docs", Page: DocsOverviewPage },
  "/docs/kits": { title: "How a kit works", Page: KitsDocsPage },
  "/docs/proof-checks": { title: "Proof checks", Page: ProofChecksDocsPage },
  "/docs/cli": { title: "CLI", Page: CliDocsPage },
  "/docs/mcp": { title: "MCP tools", Page: McpDocsPage },
  "/docs/badges": { title: "Badges and embeds", Page: BadgesDocsPage },
};

describe("docs pages (TDM-106)", () => {
  it("every nav entry has a page", () => {
    expect(DOCS_NAV.map((l) => l.href).sort()).toEqual(Object.keys(PAGES).sort());
  });

  for (const [path, { title, Page }] of Object.entries(PAGES)) {
    it(`${path} renders its title and the left nav with itself current`, () => {
      render(<Page />);
      expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy();
      const nav = screen.getByRole("navigation", { name: "Docs" });
      const links = within(nav).getAllByRole("link");
      expect(links.map((a) => a.getAttribute("href"))).toEqual(DOCS_NAV.map((l) => l.href));
      expect(
        links
          .filter((a) => a.getAttribute("aria-current") === "page")
          .map((a) => a.getAttribute("href")),
      ).toEqual([path]);
    });
  }

  it("/docs/kits shows L0–L7, all nine driver types and the validated example", () => {
    const { container } = render(<KitsDocsPage />);
    const layers = screen.getByRole("table", { name: "Kit layers" });
    const layerHeads = within(layers)
      .getAllByRole("rowheader")
      .map((th) => th.textContent?.slice(0, 2));
    expect(layerHeads).toEqual(["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"]);

    const drivers = screen.getByRole("table", { name: "The 9 driver types" });
    const types = within(drivers)
      .getAllByRole("rowheader")
      .map((th) => th.querySelector("code")?.textContent);
    expect(types).toEqual([...DriverTypeSchema.options]);
    // x11 needs the gui profile, which is on the roadmap.
    const x11 = within(drivers).getAllByRole("rowheader")[DriverTypeSchema.options.indexOf("x11")];
    expect(x11?.textContent).toContain("Planned");

    const example = within(container).getByText("anybench.yaml", { selector: "figcaption" });
    expect(example.closest("figure")?.querySelector("pre code")?.textContent).toBe(
      MINIMAL_KIT_YAML,
    );
  });

  it("/docs/proof-checks lists the six checks and the repair limit", () => {
    const { container } = render(<ProofChecksDocsPage />);
    const table = screen.getByRole("table", { name: "Proof checks" });
    expect(within(table).getAllByRole("rowheader")).toHaveLength(6);
    expect(container.textContent).toMatch(/up to 2\s+times/);
    expect(container.textContent).toContain("needs_human");
  });

  it("/docs/cli marks only kit validate as available", () => {
    render(<CliDocsPage />);
    const table = screen.getByRole("table", { name: "anybench commands" });
    const rows = within(table).getAllByRole("row").slice(1);
    const status = Object.fromEntries(
      rows.map((r) => [
        r.querySelector("th code")?.textContent?.split(" ").slice(0, 3).join(" "),
        r.lastElementChild?.textContent,
      ]),
    );
    expect(status["anybench kit validate"]).toBe("Available");
    for (const cmd of ["login", "init", "run", "watch", "logs", "report", "publish", "verify"]) {
      const key = Object.keys(status).find((k) => k.startsWith(`anybench ${cmd}`));
      expect(key, cmd).toBeDefined();
      expect(status[key!]).toBe("Coming soon");
    }
  });

  it("/docs/mcp lists exactly the tools the MCP server registers (TDM-220)", () => {
    render(<McpDocsPage />);
    const rows = (caption: string) =>
      within(screen.getByRole("table", { name: caption }))
        .getAllByRole("rowheader")
        .map((th) => th.textContent);
    const author = rows("Kit-authoring tools");
    const observe = rows("Run tools");
    expect([...author, ...observe]).toEqual(MCP_TOOLS.map((t) => t.name));
    for (const t of [
      "get_kit_guide",
      "scaffold_kit",
      "validate_kit",
      "run_local_proof",
      "push_kit",
      "start_run",
    ])
      expect(author).toContain(t);
    for (const t of ["list_runs", "get_run", "watch_run", "list_trials", "get_trial", "get_report"])
      expect(observe).toContain(t);
    // Nothing documented that the server does not register.
    for (const gone of [
      "get_run_events",
      "tail_trial_log",
      "get_transcript",
      "get_computer",
      "ack_alert",
    ])
      expect(screen.queryByText(gone)).toBeNull();
    expect(screen.getAllByText(MCP_SETUP_COMMAND).length).toBeGreaterThan(0);
  });

  it("/docs/badges is marked planned and shows badge and embed snippets", () => {
    const { container } = render(<BadgesDocsPage />);
    expect(container.textContent).toContain("Planned");
    expect(screen.getByText("README badge (Markdown)")).toBeTruthy();
    expect(screen.getByText("Embed (HTML)")).toBeTruthy();
    expect(container.textContent).toContain("/.well-known/anybench-keys.json");
  });

  it("the overview makes no confidence-interval claim and says unproven kits are not run", () => {
    const { container } = render(<DocsOverviewPage />);
    expect(container.textContent).not.toMatch(/confidence interval/);
    expect(container.textContent).toMatch(/is\s+not run/);
    expect(container.textContent).toMatch(/runs separately from the contender/);
  });
});
