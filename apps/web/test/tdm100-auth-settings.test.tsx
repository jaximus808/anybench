// TDM-100: sign-in, sign-up, header account state and settings, against a mocked API (fetch).
import { ApiClientError } from "@anybench/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "../app/settings/page";
import SignInPage from "../app/signin/page";
import SignUpPage from "../app/signup/page";
import { Header } from "../components/site/Header";
import { apiErrorMessage, githubSignInUrl, safeRedirectPath } from "../lib/api";
import { resetSessionForTests } from "../lib/session";

const API = "/api";
const NOW = "2026-11-07T12:00:00.000Z";
const USER = {
  id: "0190f0a0-0000-7000-8000-000000000001",
  github_login: "octocat",
  email: "octo@example.com",
  avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
  is_admin: false,
  created_at: NOW,
};
const KEY = {
  id: "0190f0a0-0000-7000-8000-0000000000a1",
  name: "laptop CLI",
  prefix: "ab_live_3f9a",
  scopes: ["runs:read"],
  run_ids: null,
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_at: NOW,
};

type Handler = (body: unknown) => { status: number; body?: unknown };
interface Call {
  method: string;
  path: string;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

let routes: Record<string, Handler>;
let calls: Call[];

const json = (status: number, body?: unknown) => ({ status, body });
const unauthorized = () => json(401, { error: { code: "unauthorized", message: "sign in" } });

function mockApi(overrides: Record<string, Handler> = {}) {
  routes = {
    "GET /auth/me": () => json(200, { user: USER, via: { kind: "session" } }),
    "POST /auth/logout": () => json(200, { ok: true }),
    "GET /api-keys": () => json(200, { items: [KEY] }),
    "POST /api-keys": () =>
      json(201, {
        api_key: { ...KEY, id: "0190f0a0-0000-7000-8000-0000000000a2", name: "ci" },
        secret: "ab_live_SECRETsecretSECRET1234",
      }),
    [`DELETE /api-keys/${KEY.id}`]: () => json(200, { api_key: { ...KEY, revoked_at: NOW } }),
    "GET /secrets": () =>
      json(200, {
        items: [{ provider: "anthropic", last4: "AbCd", created_at: NOW, last_used_at: null }],
      }),
    "PUT /secrets/openai": () =>
      json(200, {
        secret: { provider: "openai", last4: "wxyz", created_at: NOW, last_used_at: null },
      }),
    "DELETE /secrets/anthropic": () => json(200, { ok: true }),
    ...overrides,
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    // The browser calls the same-origin proxy: every request goes to /api/*.
    expect(url.startsWith(`${API}/`)).toBe(true);
    const u = new URL(url.slice(API.length), "http://web.test");
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      method: init.method ?? "GET",
      path: u.pathname,
      body,
      credentials: init.credentials,
    });
    const h = routes[key];
    if (!h) return new Response("not found", { status: 404 });
    const r = h(body);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  calls = [];
  resetSessionForTests();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sign-in helpers", () => {
  it("starts GitHub OAuth on the API and lands on /runs/new", () => {
    expect(githubSignInUrl()).toBe("/api/auth/github?redirect_to=%2Fruns%2Fnew");
    expect(githubSignInUrl("/settings", "https://api.example.test/")).toBe(
      "https://api.example.test/auth/github?redirect_to=%2Fsettings",
    );
  });

  it("explains an unreachable API (fetch failed, or the proxy's own 5xx) in one sentence", () => {
    const msg =
      "Can't reach the Anybench API right now. Check your connection and try again in a minute.";
    expect(apiErrorMessage(new TypeError("fetch failed"))).toBe(msg);
    expect(
      apiErrorMessage(
        new ApiClientError({ status: 502, routeId: "auth.me", code: "http_error", message: "x" }),
      ),
    ).toBe(msg);
    expect(
      apiErrorMessage(
        new ApiClientError({
          status: 503,
          routeId: "auth.me",
          code: "unavailable",
          message: "sign-in not configured",
        }),
      ),
    ).toBe("Sign-in not configured");
  });
});

describe("/signin and /signup", () => {
  it("/signin offers Continue with GitHub, an email slot and a link to sign up", async () => {
    mockApi({ "GET /auth/me": unauthorized });
    render(<SignInPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Sign in to Anybench" })).toBeTruthy();
    const gh = screen.getByRole("link", { name: "Continue with GitHub" });
    expect(gh.getAttribute("href")).toBe(`${API}/auth/github?redirect_to=%2Fruns%2Fnew`);
    expect(document.querySelector('[data-slot="email-form"]')).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create an account" }).getAttribute("href")).toBe(
      "/signup",
    );
    await waitFor(() => expect(calls.some((c) => c.path === "/auth/me")).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("/signup uses the same GitHub flow, lands on the add-a-card step, and links back to sign in", () => {
    mockApi({ "GET /auth/me": unauthorized });
    render(<SignUpPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Create your Anybench account" }));
    expect(screen.getByRole("link", { name: "Continue with GitHub" }).getAttribute("href")).toBe(
      `${API}/auth/github?redirect_to=${encodeURIComponent("/billing?welcome=1")}`,
    );
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/signin");
  });

  it("says so when already signed in, with a link to a new run", async () => {
    mockApi();
    render(<SignInPage />);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("octocat");
    expect(within(status).getByRole("link", { name: "Start a new run" }).getAttribute("href")).toBe(
      "/runs/new",
    );
  });

  it("shows a clear error when the API is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    render(<SignInPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Can't reach the Anybench API");
  });

  it("honours a same-origin redirect_to and refuses anything else", async () => {
    mockApi({ "GET /auth/me": unauthorized });
    window.history.pushState({}, "", "/signin?redirect_to=%2Fruns%3Fpage%3D2");
    render(<SignInPage />);
    const gh = screen.getByRole("link", { name: "Continue with GitHub" });
    await waitFor(() =>
      expect(gh.getAttribute("href")).toBe(
        `${API}/auth/github?redirect_to=${encodeURIComponent("/runs?page=2")}`,
      ),
    );
    window.history.pushState({}, "", "/");

    const o = "https://anybench.test";
    expect(safeRedirectPath("/runs", o)).toBe("/runs");
    expect(safeRedirectPath("/runs/abc?x=1#y", o)).toBe("/runs/abc?x=1#y");
    for (const bad of [
      null,
      "",
      "runs",
      "https://evil.test/x",
      "//evil.test",
      "/\\evil.test",
      "/\u0000x",
      "/signin",
      "/signup/",
    ]) {
      expect(safeRedirectPath(bad, o), String(bad)).toBe("/runs/new");
    }
    // Encoded tricks stay on this origin as a plain path, never protocol-relative.
    const enc = safeRedirectPath("/%5Cevil.test", o);
    expect(new URL(enc, o).origin).toBe(o);
    expect(enc.startsWith("//")).toBe(false);
  });

  it("shows GitHub's auth_error from the query string", async () => {
    mockApi({ "GET /auth/me": unauthorized });
    window.history.pushState({}, "", "/signin?auth_error=access_denied");
    render(<SignInPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("cancelled");
    window.history.pushState({}, "", "/");
  });
});

describe("header account state", () => {
  it("signed out: Sign in and Sign up", async () => {
    mockApi({ "GET /auth/me": unauthorized });
    render(<Header />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/signin");
    expect(screen.getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe("/signup");
  });

  it("signed in: the user, New run and Sign out (which calls the API)", async () => {
    mockApi();
    render(<Header />);
    expect((await screen.findByRole("link", { name: "octocat" })).getAttribute("href")).toBe(
      "/settings",
    );
    expect(screen.getByRole("link", { name: "New run" }).getAttribute("href")).toBe("/runs/new");
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy());
    const logout = calls.find((c) => c.path === "/auth/logout");
    expect(logout?.method).toBe("POST");
    expect(logout?.credentials).toBe("include");
  });
});

describe("/settings", () => {
  it("asks a signed-out visitor to sign in", async () => {
    mockApi({ "GET /auth/me": unauthorized });
    render(<SettingsPage />);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe(
      "/signin",
    );
  });

  it("lists API keys, creates one shown once with a copy button, and revokes", async () => {
    mockApi();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SettingsPage />);

    expect(await screen.findByText("laptop CLI")).toBeTruthy();
    expect(screen.getByText("ab_live_3f9a…")).toBeTruthy();

    const form = screen.getByRole("form", { name: "Create an API key" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "ci" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create key" }));

    const secret = await screen.findByLabelText("New API key");
    expect(secret.textContent).toBe("ab_live_SECRETsecretSECRET1234");
    const create = calls.find((c) => c.method === "POST" && c.path === "/api-keys");
    expect(create?.body).toEqual({
      name: "ci",
      scopes: ["runs:read", "runs:write", "events:read", "logs:read"],
      mode: "live",
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ab_live_SECRETsecretSECRET1234"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("ab_live_SECRETsecretSECRET1234")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Revoke laptop CLI" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === `/api-keys/${KEY.id}`)).toBe(
        true,
      ),
    );
    expect(await screen.findByText("Revoked")).toBeTruthy();
  });

  it("stores model keys write-only and shows only last4", async () => {
    mockApi();
    render(<SettingsPage />);
    expect((await screen.findByTestId("anthropic-status")).textContent).toBe(
      "On file, ending AbCd",
    );
    expect(screen.getByTestId("openai-status").textContent).toBe("Not set");

    const input = screen.getByLabelText("OpenAI") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "sk-test-123456wxyz" } });
    fireEvent.click(
      within(screen.getByRole("form", { name: "OpenAI key" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("openai-status").textContent).toBe("On file, ending wxyz"),
    );
    expect(input.value).toBe("");
    expect(calls.find((c) => c.path === "/secrets/openai")?.body).toEqual({
      value: "sk-test-123456wxyz",
    });
    expect(document.body.textContent).not.toContain("sk-test-123456wxyz");

    fireEvent.click(
      within(screen.getByRole("form", { name: "Anthropic key" })).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("anthropic-status").textContent).toBe("Not set"));
  });

  it("toggles 'Start runs automatically' through PATCH /auth/me/settings", async () => {
    let saved = false;
    mockApi({
      "GET /auth/me": () =>
        json(200, { user: USER, via: { kind: "session" }, settings: { auto_start_runs: saved } }),
      "PATCH /auth/me/settings": (body) => {
        saved = (body as { auto_start_runs: boolean }).auto_start_runs;
        return json(200, { auto_start_runs: saved });
      },
    });
    render(<SettingsPage />);
    const box = (await screen.findByLabelText(
      "Start runs automatically when the test plan is proven (no Go button)",
    )) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Billing then starts on its own/)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ auto_start_runs: true });
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(false));
    expect(saved).toBe(false);
  });

  it("signs out from settings", async () => {
    mockApi();
    render(<SettingsPage />);
    const account = await screen.findByRole("region", { name: "Account" });
    expect(within(account).getByText("octocat")).toBeTruthy();
    fireEvent.click(within(account).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/auth/logout")).toBe(true));
  });

  it("every call carries credentials: include", async () => {
    mockApi();
    render(<SettingsPage />);
    await screen.findByTestId("anthropic-status");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.credentials).toBe("include");
  });
});
