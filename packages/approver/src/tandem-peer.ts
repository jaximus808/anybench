// llm-reviewer: Tandem's 'peer' policy with requireCrossModelReview on. A reviewer agent registered
// on the board under a different model approves tasks through the agent door (X-Tandem-Agent), so
// the board stamps `agent:<name>` (the same door the MCP `task_review pass` uses). Tandem refuses a
// peer reject and a peer epic approval, so those go through the human-sim session, still decided
// by the reviewer and logged with decided_by agent:<name>.

import type { TandemClient, TandemIdentity } from "./tandem-client.js";
import type { HumanSession } from "./tandem-human-sim.js";

export interface PeerReviewerIdentity extends TandemIdentity {
  agent: string;
}

export async function applyPeerPolicy(
  client: TandemClient,
  human: HumanSession,
  reviewer: { name: string; model: string },
): Promise<PeerReviewerIdentity> {
  await client.setApprovalPolicy(human.canvasCode, human.cookie, "peer", true);
  // An anonymous canvas token (no cookie) + the identity header = an agent, not the owner.
  const token = await client.canvasToken(human.canvasCode);
  const id: PeerReviewerIdentity = { token, agent: reviewer.name };
  // Tandem roles are planner | executor; a reviewer registers as an executor that claims nothing.
  await client.registerAgent(id, reviewer.name, "executor", reviewer.model);
  return id;
}

export async function peerApprove(
  client: TandemClient,
  reviewer: PeerReviewerIdentity,
  actionId: string,
) {
  return client.approve(reviewer, actionId);
}
