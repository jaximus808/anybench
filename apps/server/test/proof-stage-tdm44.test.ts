// TDM-44 [4.12] server wiring: proofStage (PipelinePort.prove).
//   - the curated Tandem kit keeps curatedProof (its signed-off offline proof, unchanged);
//   - any other kit is loaded from kits.files_url and goes through the six-check suite on the run's
//     env, with every computer swept after;
//   - a kit that holds a secret fails no_secret_in_kit and never reaches the runner;
//   - our infra failure holds the run instead of blaming (and repairing) the kit;
//   - configuredSecretValues picks the worker's secrets by name, never ordinary settings.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROOF_CHECKS, type ProofCheckResult } from "@anybench/core";
import { loadKit, ProofInfraError, readBundle, writeBundle, type ProofRunner } from "@anybench/kit";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { configuredSecretValues, failedChecksSummary, proofStage } from "../src/jobs/proof.js";
import { CURATED_TANDEM_KIT, defaultKitsDir } from "../src/orchestrator/curated.js";
import type { StageContext } from "../src/orchestrator/ports.js";

const CLI = fileURLToPath(new URL("../../../packages/kit/examples/cli/", import.meta.url));
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function kitCopy(): string {
  const d = mkdtempSync(path.join(tmpdir(), "tdm44-stage-"));
  temps.push(d);
  cpSync(CLI, d, { recursive: true });
  return d;
}

function ctxTdm44(): StageContext & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    run: { id: "0195f3a2-7c1e-7d3a-9b1c-1234567890ab" } as StageContext["run"],
    idempotencyKey: "tdm44:proof:1",
    signal: new AbortController().signal,
    async emit(events) {
      for (const e of events) said.push((e.payload as { text: string }).text);
    },
  };
}

/** A runner where every gate passes unless the trial ran a do-less overlay; records calls. */
function fakeRunnerTdm44(opts: { infra?: boolean } = {}) {
  const calls: string[] = [];
  let swept = 0;
  const runner: ProofRunner & { sweep: () => Promise<string[]> } = {
    async runTrial(req) {
      calls.push(req.label);
      if (opts.infra) throw new ProofInfraError("naive forbidden (403) on fork");
      const doLess =
        req.overlay?.id === "truncated-output" || req.overlay?.id === "first-match-only";
      const slow = req.overlay?.id === "planted-delay";
      return {
        status: "ok",
        detail: "fake",
        bundle: writeBundle(
          new Map([["cli/stdout.txt", new TextEncoder().encode(doLess ? "x" : "ok")]]),
        ),
        metrics: [
          { name: "wall_s", value: slow ? 0.4 : 0.01, gate_id: "same-matches", level: "trial" },
          { name: "peak_rss_bytes", value: 1000, gate_id: "same-matches", level: "trial" },
        ],
      };
    },
    async runGates(req) {
      calls.push(req.label);
      const out = req.bundle ? readBundle(req.bundle).get("cli/stdout.txt") : undefined;
      const ok = out !== undefined && new TextDecoder().decode(out) === "ok";
      return {
        gates: Object.fromEntries(
          req.gateIds.map((g) => [
            g,
            {
              pass: ok,
              reason: ok ? "equal" : "differs",
              applicable: true,
              status: "verdict",
              kit_suspect: false,
            },
          ]),
        ),
      };
    },
    async sweep() {
      swept++;
      return [];
    },
  };
  return { runner, calls, swept: () => swept };
}

const ENV = {
  env_id: "snap-subject",
  detail: { scoring_snapshot_id: "snap-scoring", kit_dir: "kit" },
};
const db = {} as Database;

describe("proofStage (TDM-44)", () => {
  it("the curated Tandem kit keeps its curated offline proof", async () => {
    const dir = path.join(defaultKitsDir(), CURATED_TANDEM_KIT);
    const kit = await loadKit(dir);
    const fake = fakeRunnerTdm44();
    const prove = proofStage({
      db,
      provider: null,
      kitFilesUrl: async () => pathToFileURL(dir).href,
      runner: () => fake.runner,
    });
    const r = await prove(ctxTdm44(), { kit_id: "k1", kit: kit.spec, env: ENV });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.value)).toBe(false);
    expect((r.value as { basis: string }).basis).toBe("curated");
    expect(fake.calls).toEqual([]);
  });

  it("a generated kit runs the six checks on the run's env and is swept after", async () => {
    const dir = kitCopy();
    const kit = await loadKit(dir);
    const fake = fakeRunnerTdm44();
    const ctx = ctxTdm44();
    const prove = proofStage({
      db,
      provider: null,
      kitFilesUrl: async () => pathToFileURL(dir).href,
      runner: () => fake.runner,
    });
    const r = await prove(ctx, { kit_id: "k2", kit: kit.spec, env: ENV });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const checks = r.value as ProofCheckResult[];
    expect(checks.map((c) => c.check)).toEqual([...PROOF_CHECKS]);
    expect(
      checks.filter((c) => !c.pass),
      JSON.stringify(checks),
    ).toEqual([]);
    expect(fake.swept()).toBe(1);
    expect(ctx.said.at(-1)).toMatch(/^proof: all six checks passed/);
  });

  it("a kit with an sk-ant- key fails no_secret_in_kit and nothing runs", async () => {
    const dir = kitCopy();
    const f = path.join(dir, "adapters/gnu-grep/install.sh");
    writeFileSync(
      f,
      `${readFileSync(f, "utf8")}\nexport KEY=${["sk", "ant", "api03", "tdm44serverFAKE00000000"].join("-")}\n`,
    );
    const kit = await loadKit(dir);
    const fake = fakeRunnerTdm44();
    const prove = proofStage({
      db,
      provider: null,
      kitFilesUrl: async () => pathToFileURL(dir).href,
      runner: () => fake.runner,
    });
    const r = await prove(ctxTdm44(), { kit_id: "k3", kit: kit.spec, env: ENV });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const checks = r.value as ProofCheckResult[];
    expect(checks.find((c) => c.check === "no_secret_in_kit")).toMatchObject({ pass: false });
    expect(failedChecksSummary(checks)).toMatch(/^oracle_passes \(not run: the kit holds a secret/);
    expect(fake.calls).toEqual([]);
  });

  it("our infra failure holds the run; it is not the kit's fault", async () => {
    const dir = kitCopy();
    const kit = await loadKit(dir);
    const fake = fakeRunnerTdm44({ infra: true });
    const prove = proofStage({
      db,
      provider: null,
      kitFilesUrl: async () => pathToFileURL(dir).href,
      runner: () => fake.runner,
    });
    const r = await prove(ctxTdm44(), { kit_id: "k4", kit: kit.spec, env: ENV });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(
      /^proof could not run \(ours, not the kit\): .*naive forbidden \(403\) on fork/,
    );
    expect(fake.swept()).toBe(1);
  });

  it("holds without an env image or a file:// kit", async () => {
    const dir = kitCopy();
    const kit = await loadKit(dir);
    const prove = proofStage({
      db,
      provider: null,
      kitFilesUrl: async () => pathToFileURL(dir).href,
      runner: () => fakeRunnerTdm44().runner,
    });
    const noEnv = await prove(ctxTdm44(), { kit_id: "k5", kit: kit.spec, env: null });
    expect(noEnv.ok).toBe(false);
    const upload = proofStage({ db, provider: null, kitFilesUrl: async () => "upload:abc" });
    const r = await upload(ctxTdm44(), { kit_id: "k6", kit: kit.spec, env: ENV });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("is neither file:// nor artifact:");
  });

  it("configuredSecretValues takes secrets by name only", () => {
    const v = configuredSecretValues(
      {
        NAIVE_API_KEY: "nv-0123456789",
        PORT: 8787,
        LOG_LEVEL: "info",
        ANYBENCH_KITS_DIR: "/srv/kits/long-path",
        SESSION_SECRET: "s".repeat(32),
      },
      {
        ANTHROPIC_API_KEY: "a-very-long-anthropic-value",
        HOME: "/Users/someone-long",
        SHORT_TOKEN: "abc",
      },
    );
    expect(v.sort()).toEqual(
      ["a-very-long-anthropic-value", "nv-0123456789", "s".repeat(32)].sort(),
    );
  });
});
