// TDM-41 [4.9]: trialJobFromKit gives a contender's adapters everything the kit says they get,
// because anybench.yaml never reaches the subject computer: `versions`, `driver.model`, a
// harness's human_in_loop and cap, driver.env and the `vary` setup. Checked against the real
// flagship kit's contender C (Tandem) and its ×1 / ×3 / ×5 setups.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeParseKitSpec, type KitSpec } from "@anybench/core";
import { expandVarySetups } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { trialJobFromKit } from "../src/index.js";

const REPO_TDM41 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function flagshipTdm41(): KitSpec {
  const text = readFileSync(
    path.join(REPO_TDM41, "kits/tandem-vs-claude-code/anybench.yaml"),
    "utf8",
  );
  const r = safeParseKitSpec(parse(text));
  if (!r.success) throw new Error(r.errors.join("\n"));
  return r.data;
}

describe("trialJobFromKit on kits/tandem-vs-claude-code", () => {
  const kit = flagshipTdm41();

  it("expands vary only for Tandem: ×1, ×3, ×5", () => {
    expect(expandVarySetups(kit, "tandem").map((s) => [s.setupId, s.env])).toEqual([
      ["tandem@TANDEM_WORKERS=1", { TANDEM_WORKERS: "1" }],
      ["tandem@TANDEM_WORKERS=3", { TANDEM_WORKERS: "3" }],
      ["tandem@TANDEM_WORKERS=5", { TANDEM_WORKERS: "5" }],
    ]);
    expect(expandVarySetups(kit, "claude-code-solo").map((s) => s.setupId)).toEqual([
      "claude-code-solo",
    ]);
  });

  it("contender C gets versions, the model, the approver policy, the proxy settings and its setup", () => {
    const c = kit.contenders.find((x) => x.id === "tandem")!;
    for (const s of expandVarySetups(kit, "tandem")) {
      const job = trialJobFromKit(kit, "tandem", "todo-api", s.env);
      expect(job.env).toMatchObject({
        ...c.versions,
        ...c.driver.env,
        ANYBENCH_MODEL: "anthropic/claude-sonnet-4.6",
        CC_MODEL: "anthropic/claude-sonnet-4.6",
        ANYBENCH_HIL_KIND: "tandem",
        ANYBENCH_HIL_POLICY: kit.human_in_loop!.policy,
        ANYBENCH_WALL_CAP_S: String(job.wall_clock_s),
        AB_TOKEN_SOURCE: "naive_proxy",
        TANDEM_WORKERS: s.env.TANDEM_WORKERS,
      });
      expect(job.env?.TANDEM_MCP_VERSION).toBe("3.2.0");
      expect(job.env?.CLAUDE_CODE_VERSION).toBe("2.1.319");
    }
  });

  it("a Claude Code contender gets its versions and model but no harness env", () => {
    const job = trialJobFromKit(kit, "claude-code-solo", "todo-api");
    expect(job.env?.CLAUDE_CODE_VERSION).toBe("2.1.319");
    expect(job.env?.CC_MODEL).toBe("anthropic/claude-sonnet-4.6");
    expect(job.env).not.toHaveProperty("ANYBENCH_HIL_POLICY");
    expect(job.env).not.toHaveProperty("TANDEM_WORKERS");
  });
});
