// TDM-219 [19.3]: `anybench kit init | proof | push` and `anybench run --kit`. init's output must
// pass validate; push + run go against a local API test server that speaks the kit upload contract
// (TDM-217 [19.1]: POST /kits/uploads → presigned PUT → complete) and POST /runs.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { CreateRunBodySchema, KitUploadCreateBodySchema } from "@anybench/core";
import {
  formatKitIssue,
  inspectKitArchive,
  validateKitDir,
  type LocalProofResult,
} from "@anybench/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { runKitInit } from "../src/commands/kit-init.js";
import { formatLocalProof, kitProofExitCode, runKitProof } from "../src/commands/kit-proof.js";
import { runKitPush } from "../src/commands/kit-push.js";
import { runKitValidate } from "../src/commands/kit-validate.js";
import { parseUsdBudget, runRun } from "../src/commands/run.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
  };
}

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "ab-cli-tdm219-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe("anybench kit init (TDM-219)", () => {
  it("scaffolds a kit that anybench kit validate accepts", async () => {
    const dir = path.join(tmp, "init-a");
    const c = capture();
    expect(await runKitInit([dir], c.io)).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out[0]).toMatch(
      /^created .*init-a from the coding-agent template \(\d+ files\); it validates\.$/,
    );
    const v = capture();
    expect(await runKitValidate([dir], v.io)).toBe(0);
    expect(v.out[0]).toMatch(
      /^ok .*: claude-code \(1 contenders, 1 workloads, 1 gates, 3 requirements\)$/,
    );
  });

  it.each(["cli", "harness", "http-agent"])("--template %s validates too", async (t) => {
    const dir = path.join(tmp, `init-${t}`);
    const c = capture();
    expect(await runKitInit([dir, "--template", t, "--json"], c.io)).toBe(0);
    const r = JSON.parse(c.out.join("\n")) as { ok: boolean; template: string; errors: string[] };
    expect(r).toMatchObject({ ok: true, template: t, errors: [] });
    expect(await runKitValidate([dir, "--quiet"], capture().io)).toBe(0);
  });

  it("refuses a non-empty dir (exit 1) unless --force; bad usage exits 2", async () => {
    const dir = path.join(tmp, "init-busy");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "x"), "x");
    const c = capture();
    expect(await runKitInit([dir], c.io)).toBe(1);
    expect(c.err[0]).toMatch(/is not empty/);
    expect(await runKitInit([dir, "--force"], capture().io)).toBe(0);
    expect(await runKitInit([dir, "--template", "nope"], capture().io)).toBe(2);
    expect(await runKitInit(["a", "b"], capture().io)).toBe(2);
    expect(await main(["kit", "init", "--help"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

const passing: LocalProofResult = {
  ok: true,
  status: "pass",
  error: null,
  dir: "/k",
  image: "node:22",
  checks: [
    {
      check: "oracle_passes",
      pass: true,
      reason: "oracle 'reference-solution' passed every gate it covers (1/1 workloads)",
      units: [
        {
          variant: "oracle",
          workloadId: "slugify",
          ok: true,
          reason: "oracle passed 1/1 gate(s) on slugify",
          setupExit: 0,
          driverExit: 0,
          log: "",
          gates: [
            {
              gateId: "hidden-tests",
              status: "pass",
              reason: "hidden-tests: 7/7 hidden tests pass on slugify",
              checkExit: 0,
              log: "",
            },
          ],
        },
      ],
    },
    {
      check: "do_nothing_fails",
      pass: true,
      reason: "the untouched starting workspace failed a gate (1/1 workloads)",
      units: [],
    },
  ],
  durationMs: 9100,
  outDir: null,
};

describe("anybench kit proof (TDM-219)", () => {
  it("maps results to exit codes: 0 pass, 1 fail / invalid kit, 3 could not run", () => {
    expect(kitProofExitCode(passing)).toBe(0);
    expect(kitProofExitCode({ ...passing, ok: false, status: "fail" })).toBe(1);
    const err = (code: NonNullable<LocalProofResult["error"]>["code"]) =>
      kitProofExitCode({
        ...passing,
        ok: false,
        status: "error",
        error: { code, message: "m", issues: [] },
      });
    expect(err("invalid_kit")).toBe(1);
    expect(err("docker_unavailable")).toBe(3);
    expect(err("not_runnable")).toBe(3);
    expect(err("timeout")).toBe(3);
  });

  it("prints each check and unit, and passes options through", async () => {
    const seen: unknown[] = [];
    const c = capture();
    const code = await runKitProof(["my-kit", "--image", "node:24", "--timeout", "60"], c.io, {
      env: {},
      runLocalProof: async (dir, opts) => {
        seen.push(dir, opts);
        opts?.onLog?.("[proof] oracle slugify: setup");
        return passing;
      },
    });
    expect(code).toBe(0);
    expect(seen[0]).toBe("my-kit");
    expect(seen[1]).toMatchObject({
      image: "node:24",
      network: false,
      keep: false,
      timeoutMs: 60_000,
    });
    expect(c.err).toEqual(["[proof] oracle slugify: setup"]);
    expect(c.out[0]).toBe(
      "PASS oracle_passes: oracle 'reference-solution' passed every gate it covers (1/1 workloads)",
    );
    expect(c.out).toContain(
      "         hidden-tests: pass: hidden-tests: 7/7 hidden tests pass on slugify",
    );
    expect(c.out.at(-1)).toBe("RESULT: PASS (node:22, 9.1 s)");
  });

  it("--json prints the result; ANYBENCH_PROOF_IMAGE sets the image; bad flags exit 2", async () => {
    const c = capture();
    let image: string | undefined;
    await runKitProof(["--json"], c.io, {
      env: { ANYBENCH_PROOF_IMAGE: "node:22-slim" },
      runLocalProof: async (_d, o) => {
        image = o?.image;
        return passing;
      },
    });
    expect(image).toBe("node:22-slim");
    expect(JSON.parse(c.out.join("\n"))).toEqual(passing);
    expect(await runKitProof(["--timeout", "soon"], capture().io)).toBe(2);
    expect(await runKitProof(["--nope"], capture().io)).toBe(2);
    expect(
      formatLocalProof({
        ...passing,
        ok: false,
        status: "error",
        checks: [],
        error: { code: "docker_unavailable", message: "no Docker", issues: [] },
      }),
    ).toEqual(["error (docker_unavailable): no Docker"]);
  });
});

// ---------------------------------------------------------------------------------------------
// a local API test server: the kit upload contract (TDM-217) and POST /runs

const KEY = `ab_test_${"k".repeat(32)}`;

interface TestApi {
  url: string;
  server: Server;
  calls: string[];
  /** Set to make complete answer {ok: false}. */
  refuse: boolean;
  runs: unknown[];
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function startApi(): Promise<TestApi> {
  const uploads = new Map<
    string,
    { size: number; sha256: string; bytes?: Buffer; kitId?: string }
  >();
  const kits = new Set<string>();
  const api: TestApi = { url: "", server: undefined as never, calls: [], refuse: false, runs: [] };
  const now = new Date().toISOString();
  api.server = createServer(async (req, res) => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const u = new URL(req.url ?? "/", api.url);
    api.calls.push(`${req.method} ${u.pathname}`);
    const raw = await body(req);
    if (req.method === "PUT" && u.pathname.startsWith("/r2/")) {
      const up = uploads.get(u.pathname.slice(4));
      if (!up) return send(404, {});
      if (raw.length !== up.size || createHash("sha256").update(raw).digest("hex") !== up.sha256) {
        return send(400, { error: "length or checksum mismatch" });
      }
      // As R2 does for a presigned PUT: the checksum header it was signed with must match.
      const b64 = Buffer.from(up.sha256, "hex").toString("base64");
      if (req.headers["x-amz-checksum-sha256"] !== b64) return send(400, { error: "checksum" });
      up.bytes = raw;
      res.writeHead(200);
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      return send(401, { error: { code: "unauthorized", message: "bad key" } });
    }
    if (req.method === "POST" && u.pathname === "/kits/uploads") {
      const b = KitUploadCreateBodySchema.parse(JSON.parse(raw.toString()));
      const id = randomUUID();
      uploads.set(id, { size: b.size_bytes, sha256: b.sha256 });
      return send(201, {
        upload: {
          id,
          size_bytes: b.size_bytes,
          sha256: b.sha256,
          content_type: "application/gzip",
          expires_at: now,
        },
        plan: {
          method: "PUT",
          url: `${api.url}/r2/${id}`,
          // The headers the real presigned PUT carries (packages/envs storage presignSinglePut).
          headers: {
            "content-length": String(b.size_bytes),
            "x-amz-meta-sha256": b.sha256,
            "x-amz-checksum-sha256": Buffer.from(b.sha256, "hex").toString("base64"),
          },
        },
      });
    }
    const m = /^\/kits\/uploads\/([^/]+)\/complete$/.exec(u.pathname);
    if (req.method === "POST" && m) {
      const up = uploads.get(m[1]!);
      if (!up?.bytes) return send(409, { error: { code: "conflict", message: "not uploaded" } });
      const inspected = inspectKitArchive(up.bytes);
      if (!inspected.ok)
        return send(400, { error: { code: "validation_failed", message: "unsafe" } });
      const dir = await mkdtemp(path.join(tmpdir(), "ab-cli-tdm219-srv-"));
      await writeFile(path.join(dir, "kit.tgz"), up.bytes);
      await mkdir(path.join(dir, "kit"));
      execFileSync("tar", ["-xzf", path.join(dir, "kit.tgz"), "-C", path.join(dir, "kit")]);
      const v = await validateKitDir(path.join(dir, "kit"));
      await rm(dir, { recursive: true, force: true });
      const issue = {
        severity: "error",
        code: "schema",
        file: "anybench.yaml",
        message: "refused",
      };
      if (api.refuse || !v.ok) {
        return send(200, {
          ok: false,
          issues: v.ok ? [issue] : v.errors.map((e) => ({ ...issue, message: e.message })),
          warnings: [],
          lines: v.ok ? ["anybench.yaml: refused"] : v.errors.map(formatKitIssue),
        });
      }
      up.kitId ??= randomUUID();
      kits.add(up.kitId);
      return send(200, {
        ok: true,
        warnings: [],
        kit: {
          id: up.kitId,
          run_id: null,
          origin: "uploaded",
          version: 1,
          name: v.kit!.spec.subject.name,
          hash: up.sha256,
          proven: false,
          created_at: now,
          spec: v.kit!.spec,
          proof: [],
          repairs: 0,
        },
      });
    }
    if (req.method === "POST" && u.pathname === "/runs") {
      const b = CreateRunBodySchema.parse(JSON.parse(raw.toString()));
      if (b.source.kind !== "kit" || !kits.has(b.source.kit_id)) {
        return send(404, { error: { code: "not_found", message: "no such kit" } });
      }
      api.runs.push({ ...b, idempotency: req.headers["idempotency-key"] });
      return send(201, {
        run: {
          id: randomUUID(),
          project_id: null,
          question: b.question,
          state: "intake",
          budget_micro_usd: b.budget_micro_usd.toString(),
          spent_micro_usd: "0",
          estimate_micro_usd: null,
          kit_id: b.source.kit_id,
          paused_reason: null,
          cancel_requested_at: null,
          comped: false,
          created_at: now,
          updated_at: now,
        },
      });
    }
    send(404, { error: { code: "not_found", message: u.pathname } });
  });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  api.url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  return api;
}

describe("anybench kit push + run --kit against a local API (TDM-219)", () => {
  let api: TestApi;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    api = await startApi();
    env = {
      ANYBENCH_API_KEY: KEY,
      ANYBENCH_API_URL: api.url,
      ANYBENCH_WEB_URL: "https://web.test",
    };
  });
  afterAll(async () => {
    await new Promise((r) => api.server.close(r));
  });

  it("pushes a scaffold, prints the kit id, then starts a run from it and prints the run URL", async () => {
    const dir = path.join(tmp, "push-a");
    expect(await runKitInit([dir], capture().io)).toBe(0);
    const p = capture();
    expect(await runKitPush([dir], p.io, { env })).toBe(0);
    expect(p.out).toHaveLength(1);
    const kitId = p.out[0]!;
    expect(kitId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.err.join("\n")).toMatch(/packed .*: \d+ files/);
    expect(api.calls).toEqual([
      "POST /kits/uploads",
      expect.stringMatching(/^PUT \/r2\/[0-9a-f-]{36}$/),
      expect.stringMatching(/^POST \/kits\/uploads\/[0-9a-f-]{36}\/complete$/),
    ]);

    const r = capture();
    const question = "Is plain Claude Code good at slugify?";
    expect(
      await runRun(["--kit", kitId, "--question", question, "--budget", "12.50"], r.io, { env }),
    ).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toMatch(/^https:\/\/web\.test\/runs\/[0-9a-f-]{36}$/);
    expect(r.err[0]).toMatch(/created \(intake\), budget \$12\.50/);
    expect(api.runs[0]).toMatchObject({
      question,
      source: { kind: "kit", kit_id: kitId },
      budget_micro_usd: 12_500_000n,
      idempotency: expect.stringMatching(/^cli-/),
    });
  });

  it("--json on both; a refused kit exits 1; an unknown kit exits 1", async () => {
    const dir = path.join(tmp, "push-json");
    expect(await runKitInit([dir], capture().io)).toBe(0);
    const p = capture();
    expect(await runKitPush([dir, "--json"], p.io, { env })).toBe(0);
    const pushed = JSON.parse(p.out.join("\n")) as { ok: boolean; kit_id: string; proven: boolean };
    expect(pushed).toMatchObject({ ok: true, proven: false, name: "claude-code" });

    const r = capture();
    expect(
      await runRun(
        ["--kit", pushed.kit_id, "--question", "q", "--budget", "5", "--auto-go", "--json"],
        r.io,
        { env },
      ),
    ).toBe(0);
    expect(JSON.parse(r.out.join("\n"))).toMatchObject({
      kit_id: pushed.kit_id,
      state: "intake",
      budget_micro_usd: "5000000",
    });
    expect(api.runs.at(-1)).toMatchObject({ auto_go: true });

    api.refuse = true;
    const bad = capture();
    expect(await runKitPush([dir], bad.io, { env })).toBe(1);
    expect(bad.err).toContain("anybench.yaml: refused");
    api.refuse = false;

    const none = capture();
    expect(
      await runRun(["--kit", randomUUID(), "--question", "q", "--budget", "5"], none.io, { env }),
    ).toBe(1);
    expect(none.err[0]).toMatch(/HTTP 404/);
  });

  it("an invalid kit never leaves the machine; no API key or a bad budget exits 2", async () => {
    const dir = path.join(tmp, "push-bad");
    expect(await runKitInit([dir], capture().io)).toBe(0);
    const yaml = path.join(dir, "anybench.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace("schema_version: 2", "schema_version: 9"),
    );
    const before = api.calls.length;
    const c = capture();
    expect(await runKitPush([dir], c.io, { env })).toBe(1);
    expect(c.err.at(-1)).toMatch(/nothing uploaded$/);
    expect(api.calls.length).toBe(before);

    const k = capture();
    expect(await runKitPush([dir], k.io, { env: {} })).toBe(2);
    expect(k.err[0]).toMatch(/ANYBENCH_API_KEY is not set/);
    expect(
      await runRun(["--kit", randomUUID(), "--question", "q", "--budget", "5"], capture().io, {
        env: {},
      }),
    ).toBe(2);
    expect(
      await runRun(["--kit", "nope", "--question", "q", "--budget", "5"], capture().io, { env }),
    ).toBe(2);
    expect(await runRun(["--question", "q"], capture().io, { env })).toBe(2);
  });

  it("parses budgets in dollars to integer micro-USD without floats", () => {
    expect(parseUsdBudget("25")).toBe(25_000_000n);
    expect(parseUsdBudget("$12.5")).toBe(12_500_000n);
    expect(parseUsdBudget("0.000001")).toBe(1n);
    expect(parseUsdBudget("0")).toEqual({ error: "--budget must be more than $0" });
    expect(parseUsdBudget("1.0000001")).toHaveProperty("error");
    expect(parseUsdBudget("-3")).toHaveProperty("error");
    expect(parseUsdBudget("1e3")).toHaveProperty("error");
  });
});
