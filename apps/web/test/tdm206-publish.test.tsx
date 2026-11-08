import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  badgeHtml,
  badgeMarkdown,
  embedSnippet,
  PublishButton,
  slugify,
} from "../components/bench/PublishDialog";
import { LiveRunView } from "../components/live/LiveRunPage";
import { ReportPage } from "../components/report/ReportPage";
import { createWebApiClient } from "../lib/api";
import { LiveApiContext } from "../lib/live/client";
import { applyEvents, initLive } from "../lib/live/model";
import { createDemoRun } from "./fixtures/simulator";
import { TDM103_RUN_ID, tdm103Report } from "./fixtures/tdm103-report";

// TDM-206: the Publish dialog on a delivered run. POST /runs/:id/publish against a fake API:
// 201 shows the link, embed and badge snippets; 409 explains why, with the proof checks that did
// not pass; an invalid slug blocks submit; the button exists only on delivered runs.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const BENCH_ID = "019a5f3e-7c00-7000-8000-000000000206";
const PAGE = "https://anybench.test/b/jaxon/is-tandem-faster";
const EMBED = "https://anybench.test/embed/is-tandem-faster";
const BADGE = "https://api.anybench.test/badge/is-tandem-faster.svg";

function published(body: { slug: string; visibility: string; auto_publish: boolean }) {
  const created_at = "2026-11-08T08:00:00.000Z";
  return {
    benchmark: {
      id: BENCH_ID,
      owner: "jaxon",
      slug: body.slug,
      run_id: TDM103_RUN_ID,
      title: "Is tandem faster?",
      kind: "agent",
      visibility: body.visibility,
      latest_version: 1,
      pinned_version: null,
      auto_publish: body.auto_publish,
      page_url: PAGE,
      badge_url: BADGE,
      embed_url: EMBED,
      created_at,
    },
    version: {
      version: 1,
      status: "live",
      report: tdm103Report(),
      attestation: {
        v: 1,
        benchmark_id: BENCH_ID,
        slug: body.slug,
        version: 1,
        run_id: TDM103_RUN_ID,
        kit_hash: "a".repeat(64),
        contenders: [],
        trial_count: 0,
        proof: [],
        comped: false,
        created_at,
      },
      signature: "c2lnbmF0dXJl",
      key_id: "k1",
      created_at,
    },
  };
}

type Handler = (method: string, path: string, body: unknown) => Response;
let calls: { method: string; path: string; body: unknown }[] = [];
function clientWith(handler: Handler) {
  return createWebApiClient("https://api.test", {
    fetch: async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url).pathname;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      return handler(method, path, body);
    },
  });
}

const okApi: Handler = (method, path, body) => {
  if (method === "POST" && path.endsWith("/publish"))
    return json(201, published(body as Parameters<typeof published>[0]));
  if (path.endsWith("/report")) return json(200, { report: tdm103Report() });
  return json(404, { error: { code: "not_found", message: "nope" } });
};

async function openDialog(handler: Handler, question = "Is tandem faster?") {
  await act(async () => {
    render(
      <LiveApiContext.Provider value={clientWith(handler)}>
        <PublishButton runId={TDM103_RUN_ID} runState="delivered" question={question} />
      </LiveApiContext.Provider>,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  return screen.getByRole("dialog", { name: "Publish this benchmark" });
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("publish helpers", () => {
  it("slugifies the question into a valid slug", () => {
    expect(slugify("Is tandem faster?")).toBe("is-tandem-faster");
    expect(slugify("  Café — über   speed!! ")).toBe("cafe-uber-speed");
    expect(slugify("?")).toBe("benchmark");
    const long = slugify("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
  });

  it("builds the embed and badge snippets from the benchmark urls", () => {
    const b = { page_url: PAGE, embed_url: EMBED, badge_url: BADGE, title: 'A "quoted" title' };
    expect(embedSnippet(b)).toBe(
      `<iframe src="${EMBED}" title="A &quot;quoted&quot; title on Anybench" width="100%" height="420" style="border:0" loading="lazy"></iframe>\n<script async src="https://anybench.test/embed.js"></script>`,
    );
    expect(badgeMarkdown(b)).toBe(`[![Anybench](${BADGE})](${PAGE})`);
    expect(badgeHtml(b)).toBe(
      `<a href="${PAGE}"><img src="${BADGE}" alt="Anybench: A &quot;quoted&quot; title"></a>`,
    );
  });
});

describe("publish dialog (TDM-206)", () => {
  it("publishes and shows the public link, embed and badge with copy buttons", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const dialog = await openDialog(okApi);

    const slug = within(dialog).getByLabelText("Slug") as HTMLInputElement;
    expect(slug.value).toBe("is-tandem-faster");
    expect(document.activeElement).toBe(slug);
    expect(within(dialog).getByRole("radio", { name: /Public/ })).toHaveProperty("checked", true);
    const toggle = within(dialog).getByRole("switch", { name: /Rerun on next release/ });
    expect(toggle).toHaveProperty("checked", false);
    expect(dialog.textContent).toContain("waits for you to review it");

    fireEvent.click(within(dialog).getByRole("radio", { name: /Unlisted/ }));
    fireEvent.click(toggle);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    });

    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: `/runs/${TDM103_RUN_ID}/publish`,
      body: { slug: "is-tandem-faster", visibility: "unlisted", auto_publish: true },
    });

    const done = await screen.findByTestId("publish-done");
    expect(screen.getByRole("dialog", { name: "Published" })).toBeTruthy();
    expect((within(done).getByLabelText("Public link") as HTMLInputElement).value).toBe(PAGE);
    const embed = (within(done).getByLabelText("Embed") as HTMLTextAreaElement).value;
    expect(embed).toContain(`<iframe src="${EMBED}"`);
    expect(embed).toContain("<script async src=");
    expect((within(done).getByLabelText("Badge (Markdown)") as HTMLInputElement).value).toBe(
      `[![Anybench](${BADGE})](${PAGE})`,
    );
    expect((within(done).getByLabelText("Badge (HTML)") as HTMLInputElement).value).toContain(
      `<img src="${BADGE}"`,
    );
    expect(done.textContent).toContain("unlisted");
    expect(within(done).getByRole("link", { name: "Open the page" }).getAttribute("href")).toBe(
      PAGE,
    );

    await act(async () => {
      fireEvent.click(within(done).getByRole("button", { name: "Copy badge (markdown)" }));
    });
    expect(writeText).toHaveBeenCalledWith(`[![Anybench](${BADGE})](${PAGE})`);
    expect(within(done).getByRole("button", { name: "Copy badge (markdown)" }).textContent).toBe(
      "Copied",
    );
  });

  it("falls back to select + execCommand when the clipboard API is missing", async () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    const dialog = await openDialog(okApi);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    });
    const done = await screen.findByTestId("publish-done");
    await act(async () => {
      fireEvent.click(within(done).getByRole("button", { name: "Copy public link" }));
    });
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("explains a 409 with the API's reason and the proof checks that did not pass", async () => {
    const dialog = await openDialog((method, path) => {
      if (method === "POST" && path.endsWith("/publish"))
        return json(409, {
          error: {
            code: "conflict",
            message: "only a run whose six proof checks all passed can be published (2/6 passed)",
          },
        });
      if (path.endsWith("/report")) return json(200, { report: tdm103Report() });
      return json(404, { error: { code: "not_found", message: "nope" } });
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    });
    const conflict = await screen.findByTestId("publish-conflict");
    expect(conflict.getAttribute("role")).toBe("alert");
    expect(conflict.textContent).toContain("can’t be published yet");
    expect(conflict.textContent).toContain(
      "Only a run whose six proof checks all passed can be published (2/6 passed)",
    );
    const missing = within(conflict).getByRole("list", { name: "Proof checks that did not pass" });
    const failing = tdm103Report().proof.filter((p) => !p.pass);
    expect(within(missing).getAllByRole("listitem")).toHaveLength(failing.length);
    expect(missing.textContent).toContain(failing[0]!.reason);
    expect(screen.queryByTestId("publish-done")).toBeNull();
    // The form stays: a 409 for a taken slug is fixed by changing it.
    expect(within(dialog).getByLabelText("Slug")).toBeTruthy();
  });

  it("blocks submit on an invalid slug and shows the rule", async () => {
    const dialog = await openDialog(okApi);
    const slug = within(dialog).getByLabelText("Slug");
    const submit = within(dialog).getByRole("button", { name: "Publish" });
    expect(submit).toHaveProperty("disabled", false);
    expect(slug.getAttribute("aria-invalid")).toBe("false");

    for (const bad of ["ab", "Has-Caps", "-leading", "trailing-", "spaces here", "x".repeat(65)]) {
      fireEvent.change(slug, { target: { value: bad } });
      expect(slug.getAttribute("aria-invalid")).toBe("true");
      expect(submit).toHaveProperty("disabled", true);
    }
    expect(dialog.textContent).toContain("Not a valid slug.");
    expect(dialog.textContent).toContain("3–64 characters");
    fireEvent.submit(slug.closest("form")!);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    fireEvent.change(slug, { target: { value: "tandem-v2" } });
    expect(submit).toHaveProperty("disabled", false);
  });

  it("closes on Escape and on a backdrop click, and returns focus to the button", async () => {
    let dialog = await openDialog(okApi);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Publish" }));

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.mouseDown(screen.getByTestId("publish-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the Publish button only shows on delivered runs", () => {
  it.each(["running", "awaiting_go", "needs_human", "failed", "cancelled"] as const)(
    "%s: no button",
    async (state) => {
      await act(async () => {
        render(
          <LiveApiContext.Provider value={clientWith(okApi)}>
            <PublishButton runId={TDM103_RUN_ID} runState={state} question="Is tandem faster?" />
          </LiveApiContext.Provider>,
        );
      });
      expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    },
  );

  it("on the live page: the delivered hero has it, a running run does not", async () => {
    const demo = createDemoRun({ profile: "tandem" });
    const T0 = Date.parse(demo.snapshot.run.created_at);
    const delivered = applyEvents(
      initLive(demo.snapshot),
      demo.timeline.map((e) => e.event),
    );
    expect(delivered.state).toBe("delivered");
    await act(async () => {
      render(
        <LiveApiContext.Provider value={clientWith(okApi)}>
          <LiveRunView live={delivered} status="ended" clockMs={T0 + demo.durationMs} />
        </LiveApiContext.Provider>,
      );
    });
    const hero = screen.getByTestId("phase-hero");
    expect(within(hero).getByRole("button", { name: "Publish" })).toBeTruthy();
    cleanup();

    const i = demo.timeline.findIndex(
      (e) => e.event.type === "run.state_changed" && e.event.payload.to === "running",
    );
    const running = applyEvents(
      initLive(demo.snapshot),
      demo.timeline.slice(0, i + 1).map((e) => e.event),
    );
    await act(async () => {
      render(
        <LiveApiContext.Provider value={clientWith(okApi)}>
          <LiveRunView live={running} status="live" clockMs={T0 + demo.timeline[i]!.atMs} />
        </LiveApiContext.Provider>,
      );
    });
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });

  it.each([
    ["delivered", true],
    ["failed", false],
  ] as const)("on /runs/[id]/report (%s): button shown = %s", async (state, shown) => {
    const client = clientWith((method, path) => {
      if (path.endsWith("/report")) return json(200, { report: tdm103Report() });
      if (method === "GET" && path === `/runs/${TDM103_RUN_ID}`) return json(200, runDetail(state));
      return json(404, { error: { code: "not_found", message: "nope" } });
    });
    await act(async () => {
      render(<ReportPage runId={TDM103_RUN_ID} client={client} />);
    });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeTruthy());
    expect(Boolean(screen.queryByRole("button", { name: "Publish" }))).toBe(shown);
  });
});

function runDetail(state: string) {
  return {
    run: {
      id: TDM103_RUN_ID,
      project_id: null,
      question: "Is tandem faster?",
      state,
      budget_micro_usd: "50000000",
      spent_micro_usd: "1000000",
      estimate_micro_usd: null,
      kit_id: null,
      paused_reason: null,
      cancel_requested_at: null,
      comped: false,
      created_at: "2026-11-07T22:00:00.000Z",
      updated_at: "2026-11-07T23:00:00.000Z",
    },
    counters: {
      trials_total: 0,
      trials_done: 0,
      trials_running: 0,
      trials_failed: 0,
      spent_micro_usd: "1000000",
      projected_micro_usd: null,
      elapsed_s: 0,
      eta_s: null,
      last_seq: 0,
    },
    open_alerts: [],
    agents: [],
  };
}
