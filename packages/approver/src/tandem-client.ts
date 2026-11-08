// Minimal HTTP client for a local Tandem server (TANDEM_AUTH=none), covering what the approver
// needs. Verified against tandem 0.2.0; see docs/findings/tandem-approver.md.
//
// Identities on Tandem's API:
//   human  = a `tandem_session` cookie (minted by `GET /` in local mode) and no X-Tandem-Agent header
//   agent  = an `X-Tandem-Agent: <name>` header (registered via POST /api/canvas/agents)
// Every /api/canvas/* call also needs `Authorization: Bearer <token>` from POST /api/mcp/auth {code}.

import { z } from "zod";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const TandemActionSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string(),
  state: z.string(),
  payload: z
    .looseObject({
      title: z.string().optional(),
      body: z.string().optional(),
      epicId: z.string().optional(),
    })
    .default({}),
  approvedBy: z.string().optional(),
  authoredBy: z.string().optional(),
  ticketId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TandemAction = z.infer<typeof TandemActionSchema>;

const CanvasSchema = z.looseObject({
  id: z.string(),
  code: z.string().min(1),
  approvalPolicy: z.string().optional(),
});
const TokenSchema = z.looseObject({ token: z.string().min(1), role: z.string() });

export class TandemHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "TandemHttpError";
  }
}

export interface TandemClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
}

/** A human (cookie) or agent (header) identity bound to one canvas. */
export interface TandemIdentity {
  token: string;
  cookie?: string;
  agent?: string;
}

export class TandemClient {
  readonly baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: TandemClientOptions) {
    this.baseUrl = z.url().parse(options.baseUrl).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((i, init) => fetch(i, init));
  }

  async #call(
    method: string,
    path: string,
    opts: { body?: unknown; cookie?: string; token?: string; agent?: string } = {},
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.agent) headers["x-tandem-agent"] = opts.agent;
    const res = await this.#fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      redirect: "manual",
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 400) {
      const err = z
        .looseObject({ error: z.string().optional(), message: z.string().optional() })
        .safeParse(json);
      const code = err.success ? err.data.error : undefined;
      const msg = err.success ? (err.data.message ?? err.data.error) : text.slice(0, 200);
      throw new TandemHttpError(
        `${method} ${path} → ${res.status}: ${msg ?? ""}`,
        res.status,
        code,
      );
    }
    return { status: res.status, json, headers: res.headers };
  }

  /** Local mode: `GET /` sets the local owner's `tandem_session` cookie. Returns `name=value`. */
  async humanCookie(): Promise<string> {
    const res = await this.#fetch(`${this.baseUrl}/`, { method: "GET", redirect: "manual" });
    await res.text();
    const raw = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
    for (const c of raw) {
      const m = /(?:^|,\s*)(tandem_session=[^;]+)/.exec(c);
      if (m?.[1]) return m[1];
    }
    throw new TandemHttpError(
      "GET / did not set tandem_session (is the server in local mode, TANDEM_AUTH=none?)",
      res.status,
      "no_session_cookie",
    );
  }

  async createCanvas(name: string, cookie: string): Promise<{ id: string; code: string }> {
    const { json } = await this.#call("POST", "/api/canvases", { body: { name }, cookie });
    return CanvasSchema.parse(json);
  }

  /** Bearer for `/api/canvas/*`. With the cookie it is the owner's; without, an anonymous write token. */
  async canvasToken(code: string, cookie?: string): Promise<string> {
    const { json } = await this.#call("POST", "/api/mcp/auth", {
      body: { code },
      ...(cookie ? { cookie } : {}),
    });
    return TokenSchema.parse(json).token;
  }

  /** Owner-only: `PATCH /api/canvases/{code}/approval-policy`. */
  async setApprovalPolicy(
    code: string,
    cookie: string,
    policy: "strict" | "epic" | "auto" | "peer",
    requireCrossModelReview?: boolean,
  ): Promise<void> {
    await this.#call("PATCH", `/api/canvases/${encodeURIComponent(code)}/approval-policy`, {
      body: {
        approvalPolicy: policy,
        ...(requireCrossModelReview !== undefined ? { requireCrossModelReview } : {}),
      },
      cookie,
    });
  }

  async registerAgent(
    id: TandemIdentity,
    name: string,
    role: "planner" | "executor",
    model?: string,
  ): Promise<string> {
    const { json } = await this.#call("POST", "/api/canvas/agents", {
      body: { name, role, ...(model ? { model } : {}) },
      token: id.token,
      agent: name,
    });
    return z.looseObject({ agentId: z.string() }).parse(json).agentId;
  }

  async listActions(
    id: TandemIdentity,
    query: { state?: string; type?: string } = {},
  ): Promise<TandemAction[]> {
    const qs = new URLSearchParams();
    if (query.state) qs.set("state", query.state);
    if (query.type) qs.set("type", query.type);
    const q = qs.toString();
    const { json } = await this.#call(
      "GET",
      `/api/canvas/actions${q ? `?${q}` : ""}`,
      this.#auth(id),
    );
    return z.object({ actions: z.array(TandemActionSchema).nullable() }).parse(json).actions ?? [];
  }

  async getAction(id: TandemIdentity, actionId: string): Promise<TandemAction> {
    const { json } = await this.#call(
      "GET",
      `/api/canvas/actions/${encodeURIComponent(actionId)}`,
      this.#auth(id),
    );
    return z.object({ action: TandemActionSchema }).parse(json).action;
  }

  async approve(id: TandemIdentity, actionId: string): Promise<TandemAction> {
    const { json } = await this.#call(
      "POST",
      `/api/canvas/actions/${encodeURIComponent(actionId)}/approve`,
      this.#auth(id),
    );
    return z.object({ action: TandemActionSchema }).parse(json).action;
  }

  async reject(id: TandemIdentity, actionId: string, reason: string): Promise<void> {
    await this.#call("POST", `/api/canvas/actions/${encodeURIComponent(actionId)}/reject`, {
      ...this.#auth(id),
      body: { reason },
    });
  }

  /** Agent-side propose (used by tests that play the planner). */
  async propose(
    id: TandemIdentity,
    type: "epic" | "task",
    payload: Record<string, unknown>,
  ): Promise<TandemAction> {
    const { json } = await this.#call("POST", "/api/canvas/actions", {
      ...this.#auth(id),
      body: { type, payload },
    });
    return TandemActionSchema.parse(json);
  }

  #auth(id: TandemIdentity): { token: string; cookie?: string; agent?: string } {
    return {
      token: id.token,
      ...(id.cookie ? { cookie: id.cookie } : {}),
      ...(id.agent ? { agent: id.agent } : {}),
    };
  }
}
