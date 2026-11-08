// In-memory stand-in for the Tandem 0.2.0 HTTP routes the approver uses, with the same approval
// rules probed live (docs/findings/tandem-approver.md): epics human-only, peer = a different,
// registered agent on a different model, auto = tasks born approved, epic approval cascades.

import { randomUUID } from "node:crypto";

interface Action {
  id: string;
  type: "epic" | "task";
  state: string;
  payload: Record<string, unknown> & { epicId?: string };
  proposedBy: string;
  approvedBy?: string;
  authoredBy: string;
  ticketId?: string;
  createdAt: string;
  updatedAt: string;
}

export class Tdm52FakeTandem {
  policy = "epic";
  crossModel = false;
  code = "";
  readonly actions: Action[] = [];
  readonly agents = new Map<string, string | undefined>();
  readonly calls: string[] = [];
  #ticket = 0;
  #clock = Date.parse("2026-11-08T00:00:00Z");

  /** Advances the fake's clock (createdAt / updatedAt). */
  tickClock(ms: number): void {
    this.#clock += ms;
  }
  #now(): string {
    return new Date(this.#clock).toISOString();
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const h = new Headers(init.headers);
    const cookie = h.get("cookie") ?? "";
    const agent = h.get("x-tandem-agent") ?? "";
    const isHuman = cookie.includes("tandem_session=local") && !agent;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = url.pathname;
    this.calls.push(`${method} ${path}${agent ? ` as ${agent}` : isHuman ? " as human" : ""}`);
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });

    if (method === "GET" && path === "/") {
      return new Response("<html></html>", {
        status: 200,
        headers: { "set-cookie": "tandem_session=local123; Path=/; HttpOnly" },
      });
    }
    if (method === "POST" && path === "/api/canvases") {
      this.code = "FAKE1234";
      return json(201, { id: randomUUID(), code: this.code, approvalPolicy: this.policy });
    }
    if (method === "POST" && path === "/api/mcp/auth") {
      return json(200, { token: isHuman ? "owner-token" : "anon-token", role: "write" });
    }
    if (method === "PATCH" && path.endsWith("/approval-policy")) {
      if (!isHuman) return json(401, { error: "not signed in" });
      this.policy = String(body.approvalPolicy);
      if (typeof body.requireCrossModelReview === "boolean")
        this.crossModel = body.requireCrossModelReview;
      return json(200, { approvalPolicy: this.policy });
    }
    if (!h.get("authorization")?.startsWith("Bearer "))
      return json(401, { error: "missing bearer" });
    if (method === "POST" && path === "/api/canvas/agents") {
      if (body.role !== "planner" && body.role !== "executor")
        return json(400, { error: "bad role" });
      this.agents.set(String(body.name), body.model as string | undefined);
      return json(201, { agentId: randomUUID(), name: body.name });
    }
    if (method === "GET" && path === "/api/canvas/actions") {
      const t = url.searchParams.get("type");
      return json(200, { actions: this.actions.filter((a) => !t || a.type === t) });
    }
    if (method === "POST" && path === "/api/canvas/actions") {
      const type = body.type as "epic" | "task";
      const payload = body.payload as Action["payload"];
      const a: Action = {
        id: randomUUID(),
        type,
        state: "proposed",
        payload,
        proposedBy: "agent",
        authoredBy: agent ? `agent:${agent}` : "anonymous",
        createdAt: this.#now(),
        updatedAt: this.#now(),
      };
      if (type === "task") {
        a.ticketId = `TDM-${++this.#ticket}`;
        const epic = this.actions.find((x) => x.id === payload.epicId);
        if (this.policy === "auto")
          Object.assign(a, { state: "approved", approvedBy: "policy:auto" });
        else if (this.policy === "epic" && epic?.state === "approved") {
          Object.assign(a, { state: "approved", approvedBy: "policy:epic" });
        }
      }
      this.actions.push(a);
      return json(201, a);
    }
    const m = /^\/api\/canvas\/actions\/([^/]+)(?:\/(approve|reject))?$/.exec(path);
    if (m) {
      const a = this.actions.find((x) => x.id === m[1]);
      if (!a) return json(404, { error: "not found" });
      if (!m[2]) return json(200, { action: a });
      if (m[2] === "reject") {
        if (!isHuman) return json(403, { error: "only a signed-in human can reject" });
        Object.assign(a, { state: "rejected", updatedAt: this.#now() });
        return json(200, { action: a });
      }
      let stamp = "human";
      if (!isHuman) {
        if (this.policy !== "peer")
          return json(403, { error: "only a signed-in human can approve an action" });
        if (a.type !== "task") return json(403, { error: "peer_epic_human_only" });
        if (a.authoredBy === `agent:${agent}`) return json(403, { error: "peer_self_approval" });
        if (!this.agents.has(agent)) return json(403, { error: "peer_agent_unregistered" });
        const proposer = this.agents.get(a.authoredBy.replace(/^agent:/, ""));
        if (this.crossModel && proposer && proposer === this.agents.get(agent)) {
          return json(403, { error: "peer_same_model" });
        }
        stamp = `agent:${agent}`;
      }
      if (a.state === "proposed")
        Object.assign(a, { state: "approved", approvedBy: stamp, updatedAt: this.#now() });
      if (a.type === "epic" && (this.policy === "auto" || this.policy === "epic")) {
        for (const t of this.actions) {
          if (t.type === "task" && t.payload.epicId === a.id && t.state === "proposed") {
            Object.assign(t, {
              state: "approved",
              approvedBy: "policy:epic",
              updatedAt: this.#now(),
            });
          }
        }
      }
      return json(200, { action: a });
    }
    return json(404, { error: `no route ${method} ${path}` });
  };
}
