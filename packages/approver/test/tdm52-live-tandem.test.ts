// Live: each policy against a real local Tandem server (TANDEM_AUTH=none), started here on its own
// port with a throwaway TANDEM_DATA_DIR. Opt in with TANDEM_BIN=/path/to/tandem. Never touches a
// Tandem you already run. The llm-reviewer case uses a scripted reviewer (no Naïve spend).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPROVER_POLICIES,
  ApproverConfigSchema,
  TandemClient,
  createTandemApprover,
  readApprovals,
  type Reviewer,
} from "../src/index.js";
import { tdm52ProposeEpic } from "./tdm52-planner.js";

const BIN = process.env.TANDEM_BIN;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() =>
        typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port")),
      );
    });
  });
}

describe.skipIf(!BIN)("approver against a live local Tandem", () => {
  let proc: ChildProcess;
  let dir: string;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tdm52-live-"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn(BIN!, [], {
      env: {
        ...process.env,
        TANDEM_DATA_DIR: join(dir, "data"),
        PORT: String(port),
        TANDEM_AUTH: "none",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("tandem did not come up");
  }, 30_000);

  afterAll(() => {
    proc?.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  const reviewer: Reviewer = {
    decidedBy: "agent:anybench-reviewer",
    review: () => Promise.resolve({ decision: "approve", reason: "scoped step toward the goal" }),
  };

  for (const policy of APPROVER_POLICIES) {
    it(`${policy}: the planner's epic and every task end approved, each decision logged as simulated`, async () => {
      const out = join(dir, policy);
      const approver = createTandemApprover({
        baseUrl: base,
        config: ApproverConfigSchema.parse({
          kind: "tandem",
          policy,
          ...(policy === "llm-reviewer" ? { reviewer_model: "gpt-5" } : {}),
        }),
        outDir: out,
        trialId: `live-${policy}`,
        contenderId: "tandem",
        ...(policy === "llm-reviewer" ? { reviewer, subjectModels: ["claude-opus-4-8"] } : {}),
      });
      const { canvasCode } = await approver.prepare();
      await tdm52ProposeEpic(base, canvasCode, { model: "claude-opus-4-8", tasks: 3 });

      const stop = new AbortController();
      const loop = approver.run({ signal: stop.signal, pollMs: 200 });
      const client = new TandemClient({ baseUrl: base });
      const cookie = await client.humanCookie();
      const human = { token: await client.canvasToken(canvasCode, cookie), cookie };
      let actions = await client.listActions(human);
      for (
        let i = 0;
        i < 100 && !(actions.length === 4 && actions.every((a) => a.state === "approved"));
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
        actions = await client.listActions(human);
      }
      // Let one more tick count the last cascade, then stop.
      await new Promise((r) => setTimeout(r, 400));
      stop.abort();
      await loop;

      expect(actions.map((a) => a.state)).toEqual(["approved", "approved", "approved", "approved"]);
      const stamps = actions.filter((a) => a.type === "task").map((a) => a.approvedBy);
      const expected = {
        auto: "policy:auto",
        "human-sim": "policy:epic",
        "llm-reviewer": "agent:anybench-reviewer",
      }[policy];
      expect(stamps).toEqual([expected, expected, expected]);
      expect(actions.find((a) => a.type === "epic")?.approvedBy).toBe("human");

      const events = readApprovals(join(out, "approvals.jsonl"));
      expect(events).toHaveLength(4);
      expect(events.every((e) => e.simulated && e.policy === policy)).toBe(true);
      expect(approver.summary()).toMatchObject({ label: "simulated approvals", approvals: 4 });
    }, 60_000);
  }
});
