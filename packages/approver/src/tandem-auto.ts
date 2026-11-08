// auto: `PATCH /api/canvases/{code}/approval-policy {approvalPolicy:"auto"}` once per trial canvas.
// Tasks are then born approved and stamped `policy:auto`; the approver only counts them. Epics stay
// human-only in Tandem, so the human-sim session approves each epic.

import type { TandemClient } from "./tandem-client.js";
import type { HumanSession } from "./tandem-human-sim.js";

export async function applyAutoPolicy(client: TandemClient, human: HumanSession): Promise<void> {
  await client.setApprovalPolicy(human.canvasCode, human.cookie, "auto");
}
