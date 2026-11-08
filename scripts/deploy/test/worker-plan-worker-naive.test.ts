// worker-naive: the worker deploy's env, env file, naming, decisions, cost and host scripts.
import { spawnSync } from "node:child_process";
import { INFRA_COMPUTER_TAG_PREFIX } from "@anybench/envs";
import { NAIVE_COMPUTER_LIMITS, type NaiveComputer } from "@anybench/naive";
import { encodeNaiveComputerName } from "@anybench/providers";
import { describe, expect, it } from "vitest";
import {
  asWorkerComputer,
  bootstrapCommand,
  curlConfig,
  decideDeploy,
  decideRotate,
  envFingerprint,
  LIFETIME_MARGIN_MS,
  liveWorkers,
  parseEnvFile,
  parseWorkerDeployEnv,
  planWorkerEnv,
  renderBootstrap,
  renderEnvFile,
  retireAtMs,
  WORKER_TAG,
  workerComputerName,
  workerCost,
  type WorkerComputer,
} from "../lib/worker-plan.js";

const SECRETS = {
  NAIVE_API_KEY: "sk_live_naive_SECRET_wn1",
  DATABASE_URL: "postgres://u:PW_POOLED_wn1@ep-dev-1-pooler.us-west-2.aws.neon.tech/db",
  DATABASE_URL_DIRECT: "postgres://u:PW_DIRECT_wn1@ep-dev-1.us-west-2.aws.neon.tech/db",
  S3_SECRET_ACCESS_KEY: "s3-SECRET-wn1",
  RUNNER_TOKEN_SECRET: "runner-token-secret-wn1-0123456789abcdef",
  STRIPE_TEST_SECRET_KEY: "sk_test_SECRET_wn1",
};
const baseEnv = (over: Record<string, string> = {}) => ({
  ...SECRETS,
  S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  S3_REGION: "auto",
  S3_BUCKET: "anybench-artifacts",
  S3_ACCESS_KEY_ID: "AKIA-wn1",
  PUBLIC_API_URL: "https://api.example.test",
  // Present in .env but not the worker's business.
  GITHUB_CLIENT_SECRET: "gh-client-SECRET-wn1",
  SESSION_SECRET: "session-SECRET-wn1-0123456789abcdef0123",
  ...over,
});

describe("parseWorkerDeployEnv", () => {
  it("accepts a dev env with defaults for the deploy settings", () => {
    const env = parseWorkerDeployEnv(baseEnv());
    expect(env.DEPLOY_WORKER_VCPU).toBe(1);
    expect(env.DEPLOY_WORKER_MEMORY_MB).toBe(2048);
    expect(env.DEPLOY_WORKER_ROTATE_AFTER_HOURS).toBe(10);
  });

  const failure = (over: Record<string, string>) => {
    try {
      parseWorkerDeployEnv(baseEnv(over));
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  };

  it("refuses billing off, the prod branch and a pooled direct URL, all at once, by name only", () => {
    const msg = failure({
      BILLING_MODE: "off",
      DATABASE_URL_PROD: SECRETS.DATABASE_URL,
      DATABASE_URL_DIRECT: "postgres://u:PW_DIRECT_wn1@ep-dev-1-pooler.us-west-2.aws.neon.tech/db",
    });
    expect(msg).toContain("BILLING_MODE");
    expect(msg).toContain("DATABASE_URL: points at the prod branch");
    expect(msg).toContain("pooled");
    for (const v of Object.values(SECRETS)) expect(msg).not.toContain(v);
  });

  it("needs the artifact store (the release travels through it)", () => {
    expect(failure({ S3_BUCKET: "", S3_SECRET_ACCESS_KEY: "" })).toMatch(
      /S3_BUCKET[\s\S]*S3_SECRET_ACCESS_KEY/,
    );
  });
});

describe("planWorkerEnv + renderEnvFile", () => {
  it("carries what the worker reads and nothing the API alone needs", () => {
    const vars = planWorkerEnv(parseWorkerDeployEnv(baseEnv()));
    expect(vars).toMatchObject({
      NODE_ENV: "production",
      BILLING_MODE: "test",
      DATABASE_URL_DIRECT: SECRETS.DATABASE_URL_DIRECT,
      NAIVE_API_KEY: SECRETS.NAIVE_API_KEY,
      STRIPE_SECRET_KEY: SECRETS.STRIPE_TEST_SECRET_KEY,
      PUBLIC_API_URL: "https://api.example.test",
    });
    expect(Object.keys(vars)).not.toContain("GITHUB_CLIENT_SECRET");
    expect(Object.keys(vars)).not.toContain("SESSION_SECRET");
    expect(Object.keys(vars)).not.toContain("DATABASE_URL_DIRECT_PROD");
  });

  it("live: needs a live key and gives the worker that key with BILLING_MODE=live", () => {
    const failure = (over: Record<string, string>) => {
      try {
        parseWorkerDeployEnv(baseEnv(over));
      } catch (err) {
        return (err as Error).message;
      }
      return "";
    };
    expect(failure({ BILLING_MODE: "live" })).toMatch(/STRIPE_LIVE_SECRET_KEY: is required/);
    expect(failure({ BILLING_MODE: "live", STRIPE_LIVE_SECRET_KEY: "sk_test_x" })).toMatch(
      /STRIPE_LIVE_SECRET_KEY/,
    );
    const vars = planWorkerEnv(
      parseWorkerDeployEnv(
        baseEnv({ BILLING_MODE: "live", STRIPE_LIVE_SECRET_KEY: "sk_live_LIVE_wn1" }),
      ),
    );
    expect(vars.BILLING_MODE).toBe("live");
    expect(vars.STRIPE_SECRET_KEY).toBe("sk_live_LIVE_wn1");
  });

  it("DEPLOY_WORKER_PUBLIC_API_URL overrides the runner ingest base", () => {
    const vars = planWorkerEnv(
      parseWorkerDeployEnv(baseEnv({ DEPLOY_WORKER_PUBLIC_API_URL: "https://api-2.example.test" })),
    );
    expect(vars.PUBLIC_API_URL).toBe("https://api-2.example.test");
  });

  it("round-trips awkward values through node's env-file parser", () => {
    const vars = {
      A: "plain",
      B: "has # hash and spaces",
      C: "dollar $HOME and `ticks`",
      D: "single ' quote",
      E: 'double " quote',
      F: "",
    };
    expect(parseEnvFile(renderEnvFile(vars))).toEqual(vars);
    expect(() => renderEnvFile({ G: "line\nbreak" })).toThrow(/G: a newline/);
    expect(() => renderEnvFile({ H: `both ' and "` })).toThrow(/H: holds both/);
  });

  it("fingerprints the env file without exposing it", () => {
    const file = renderEnvFile(
      planWorkerEnv(parseWorkerDeployEnv(baseEnv())) as Record<string, string>,
    );
    const fp = envFingerprint(file);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(envFingerprint(`${file}X=1\n`)).not.toBe(fp);
  });
});

const computer = (name: string, createdAt: string, status: NaiveComputer["status"] = "running") =>
  ({
    id: `cmp_${createdAt.replace(/\D/g, "")}`,
    name,
    vcpu: 1,
    memoryMb: 2048,
    diskGb: 10,
    status,
    snapshotId: null,
    agentId: null,
    createdAt,
  }) satisfies NaiveComputer;

describe("computer naming", () => {
  it("is an ab-infra-* tag, so the computer reaper never touches it", () => {
    expect(WORKER_TAG.startsWith(INFRA_COMPUTER_TAG_PREFIX)).toBe(true);
  });

  it("round-trips release and env tags; other computers are not workers", () => {
    const name = workerComputerName("0123456789abcdef0123456789abcdef", "aaaabbbbcccc");
    expect(name.length).toBeLessThanOrEqual(NAIVE_COMPUTER_LIMITS.nameMaxChars);
    const w = asWorkerComputer(computer(name, "2026-11-08T00:00:00.000Z"));
    expect(w).toMatchObject({ release: "0123456789ab", env: "aaaabbbbcccc" });
    const trial = encodeNaiveComputerName([`ab-${"a".repeat(32)}-${"b".repeat(32)}`], "trial");
    expect(asWorkerComputer(computer(trial, "2026-11-08T00:00:00.000Z"))).toBeNull();
    expect(asWorkerComputer(computer("agent agt_1", "2026-11-08T00:00:00.000Z"))).toBeNull();
  });

  it("liveWorkers drops destroyed/failed and sorts newest first", () => {
    const n = workerComputerName("0".repeat(32), "1".repeat(12));
    const ws = liveWorkers([
      computer(n, "2026-11-08T01:00:00.000Z"),
      computer(n, "2026-11-08T03:00:00.000Z"),
      computer(n, "2026-11-08T02:00:00.000Z", "destroyed"),
      computer(n, "2026-11-08T04:00:00.000Z", "failed"),
    ]);
    expect(ws.map((w) => w.createdAt)).toEqual([
      "2026-11-08T03:00:00.000Z",
      "2026-11-08T01:00:00.000Z",
    ]);
  });
});

describe("decisions", () => {
  const H = 3600_000;
  const t0 = Date.parse("2026-11-08T00:00:00.000Z");
  const w = (id: string, ageH: number, over: Partial<WorkerComputer> = {}): WorkerComputer => ({
    id,
    createdAt: new Date(t0 - ageH * H).toISOString(),
    status: "running",
    release: "aaaaaaaaaaaa",
    env: "bbbbbbbbbbbb",
    ...over,
  });
  const want = { release: "a".repeat(32), env: "b".repeat(12) };
  const base = { want, nowMs: t0, rotateAfterMs: 10 * H, newestHealthy: true };

  it("keeps a healthy matching worker and retires older ones", () => {
    expect(decideDeploy({ ...base, workers: [w("new", 1), w("old", 9)] })).toEqual({
      kind: "keep",
      keep: "new",
      retire: ["old"],
    });
  });

  it("replaces on no worker, release/env change, age, unhealthy, or --force", () => {
    expect(decideDeploy({ ...base, workers: [] })).toMatchObject({ kind: "replace", retire: [] });
    const cases: [Partial<Parameters<typeof decideDeploy>[0]>, RegExp][] = [
      [{ workers: [w("x", 1, { release: "cccccccccccc" })] }, /release changed/],
      [{ workers: [w("x", 1, { env: "dddddddddddd" })] }, /env changed/],
      [{ workers: [w("x", 10.5)] }, /past rotation/],
      [{ workers: [w("x", 1)], newestHealthy: false }, /not heartbeating/],
      [{ workers: [w("x", 1, { status: "paused" })] }, /paused/],
      [{ workers: [w("x", 1)], force: true }, /--force/],
    ];
    for (const [over, reason] of cases) {
      const d = decideDeploy({ ...base, workers: [], ...over });
      expect(d.kind).toBe("replace");
      if (d.kind === "replace") {
        expect(d.reason).toMatch(reason);
        expect(d.retire).toEqual(["x"]);
      }
    }
  });

  it("never keeps a computer past 12 h minus the margin, whatever the rotation setting", () => {
    const x = w("x", 0);
    expect(retireAtMs(x, 50 * H) - Date.parse(x.createdAt)).toBe(
      NAIVE_COMPUTER_LIMITS.maxLifetimeMs - LIFETIME_MARGIN_MS,
    );
  });

  it("rotate: only the newest worker hands off, and only past its rotation age", () => {
    const r = (selfId: string, workers: WorkerComputer[]) =>
      decideRotate({ selfId, workers, nowMs: t0, rotateAfterMs: 10 * H });
    expect(r("old", [w("new", 1), w("old", 11)]).kind).toBe("wait");
    expect(r("me", [w("me", 3)])).toEqual({ kind: "keep", keep: "me", retire: [] });
    expect(r("me", [w("me", 10.2), w("older", 11)])).toMatchObject({
      kind: "replace",
      retire: ["me", "older"],
    });
    expect(r("ghost", [w("me", 3)]).kind).toBe("wait");
  });
});

describe("workerCost (integer micro-USD)", () => {
  it("matches the measured 11,100 µ$ block for 1 vCPU / 1 GiB", () => {
    const c = workerCost({ vcpu: 1, memoryMb: 1024 }, 10 * 3600_000);
    expect(c.perBlockMicroUsd).toBe(11_100n);
    expect(c.computePerDayMicroUsd).toBe(1_598_400n);
  });

  it("default 1 vCPU / 2 GiB with a 10 h rotation", () => {
    const c = workerCost({ vcpu: 1, memoryMb: 2048 }, 10 * 3600_000);
    expect(c).toEqual({
      perBlockMicroUsd: 13_800n,
      computePerDayMicroUsd: 1_987_200n,
      handoffsPerDay: 3,
      handoffPerDayMicroUsd: 41_400n,
      totalPerDayMicroUsd: 2_028_600n,
      totalPer30DaysMicroUsd: 60_858_000n,
    });
  });
});

describe("host scripts", () => {
  it("exec command lines carry only phase names and hex ids", () => {
    expect(bootstrapCommand("install", ["ab12", "cd34"])).toMatch(
      /bootstrap\.sh" install ab12 cd34$/,
    );
    expect(() => bootstrapCommand("install", ["$(cat ~/.anybench/worker.env)"])).toThrow(/hex/);
    expect(() => bootstrapCommand("rm -rf" as "start")).toThrow(/unknown phase/);
  });

  it("curl config quotes the URL and refuses plain http", () => {
    expect(curlConfig('https://x.test/a?b="c"')).toContain('url = "https://x.test/a?b=\\"c\\""');
    expect(() => curlConfig("http://x.test/a")).toThrow(/https/);
  });

  it("bootstrap.sh parses with bash -n and holds no secret", () => {
    const script = renderBootstrap();
    const r = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    for (const v of Object.values(SECRETS)) expect(script).not.toContain(v);
    expect(script).not.toMatch(/set -x/);
    expect(script).toContain("Restart=always");
    expect(script).toContain("OnUnitActiveSec=15min");
  });
});
