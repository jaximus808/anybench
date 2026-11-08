// TDM-27 live check: build the agent-cc env (base + claude-code + tandem) once on a real Naïve
// computer at the agent-cc size (4 vCPU / 8 GiB / 20 GB), then, as the eval user, run
// `claude --version`, the tandem binary (GET /healthz) and the gateway from the warm npx cache.
//
// Runs ONLY with NAIVE_LIVE=1 and NAIVE_API_KEY set, and SPENDS MONEY: 55 200 µ$ per 10-minute
// block at 4/8, so ~0.10-0.20 USD for a ~15 min build. The test refuses to start below a $1
// balance margin, stops the build at TDM27_LIVE_MAX_MS, and fails if the measured spend is over
// $1. Every computer it makes carries `ab-<runId>-`; afterAll destroys those (and only those).
//
//   NAIVE_LIVE=1 node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs run agent-recipes-naive-live
import { createNaiveClientFromEnv, type NaiveClient } from "@anybench/naive";
import { NaiveProvider, trialTag } from "@anybench/providers";
import { afterAll, describe, expect, it } from "vitest";
import { AGENT_CC_RECIPES, runRecipes, type RecipeRunResult } from "../src/index.js";

const live = process.env.NAIVE_LIVE === "1" && !!process.env.NAIVE_API_KEY;
const runId = `ar27${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CAP_MICRO_USD = 1_000_000n; // $1
const MAX_MS = Number(process.env.TDM27_LIVE_MAX_MS ?? 40 * 60_000);
const SPEC = { vcpu: 4, memoryMb: 8192, diskGb: 20 };

let client: NaiveClient | undefined;
let provider: NaiveProvider | undefined;
const tdm27Provider = () => {
  client ??= createNaiveClientFromEnv();
  provider ??= new NaiveProvider({ client });
  return { client, provider };
};
const say = (what: string, data: unknown) => console.log("TDM27-LIVE", what, JSON.stringify(data));

afterAll(async () => {
  if (!live) return;
  const { provider: p } = tdm27Provider();
  const prefix = `ab-${runId}-`;
  for (const c of await p.list({ tagPrefix: prefix })) await p.destroy(c.id).catch(() => undefined);
  const after = await p.list({ tagPrefix: prefix });
  expect(
    after.map((c) => c.id),
    "the live agent-recipes check leaked computers",
  ).toEqual([]);
}, 120_000);

describe.skipIf(!live)("agent-cc recipes on live Naïve", () => {
  it(
    "builds base + claude-code + tandem and the eval user runs claude and tandem",
    async () => {
      const { client: n, provider: p } = tdm27Provider();
      const before = await n.credits.show();
      say("balance-before", {
        at: new Date().toISOString(),
        micro_usd: `${before.balanceMicroUsd}`,
      });
      expect(before.balanceMicroUsd > CAP_MICRO_USD * 2n, "balance too low to run safely").toBe(
        true,
      );

      const t0 = Date.now();
      const c = await p.create({
        name: "tdm27 agent-cc",
        ...SPEC,
        tags: [trialTag(runId, "agentcc")],
      });
      try {
        const ready = await p.waitReady(c.id, { timeoutMs: 300_000, intervalMs: 2_000 });
        say("computer", { id: ready.id, home: ready.home, createMs: Date.now() - t0 });
        const sys = await p.exec(
          c.id,
          "uname -m; . /etc/os-release; echo $PRETTY_NAME; id -un; echo $HOME; df -h / | tail -1; nproc; free -m | sed -n 2p",
        );
        say("system", sys.stdout.trim().split("\n"));

        const deadline = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`build over ${MAX_MS} ms`)), MAX_MS).unref(),
        );
        const res: RecipeRunResult = await Promise.race([
          runRecipes(p, c.id, [...AGENT_CC_RECIPES], {
            runId,
            onEvent: (e) => {
              if (e.type === "computer.recipe") {
                const { recipe, phase, duration_ms, error } = e.payload as {
                  recipe: string;
                  phase: string;
                  duration_ms?: number;
                  error?: string;
                };
                say("recipe", { recipe, phase, duration_ms, ...(error ? { error } : {}) });
              }
            },
          }),
          deadline,
        ]);
        say(
          "results",
          res.results.map((r) => ({
            name: r.name,
            version: r.version,
            status: r.status,
            installMs: r.installMs,
            healthcheckMs: r.healthcheckMs,
          })),
        );
        expect(res.results.every((r) => r.status === "installed" || r.status === "skipped")).toBe(
          true,
        );

        // the done condition, spelled out as the eval user would see it
        const check = await p.exec(
          c.id,
          [
            "sudo -n runuser -u eval -- env -i HOME=/home/eval PATH=/usr/local/bin:/usr/bin:/bin",
            "TANDEM_AUTOSTART=0 bash -c '",
            "set -euo pipefail; cd; id; claude --version; command -v tandem;",
            "d=$(mktemp -d); setsid tandem > $d/log 2>&1 < /dev/null & pid=$!;",
            "for i in $(seq 1 40); do curl -fsS http://127.0.0.1:7891/healthz && break; sleep 0.5; done; echo;",
            "kill -TERM -- -$pid; wait $pid || true; rm -rf $d;",
            "npx --offline -y @jaximus/tandem-mcp@3.2.0 --version'",
          ].join(" "),
          { timeoutMs: 120_000 },
        );
        say("eval-user-check", {
          exitCode: check.exitCode,
          stdout: check.stdout.trim().split("\n"),
          stderr: check.stderr.trim().slice(-2000),
        });
        expect(check.exitCode).toBe(0);
        expect(check.stdout).toMatch(/uid=\d+\(eval\)/);
        expect(check.stdout).toContain("2.1.310 (Claude Code)");
        expect(check.stdout).toContain('{"ok":true,"version":"0.2.0"}');
        expect(check.stdout).toContain("3.2.0");
      } finally {
        await p.destroy(c.id);
        say("destroyed", { id: c.id, lifetimeMs: Date.now() - t0 });
      }

      // ledger debits can land a moment after the destroy; the balance is read once more
      const after = await n.credits.show();
      const spent = before.balanceMicroUsd - after.balanceMicroUsd;
      say("balance-after", {
        at: new Date().toISOString(),
        micro_usd: `${after.balanceMicroUsd}`,
        spent_micro_usd: `${spent}`,
      });
      expect(spent <= CAP_MICRO_USD, `spent ${spent} µ$, cap ${CAP_MICRO_USD}`).toBe(true);
    },
    MAX_MS + 600_000,
  );
});
