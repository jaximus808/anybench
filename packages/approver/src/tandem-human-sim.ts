// human-sim: the local-cookie path. `GET /` sets `tandem_session` (local mode mints the owner's
// session on the HTML response), `POST /api/mcp/auth {code}` with that cookie returns the owner's
// bearer, and `POST /api/canvas/actions/{id}/approve|reject` with both is a human decision.
// Needed for EPIC approval under every policy: Tandem keeps epics human-only, even on 'peer'.
// Tandem stamps these `approvedBy: "human"`; our log labels them simulated (decided_by human-sim).

import type { TandemClient, TandemIdentity } from "./tandem-client.js";

export interface HumanSession extends TandemIdentity {
  cookie: string;
  canvasCode: string;
}

/** Opens the human session. Creates a fresh trial canvas unless `canvasCode` is given. */
export async function openHumanSession(
  client: TandemClient,
  opts: { canvasCode?: string; canvasName?: string },
): Promise<HumanSession> {
  const cookie = await client.humanCookie();
  const canvasCode =
    opts.canvasCode ??
    (await client.createCanvas(opts.canvasName ?? "anybench trial", cookie)).code;
  const token = await client.canvasToken(canvasCode, cookie);
  return { cookie, token, canvasCode };
}

/** human-sim keeps Tandem's 'epic' policy: approving an epic cascades to its tasks (`policy:epic`). */
export async function applyHumanSimPolicy(
  client: TandemClient,
  human: HumanSession,
): Promise<void> {
  await client.setApprovalPolicy(human.canvasCode, human.cookie, "epic");
}

export async function humanApprove(client: TandemClient, human: HumanSession, actionId: string) {
  return client.approve({ token: human.token, cookie: human.cookie }, actionId);
}

export async function humanReject(
  client: TandemClient,
  human: HumanSession,
  actionId: string,
  reason: string,
): Promise<void> {
  await client.reject({ token: human.token, cookie: human.cookie }, actionId, reason);
}
