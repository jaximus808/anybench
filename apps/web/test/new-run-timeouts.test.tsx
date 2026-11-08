// launch-ux: the New run form never hangs silently. Client deadlines on runs.suggest (20 s, then
// the manual flow, quietly) and runs.create (25 s, then a retry message), gateway failures retried
// with the same Idempotency-Key, and the wait shown in seconds.
import { ApiClientError } from "@anybench/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewRunForm } from "../app/runs/new/NewRunForm";
import {
  ClientTimeoutError,
  createRunWithDeadline,
  formatWait,
  isRetryableCreateError,
  withTimeout,
} from "../app/runs/new/launch";
import { createWebApiClient } from "../lib/api";

const nav = { push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const BASE = "https://api.test";
const NEW_RUN_ID = "0192f5d0-0000-7000-8000-00000000a001";
const NOW = "2026-11-07T21:00:00Z";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
function runRow(over: Record<string, unknown> = {}) {
  return {
    id: NEW_RUN_ID,
    project_id: null,
    question: "q",
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

type Call = { method: string; path: string; headers: Record<string, string>; signal?: AbortSignal };
type Handler = (c: Call) => Response | Promise<Response> | undefined;

/** A fetch that never answers until its signal aborts (a gateway holding the request). */
function hang(signal?: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
  });
}

function mockApi(...handlers: Handler[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? "GET",
      path: url.slice(BASE.length),
      headers: (init.headers ?? {}) as Record<string, string>,
      ...(init.signal ? { signal: init.signal } : {}),
    };
    calls.push(call);
    for (const h of handlers) {
      const r = await h(call);
      if (r) return r;
    }
    if (call.path === "/auth/me") return json(200, ME);
    return json(404, { error: { code: "not_found", message: "no mock" } });
  };
  return { calls, client: createWebApiClient(BASE, { fetch }) };
}

const CREATE_BODY = {
  question: "Is it faster?",
  source: { kind: "github" as const, github: "https://github.com/a/b" },
  budget_micro_usd: 1_000_000n,
  contenders: [],
  auto_go: false,
};

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
});
afterEach(cleanup);

// ---------------------------------------------------------------------------------------------

describe("client deadlines (launch-ux)", () => {
  it("withTimeout aborts the request and throws ClientTimeoutError", async () => {
    let seen: AbortSignal | undefined;
    const p = withTimeout(30, (signal) => {
      seen = signal;
      return hang(signal);
    });
    await expect(p).rejects.toBeInstanceOf(ClientTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it("withTimeout passes a fast answer through", async () => {
    await expect(withTimeout(1000, async () => 7)).resolves.toBe(7);
  });

  it("retries gateway failures with the same Idempotency-Key, then succeeds", async () => {
    let n = 0;
    const { calls, client } = mockApi((c) =>
      c.method === "POST" && c.path === "/runs"
        ? ++n < 3
          ? json(504, { error: { code: "unavailable", message: "gateway timeout" } })
          : json(201, { run: runRow() })
        : undefined,
    );
    const attempts: number[] = [];
    const { run } = await createRunWithDeadline(client, CREATE_BODY, "web-new-run-key-1", {
      timeoutMs: 2000,
      retryDelayMs: 5,
      onAttempt: (a) => attempts.push(a),
    });
    expect(run.id).toBe(NEW_RUN_ID);
    expect(attempts).toEqual([1, 2, 3]);
    const keys = calls.filter((c) => c.path === "/runs").map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["web-new-run-key-1", "web-new-run-key-1", "web-new-run-key-1"]);
  });

  it("gives up at the deadline with ClientTimeoutError", async () => {
    const { client } = mockApi((c) => (c.path === "/runs" ? hang(c.signal) : undefined));
    const t = Date.now();
    await expect(
      createRunWithDeadline(client, CREATE_BODY, "web-new-run-key-2", { timeoutMs: 60 }),
    ).rejects.toBeInstanceOf(ClientTimeoutError);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("does not retry a request the server refused", async () => {
    const { calls, client } = mockApi((c) =>
      c.path === "/runs"
        ? json(422, { error: { code: "validation_failed", message: "bad" } })
        : undefined,
    );
    await expect(
      createRunWithDeadline(client, CREATE_BODY, "web-new-run-key-3", { retryDelayMs: 1 }),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(calls.filter((c) => c.path === "/runs")).toHaveLength(1);
  });

  it("knows which failures are worth a retry", () => {
    const err = (status: number) =>
      new ApiClientError({ status, routeId: "runs.create", code: "http_error", message: "x" });
    expect([408, 502, 503, 504].map((s) => isRetryableCreateError(err(s)))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect([400, 401, 402, 409, 422, 500].some((s) => isRetryableCreateError(err(s)))).toBe(false);
    expect(isRetryableCreateError(new TypeError("Failed to fetch"))).toBe(true);
    expect(formatWait(7_400)).toBe("7 s");
    expect(formatWait(64_000)).toBe("1 min 04 s");
  });
});

// ---------------------------------------------------------------------------------------------

const STEP2 = "What do you want to find out?";
const questionBox = () => screen.getByRole("textbox", { name: STEP2 }) as HTMLTextAreaElement;
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
function toReview() {
  fireEvent.change(screen.getByLabelText("GitHub repo URL"), {
    target: { value: "https://github.com/jaximus808/tandem" },
  });
  next();
  fireEvent.change(questionBox(), { target: { value: "Is Tandem faster?" } });
  next();
  next();
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Design the test" }));

describe("New run form never hangs (launch-ux)", () => {
  it("a hanging create ends in a retry message; the retry reuses the key and opens the run", async () => {
    let n = 0;
    const { calls, client } = mockApi((c) =>
      c.method === "POST" && c.path === "/runs"
        ? ++n === 1
          ? hang(c.signal)
          : json(201, { run: runRow() })
        : undefined,
    );
    render(<NewRunForm client={client} timing={{ createMs: 150, suggestMs: 50 }} />);
    toReview();
    submit();
    // While it waits: the button says so and the seconds count.
    expect(screen.getByRole("button", { name: "Starting…" })).toBeTruthy();
    expect(document.getElementById("nr-start-status")?.textContent).toMatch(
      /Starting the run… Waited 0 s; gives up at 0 s\./,
    );
    expect(await screen.findByText(/didn't answer within/)).toBeTruthy();
    expect(screen.getByText(/can't create a second run/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Design the test" })).toBeTruthy();
    submit();
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/runs/${NEW_RUN_ID}`));
    const creates = calls.filter((c) => c.method === "POST" && c.path === "/runs");
    expect(creates).toHaveLength(2);
    expect(creates[0]!.signal?.aborted).toBe(true);
    expect(creates[0]!.headers["idempotency-key"]).toBe(creates[1]!.headers["idempotency-key"]);
  });

  it("a 504 from the gateway is retried on its own with the same key", async () => {
    let n = 0;
    const { calls, client } = mockApi((c) =>
      c.method === "POST" && c.path === "/runs"
        ? ++n === 1
          ? json(504, { error: { code: "unavailable", message: "gateway timeout" } })
          : json(201, { run: runRow() })
        : undefined,
    );
    render(<NewRunForm client={client} timing={{ retryDelayMs: 5, suggestMs: 50 }} />);
    toReview();
    submit();
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/runs/${NEW_RUN_ID}`));
    const keys = calls.filter((c) => c.path === "/runs").map((c) => c.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("a hanging suggest is aborted at its deadline and the flow carries on quietly", async () => {
    const { calls, client } = mockApi((c) =>
      c.path === "/runs/suggest" ? hang(c.signal) : undefined,
    );
    render(<NewRunForm client={client} timing={{ suggestMs: 80 }} />);
    fireEvent.change(screen.getByLabelText("GitHub repo URL"), {
      target: { value: "https://github.com/jaximus808/tandem" },
    });
    next();
    expect(screen.getByText(/Reading your repo/)).toBeTruthy();
    expect(screen.getByText("0 s")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Reading your repo/)).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    const suggest = calls.find((c) => c.path === "/runs/suggest");
    expect(suggest?.signal?.aborted).toBe(true);
    // The manual flow: example questions to pick from.
    expect(questionBox()).toBeTruthy();
  });
});
