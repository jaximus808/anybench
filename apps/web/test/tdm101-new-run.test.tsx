// TDM-101: the Ask screen and the runs list, against a mocked API (fake fetch through the real
// typed client, so request and response contracts are both exercised).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApiClient } from "../lib/api";
import { NewRunForm } from "../app/runs/new/NewRunForm";
import { RunsList, stateTone } from "../app/runs/RunsList";
import {
  buildCreateRunBody,
  EMPTY_FORM,
  parseGithubRepo,
  parseUsdToMicro,
  safeHttpsUrl,
  sha256OfBlob,
  uploadFile,
  uploadSizeError,
  UploadTooLargeError,
} from "../app/runs/new/new-run";
import { Sha256 } from "../app/runs/new/sha256";
import { apiRoutes, UPLOAD_MAX_BYTES } from "@anybench/core";
import { createHash } from "node:crypto";

const nav = { push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const BASE = "https://api.test";
const RUN_ID = "0192f5d0-0000-7000-8000-000000000001";
const UPLOAD_ID = "0192f5d0-0000-7000-8000-0000000000aa";
const NOW = "2026-11-07T21:00:00Z";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const ME = {
  user: {
    id: "0192f5d0-0000-7000-8000-0000000000ff",
    github_login: "jaxon",
    email: null,
    avatar_url: null,
    is_admin: false,
    created_at: NOW,
  },
  via: { kind: "session" },
};

function run(over: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    project_id: null,
    question: "Is it faster than ripgrep?\n\nPreferences:\n- Runs per setup and task: 5",
    state: "intake",
    budget_micro_usd: "100000000",
    spent_micro_usd: "0",
    estimate_micro_usd: null,
    kit_id: null,
    paused_reason: null,
    cancel_requested_at: null,
    comped: false,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };
type Handler = (c: Call) => Response | undefined;

function mockApi(...handlers: Handler[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? "GET",
      path: url.slice(BASE.length),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    for (const h of handlers) {
      const r = h(call);
      if (r) return r;
    }
    if (call.path === "/auth/me") return json(200, ME);
    return json(404, { error: { code: "not_found", message: "no mock" } });
  };
  return { calls, client: createWebApiClient(BASE, { fetch }) };
}

const route =
  (method: string, path: string, res: () => Response): Handler =>
  (c) =>
    c.method === method && c.path.split("?")[0] === path ? res() : undefined;

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
});
afterEach(cleanup);

describe("new run helpers (TDM-101)", () => {
  it("parses dollars to micro-USD without floats", () => {
    expect(parseUsdToMicro("120")).toBe(120_000_000n);
    expect(parseUsdToMicro("$49.5")).toBe(49_500_000n);
    expect(parseUsdToMicro("0.01")).toBe(10_000n);
    expect(parseUsdToMicro("1,000")).toBe(1_000_000_000n);
    expect(parseUsdToMicro("1.234")).toBeNull();
    expect(parseUsdToMicro("-5")).toBeNull();
    expect(parseUsdToMicro("abc")).toBeNull();
  });

  it("reads owner/repo, github.com URLs and /tree/<ref>", () => {
    expect(parseGithubRepo("jaximus808/tandem")).toEqual({ github: "jaximus808/tandem" });
    expect(parseGithubRepo("https://github.com/jaximus808/tandem/")).toEqual({
      github: "https://github.com/jaximus808/tandem",
    });
    expect(parseGithubRepo("https://github.com/a/b/tree/v1.2")).toEqual({
      github: "https://github.com/a/b",
      ref: "v1.2",
    });
    expect(parseGithubRepo("https://gitlab.com/a/b")).toBeNull();
    expect(parseGithubRepo("")).toBeNull();
  });

  it("builds a contract-valid body and folds preferences into the question", () => {
    const r = buildCreateRunBody({
      ...EMPTY_FORM,
      question: "Is it faster than ripgrep?",
      repo: "https://github.com/a/b",
      contenders: ["ripgrep", " "],
      notifySlack: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.source).toEqual({ kind: "github", github: "https://github.com/a/b" });
    expect(r.body.budget_micro_usd).toBe(100_000_000n);
    expect(r.body.auto_go).toBe(false);
    expect(r.body.question).toContain("Compare against: ripgrep\n");
    expect(r.body.question).toContain("Runs per setup and task: 5");
    expect(r.body.question).toContain("Approvals: A reviewer agent plays the human");
    expect(r.body.question).toContain("Send results to: email and Slack");
  });

  it("refuses an empty question, a bad repo, bad runs and a zero budget", () => {
    const r = buildCreateRunBody({ ...EMPTY_FORM, repo: "nope", runsPerSetup: 0, budgetUsd: "0" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(4);
  });

  it("binary needs an upload or a URL; claude setup needs an upload", () => {
    const base = { ...EMPTY_FORM, question: "faster?" };
    expect(buildCreateRunBody({ ...base, sourceKind: "binary" }).ok).toBe(false);
    const viaUrl = buildCreateRunBody({
      ...base,
      sourceKind: "binary",
      binaryUrl: "https://x.test/tool",
      docsUrl: "https://x.test/docs",
    });
    expect(viaUrl.ok && viaUrl.body.source).toEqual({
      kind: "binary",
      binary_url: "https://x.test/tool",
      docs_url: "https://x.test/docs",
    });
    expect(buildCreateRunBody({ ...base, sourceKind: "claude_setup" }).ok).toBe(false);
    const setup = buildCreateRunBody(
      { ...base, sourceKind: "claude_setup" },
      { claudeSetup: UPLOAD_ID },
    );
    expect(setup.ok && setup.body.source).toEqual({ kind: "claude_setup", upload_id: UPLOAD_ID });
  });
});

function uploadRecord(status: "pending" | "complete", size: number) {
  return {
    id: UPLOAD_ID,
    purpose: "binary",
    filename: "tool",
    content_type: "application/octet-stream",
    size_bytes: size,
    sha256: "0".repeat(64),
    status,
    created_at: NOW,
    completed_at: status === "complete" ? NOW : null,
  };
}

describe("bounded uploads (TDM-101)", () => {
  it("incremental SHA-256 matches node:crypto across block boundaries", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      const h = new Sha256();
      // Feed in uneven pieces.
      for (let i = 0; i < n; i += 13) h.update(data.subarray(i, i + 13));
      expect(h.hex()).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });

  it("hashes a Blob slice by slice, never the whole file at once", async () => {
    const file = new File(["hello world, hashed in pieces"], "x.bin");
    const whole = vi.spyOn(file, "arrayBuffer");
    const slice = vi.spyOn(file, "slice");
    const hex = await sha256OfBlob(file, 4);
    expect(hex).toBe(createHash("sha256").update("hello world, hashed in pieces").digest("hex"));
    expect(whole).not.toHaveBeenCalled();
    expect(slice).toHaveBeenCalledTimes(Math.ceil(file.size / 4));
  });

  it("the contract refuses an over-cap upload per purpose", () => {
    const body = (purpose: "binary" | "claude_setup", size_bytes: number) => ({
      purpose,
      filename: "f",
      content_type: "application/zip",
      size_bytes,
      sha256: "0".repeat(64),
    });
    const schema = apiRoutes.uploads.create.body;
    expect(schema.safeParse(body("claude_setup", UPLOAD_MAX_BYTES.claude_setup)).success).toBe(
      true,
    );
    expect(schema.safeParse(body("claude_setup", UPLOAD_MAX_BYTES.claude_setup + 1)).success).toBe(
      false,
    );
    expect(UPLOAD_MAX_BYTES.binary).toBeGreaterThan(UPLOAD_MAX_BYTES.claude_setup);
  });

  it("refuses an over-cap file from file.size before reading or calling uploads.create", async () => {
    const { calls, client } = mockApi();
    const file = new File(["x"], "huge.bin");
    Object.defineProperty(file, "size", { value: UPLOAD_MAX_BYTES.binary + 1 });
    const read = vi.spyOn(file, "slice");
    await expect(uploadFile(client, file, "binary")).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(read).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(uploadSizeError(file.size, "binary")).toMatch(/limit is 1 GB/);
  });

  it("the form shows the size error on select and never starts the upload", async () => {
    const { calls, client } = mockApi();
    render(<NewRunForm client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code setup" }));
    const file = new File(["x"], "setup.zip", { type: "application/zip" });
    Object.defineProperty(file, "size", { value: UPLOAD_MAX_BYTES.claude_setup + 1 });
    fireEvent.change(screen.getByLabelText("Your .claude/ setup"), { target: { files: [file] } });
    expect(await screen.findByText(/The Claude Code setup is .* the limit is 25 MB/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Better?" } });
    submit();
    expect(await screen.findByText(/the limit is 25 MB/)).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith("/uploads") || c.path === "/runs")).toBe(false);
  });

  it("multipart sends each part as a slice of the file and completes with the ETags", async () => {
    const content = "0123456789abcdef";
    const { calls, client } = mockApi(
      route("POST", "/uploads", () =>
        json(201, {
          upload: uploadRecord("pending", content.length),
          plan: {
            kind: "multipart",
            part_size_bytes: 10,
            parts: [
              { part_number: 1, offset: 0, size_bytes: 10, url: "https://r2.test/p1", headers: {} },
              { part_number: 2, offset: 10, size_bytes: 6, url: "https://r2.test/p2", headers: {} },
            ],
          },
          expires_at: NOW,
        }),
      ),
      route("POST", `/uploads/${UPLOAD_ID}/complete`, () =>
        json(200, { upload: uploadRecord("complete", content.length) }),
      ),
    );
    const file = new File([content], "tool");
    const whole = vi.spyOn(file, "arrayBuffer");
    const bodies: { url: string; text: string }[] = [];
    const put = async (url: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(Blob);
      bodies.push({ url, text: await (init.body as Blob).text() });
      return new Response(null, { status: 200, headers: { etag: `"e${bodies.length}"` } });
    };
    expect(await uploadFile(client, file, "binary", put)).toBe(UPLOAD_ID);
    expect(whole).not.toHaveBeenCalled();
    expect(bodies).toEqual([
      { url: "https://r2.test/p1", text: "0123456789" },
      { url: "https://r2.test/p2", text: "abcdef" },
    ]);
    expect(calls.find((c) => c.path.endsWith("/complete"))?.body).toEqual({
      parts: [
        { part_number: 1, etag: '"e1"' },
        { part_number: 2, etag: '"e2"' },
      ],
    });
  });

  it("only renders https: card links", () => {
    expect(safeHttpsUrl("https://pay.test/x")).toBe("https://pay.test/x");
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("http://pay.test/x")).toBeNull();
    expect(safeHttpsUrl("nope")).toBeNull();
  });
});

function fillGithub() {
  fireEvent.change(screen.getByLabelText("Repo URL"), {
    target: { value: "https://github.com/jaximus808/tandem" },
  });
  fireEvent.change(screen.getByLabelText("Your question"), {
    target: { value: "Is it faster than plain Claude Code?" },
  });
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Design the test" }));

describe("Ask screen (TDM-101)", () => {
  it("creates the run with an Idempotency-Key and opens its live page", async () => {
    const { calls, client } = mockApi(route("POST", "/runs", () => json(201, { run: run() })));
    render(<NewRunForm client={client} />);
    fillGithub();
    fireEvent.click(screen.getByRole("button", { name: "+ Add a setup" }));
    fireEvent.change(screen.getByLabelText("Setup 2"), { target: { value: "claude-code" } });
    fireEvent.change(screen.getByLabelText("Budget cap (USD)"), { target: { value: "120" } });
    submit();
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
    const create = calls.find((c) => c.path === "/runs" && c.method === "POST");
    expect(create?.headers["idempotency-key"]).toMatch(/^web-new-run-/);
    expect(create?.body).toMatchObject({
      source: { kind: "github", github: "https://github.com/jaximus808/tandem" },
      budget_micro_usd: "120000000",
      contenders: [],
      auto_go: false,
    });
    expect((create?.body as { question: string }).question).toContain(
      "Compare against: claude-code",
    );
  });

  it("redirects to /signin when signed out", async () => {
    const { client } = mockApi(
      route("GET", "/auth/me", () => json(401, { error: { code: "unauthorized", message: "no" } })),
    );
    render(<NewRunForm client={client} />);
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith("/signin?redirect_to=%2Fruns%2Fnew"),
    );
  });

  it("shows field errors and sends nothing when the form is incomplete", async () => {
    const { calls, client } = mockApi();
    render(<NewRunForm client={client} />);
    submit();
    expect(await screen.findByText(/Paste a GitHub repo/)).toBeTruthy();
    expect(screen.getByText(/Ask a question/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/runs")).toBe(false);
  });

  it("reuses the Idempotency-Key when retrying the same form", async () => {
    let n = 0;
    const { calls, client } = mockApi(
      route("POST", "/runs", () =>
        ++n === 1
          ? json(503, { error: { code: "unavailable", message: "down" } })
          : json(201, { run: run() }),
      ),
    );
    render(<NewRunForm client={client} />);
    fillGithub();
    submit();
    expect(await screen.findByText(/couldn't start the run/)).toBeTruthy();
    submit();
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const keys = calls.filter((c) => c.path === "/runs").map((c) => c.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("shows the add-card link on a 402 from the billing gate", async () => {
    const { client } = mockApi(
      route("POST", "/runs", () =>
        json(402, { reason: "no_payment_method", link_card_url: "https://pay.test/link" }),
      ),
    );
    render(<NewRunForm client={client} />);
    fillGithub();
    submit();
    const link = await screen.findByRole("link", { name: "Add a card" });
    expect(link.getAttribute("href")).toBe("https://pay.test/link");
  });

  it("falls back to /billing when the 402 link is not https:", async () => {
    const { client } = mockApi(
      route("POST", "/runs", () =>
        json(402, { reason: "no_payment_method", link_card_url: "http://pay.test/link" }),
      ),
    );
    render(<NewRunForm client={client} />);
    fillGithub();
    submit();
    const link = await screen.findByRole("link", { name: "Go to billing" });
    expect(link.getAttribute("href")).toBe("/billing");
    expect(screen.queryByRole("link", { name: "Add a card" })).toBeNull();
  });

  it("uploads a binary (create → PUT → complete) and sends its upload id", async () => {
    const puts: string[] = [];
    const { calls, client } = mockApi(
      route("POST", "/uploads", () =>
        json(201, {
          upload: {
            id: UPLOAD_ID,
            purpose: "binary",
            filename: "tool",
            content_type: "application/octet-stream",
            size_bytes: 5,
            sha256: "0".repeat(64),
            status: "pending",
            created_at: NOW,
            completed_at: null,
          },
          plan: { kind: "single", method: "PUT", url: "https://r2.test/put", headers: {} },
          expires_at: NOW,
        }),
      ),
      route("POST", `/uploads/${UPLOAD_ID}/complete`, () =>
        json(200, {
          upload: {
            id: UPLOAD_ID,
            purpose: "binary",
            filename: "tool",
            content_type: "application/octet-stream",
            size_bytes: 5,
            sha256: "0".repeat(64),
            status: "complete",
            created_at: NOW,
            completed_at: NOW,
          },
        }),
      ),
      route("POST", "/runs", () => json(201, { run: run() })),
    );
    const put = async (url: string) => {
      puts.push(url);
      return new Response(null, { status: 200 });
    };
    render(<NewRunForm client={client} put={put} />);
    fireEvent.click(screen.getByRole("button", { name: "Binary + docs" }));
    const file = new File(["hello"], "tool", { type: "application/octet-stream" });
    fireEvent.change(screen.getByLabelText("Binary"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Faster?" } });
    submit();
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
    expect(puts).toEqual(["https://r2.test/put"]);
    const plan = calls.find((c) => c.path === "/uploads");
    expect(plan?.body).toMatchObject({ purpose: "binary", filename: "tool", size_bytes: 5 });
    expect((plan?.body as { sha256: string }).sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(calls.find((c) => c.path === "/runs")?.body).toMatchObject({
      source: { kind: "binary", upload_id: UPLOAD_ID },
    });
  });
});

describe("runs list (TDM-101)", () => {
  it("lists the user's runs with links to their live pages", async () => {
    const { client } = mockApi(
      route("GET", "/runs", () =>
        json(200, { items: [run({ spent_micro_usd: "1500000" })], next_cursor: null }),
      ),
    );
    render(<RunsList client={client} />);
    const link = await screen.findByRole("link", { name: "Is it faster than ripgrep?" });
    expect(link.getAttribute("href")).toBe(`/runs/${RUN_ID}`);
    expect(screen.getByText(/\$1\.50 of \$100\.00/)).toBeTruthy();
    expect(screen.getByText("intake").getAttribute("data-tone")).toBe("active");
  });

  it("tones states: accent only while work is live", () => {
    expect(stateTone("running")).toBe("active");
    expect(stateTone("delivered")).toBe("passed");
    expect(stateTone("failed")).toBe("failed");
    expect(stateTone("cancelled")).toBe("infra");
    expect(stateTone("awaiting_go")).toBe("muted");
    expect(stateTone("paused_budget")).toBe("muted");
  });

  it("shows an empty state that points to a new run", async () => {
    const { client } = mockApi(
      route("GET", "/runs", () => json(200, { items: [], next_cursor: null })),
    );
    render(<RunsList client={client} />);
    const link = await screen.findByRole("link", { name: "Start your first run" });
    expect(link.getAttribute("href")).toBe("/runs/new");
  });

  it("redirects to /signin when signed out", async () => {
    const { client } = mockApi(
      route("GET", "/runs", () => json(401, { error: { code: "unauthorized", message: "no" } })),
    );
    render(<RunsList client={client} />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/signin?redirect_to=%2Fruns"));
  });
});
