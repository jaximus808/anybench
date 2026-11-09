// A fake Anybench API for the MCP server tests (TDM-220): the kit upload contract (TDM-217:
// POST /kits/uploads → presigned PUT → complete, checked like R2 checks it), POST /runs, and the
// read routes the observe tools call. Bodies are parsed with the core contract schemas, so a tool
// that sends the wrong shape fails here the way it would against the real API.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { CreateRunBodySchema, KitUploadCreateBodySchema, type RunState } from "@anybench/core";
import { formatKitIssue, inspectKitArchive, validateKitDir } from "@anybench/kit";

export const KEY = `ab_test_${"k".repeat(32)}`;

export interface FakeApi {
  url: string;
  calls: string[];
  /** Bodies of POST /runs, parsed (bigint money). */
  runs: { body: ReturnType<typeof CreateRunBodySchema.parse>; idempotency: unknown }[];
  /** GET /runs/:id answers these states in turn, then repeats the last. */
  states: Map<string, RunState[]>;
  /** Headers of every request, to check what the server sent. */
  headers: Record<string, string | string[] | undefined>[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export const RUN_ID = "11111111-1111-4111-8111-111111111111";
export const TRIAL_ID = "22222222-2222-4222-8222-222222222222";
const CONTENDER_ID = "33333333-3333-4333-8333-333333333333";

function run(id: string, state: RunState, now: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    project_id: null,
    question: "Is it better?",
    state,
    budget_micro_usd: "25000000",
    spent_micro_usd: "0",
    estimate_micro_usd: null,
    kit_id: null,
    kit_origin: "uploaded",
    paused_reason: null,
    cancel_requested_at: null,
    comped: false,
    created_at: now,
    updated_at: now,
    ...extra,
  };
}

export async function startFakeApi(): Promise<FakeApi> {
  const uploads = new Map<
    string,
    { size: number; sha256: string; bytes?: Buffer; kitId?: string }
  >();
  const kits = new Set<string>();
  const now = new Date().toISOString();
  const pollCount = new Map<string, number>();
  const api: FakeApi = {
    url: "",
    calls: [],
    runs: [],
    states: new Map([[RUN_ID, ["running"]]]),
    headers: [],
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const u = new URL(req.url ?? "/", api.url);
    api.calls.push(`${req.method} ${u.pathname}${u.search}`);
    api.headers.push({ ...req.headers });
    const raw = await readBody(req);
    if (req.method === "PUT" && u.pathname.startsWith("/r2/")) {
      const up = uploads.get(u.pathname.slice(4));
      if (!up) return send(404, {});
      if (raw.length !== up.size || createHash("sha256").update(raw).digest("hex") !== up.sha256)
        return send(400, { error: "length or checksum mismatch" });
      if (req.headers["x-amz-checksum-sha256"] !== Buffer.from(up.sha256, "hex").toString("base64"))
        return send(400, { error: "checksum" });
      up.bytes = raw;
      res.writeHead(200);
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      // Echo the header back, as a careless server might: the MCP server must still not leak it.
      return send(401, {
        error: { code: "unauthorized", message: `bad key: ${req.headers.authorization ?? ""}` },
      });
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
          headers: {
            "content-length": String(b.size_bytes),
            "x-amz-checksum-sha256": Buffer.from(b.sha256, "hex").toString("base64"),
          },
        },
      });
    }
    const complete = /^\/kits\/uploads\/([^/]+)\/complete$/.exec(u.pathname);
    if (req.method === "POST" && complete) {
      const up = uploads.get(complete[1]!);
      if (!up?.bytes) return send(409, { error: { code: "conflict", message: "not uploaded" } });
      if (!inspectKitArchive(up.bytes).ok)
        return send(400, { error: { code: "validation_failed", message: "unsafe" } });
      const dir = await mkdtemp(path.join(tmpdir(), "ab-mcp-tdm220-srv-"));
      await writeFile(path.join(dir, "kit.tgz"), up.bytes);
      await mkdir(path.join(dir, "kit"));
      execFileSync("tar", ["-xzf", path.join(dir, "kit.tgz"), "-C", path.join(dir, "kit")]);
      const v = await validateKitDir(path.join(dir, "kit"));
      await rm(dir, { recursive: true, force: true });
      if (!v.ok) {
        return send(200, {
          ok: false,
          issues: v.errors.map((e) => ({
            severity: "error",
            code: "schema",
            file: "anybench.yaml",
            message: e.message,
          })),
          warnings: [],
          lines: v.errors.map(formatKitIssue),
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
      if (b.source.kind !== "kit" || !kits.has(b.source.kit_id))
        return send(404, { error: { code: "not_found", message: "no such kit" } });
      api.runs.push({ body: b, idempotency: req.headers["idempotency-key"] });
      return send(201, {
        run: run(randomUUID(), "intake", now, {
          question: b.question,
          budget_micro_usd: b.budget_micro_usd.toString(),
          kit_id: b.source.kit_id,
        }),
      });
    }
    if (req.method === "GET" && u.pathname === "/runs") {
      return send(200, { items: [run(RUN_ID, "running", now)], next_cursor: null });
    }
    const runGet = /^\/runs\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && runGet) {
      const id = runGet[1]!;
      const seq = api.states.get(id);
      if (!seq) return send(404, { error: { code: "not_found", message: "no such run" } });
      const n = pollCount.get(id) ?? 0;
      pollCount.set(id, n + 1);
      return send(200, {
        run: run(id, seq[Math.min(n, seq.length - 1)]!, now),
        counters: {
          trials_total: 4,
          trials_done: 1,
          trials_running: 1,
          trials_failed: 0,
          spent_micro_usd: "1250000",
          projected_micro_usd: null,
          elapsed_s: 60,
          eta_s: null,
          last_seq: 7,
        },
        open_alerts: [],
        agents: [],
      });
    }
    if (req.method === "GET" && u.pathname === `/runs/${RUN_ID}/trials`) {
      return send(200, {
        items: [
          {
            id: TRIAL_ID,
            run_id: RUN_ID,
            contender_id: CONTENDER_ID,
            workload_id: "slugify",
            repeat: 0,
            attempt: 1,
            state: "done",
            failure_class: null,
            started_at: now,
            ended_at: now,
            cost_micro_usd: "310000",
          },
        ],
        next_cursor: null,
      });
    }
    if (req.method === "GET" && u.pathname === `/trials/${TRIAL_ID}`) {
      return send(200, {
        trial: {
          id: TRIAL_ID,
          run_id: RUN_ID,
          contender_id: CONTENDER_ID,
          workload_id: "slugify",
          repeat: 0,
          attempt: 1,
          state: "done",
          failure_class: null,
          started_at: now,
          ended_at: now,
          cost_micro_usd: "310000",
          computer_id: null,
          provider: null,
          exit_code: 0,
          log_offset: 0,
          machine: null,
          metrics: { wall_s: 41 },
          gate: { pass: true, reason: "7/7 hidden tests pass", evidence: [] },
          versions: {},
          phases: [{ state: "done", at: now }],
        },
      });
    }
    if (req.method === "GET" && u.pathname === `/runs/${RUN_ID}/report/markdown`) {
      res.writeHead(200, { "content-type": "text/markdown" });
      return res.end("# Report\n\nindistinguishable at n=10\n");
    }
    if (req.method === "GET" && u.pathname === `/runs/${RUN_ID}/report`) {
      return send(404, { error: { code: "not_found", message: "no report yet" } });
    }
    send(404, { error: { code: "not_found", message: u.pathname } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return api;
}
