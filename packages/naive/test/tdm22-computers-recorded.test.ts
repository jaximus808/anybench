// TDM-22: the live `computers` client against responses recorded from the real API on
// 2026-11-07 (docs/findings/naive-hosting.md), served by a mocked fetch. No network.
import { describe, expect, it } from "vitest";
import {
  createNaiveClient,
  NaiveConflictError,
  NaiveError,
  NaiveInsufficientCreditsError,
  NaiveNotFoundError,
} from "../src/index.js";

const CMP = "cmp_01a1b85e26a37b7286d45eb92f06253f";
const SNP = "snp_033329219dd747bd94a3c87114dc5894";

const recordedComputer = {
  id: CMP,
  object: "computer",
  name: "tdm170-worker",
  vcpu: 1,
  memory_mb: 1024,
  disk_gb: 5,
  status: "running",
  browser: null,
  volume: null,
  snapshot_id: null,
  agent_id: null,
  created_at: "2026-11-07T23:35:43.431Z",
};

const recorded: Record<string, { status: number; body: unknown }> = {
  [`POST /v1/computers`]: { status: 202, body: recordedComputer },
  [`GET /v1/computers/${CMP}`]: { status: 200, body: recordedComputer },
  [`GET /v1/computers/${CMP}/inspect`]: {
    status: 200,
    body: {
      object: "computer_inspect",
      id: CMP,
      status: "running",
      last_active_at: "2026-11-07T23:35:50Z",
      home: "/home/naive",
      probe: {
        sampled_at: "2026-11-07T23:35:57Z",
        uptime_seconds: 14,
        processes: 105,
        load_1m: 0.02,
        memory_used_mb: 204,
        memory_total_mb: 959,
        disk_used_gb: 2.51,
        disk_total_gb: 4.84,
      },
    },
  },
  [`POST /v1/computers/${CMP}/exec`]: {
    status: 200,
    body: {
      stdout: "setsid_pid=1747\nnohup_pid=1749\nbare_pid=1750\ndone\n",
      stderr: "command timed out after 120000ms",
      exit_code: 124,
      duration_ms: 127195,
      timed_out: true,
    },
  },
  [`POST /v1/computers/${CMP}/snapshot`]: {
    status: 201,
    body: { snapshot_id: SNP, computer_id: CMP, created_at: "2026-11-07T23:55:31Z" },
  },
  [`POST /v1/computers/${CMP}/fs/read`]: {
    status: 200,
    body: { path: "/home/naive/t.txt", encoding: "base64", content: "aGkK" },
  },
  [`POST /v1/computers/${CMP}/fs/mkdir`]: { status: 200, body: { created: true } },
  [`DELETE /v1/computers/${CMP}`]: {
    status: 200,
    body: { id: CMP, object: "computer", deleted: true },
  },
  [`DELETE /v1/snapshots/${SNP}`]: {
    status: 200,
    body: { id: SNP, object: "snapshot", deleted: true },
  },
};

function tdm22Client(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    sent.push({
      method,
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const hit = overrides[`${method} ${url.pathname}`] ?? recorded[`${method} ${url.pathname}`];
    const r = hit ?? {
      status: 404,
      body: { error: { type: "not_found", code: "not_found", message: "no", request_id: "r" } },
    };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { client: createNaiveClient({ apiKey: "sk_test_tdm22", fetch }), sent };
}

const envelope = (status: number, code: string) => ({
  status,
  body: {
    error: { type: "conflict", code, message: `${code} (recorded shape)`, request_id: "req_x" },
  },
});

describe("NaiveClient.computers over recorded responses", () => {
  it("maps computers, inspect, exec, snapshots and fs to Anybench shapes", async () => {
    const { client, sent } = tdm22Client();
    const c = await client.computers.create({ name: "tdm170-worker", vcpu: 1, memoryMb: 1024 });
    expect(sent[0]?.body).toEqual({ name: "tdm170-worker", vcpu: 1, memory_mb: 1024 });
    expect(c).toEqual({
      id: CMP,
      name: "tdm170-worker",
      vcpu: 1,
      memoryMb: 1024,
      diskGb: 5,
      status: "running",
      snapshotId: null,
      agentId: null,
      createdAt: "2026-11-07T23:35:43.431Z",
    });
    const i = await client.computers.inspect(CMP);
    expect(i.home).toBe("/home/naive");
    expect(i.probe).toMatchObject({ uptimeSeconds: 14, memoryTotalMb: 959, load1m: 0.02 });

    const r = await client.computers.exec(CMP, "long", { timeoutMs: 120_000 });
    expect(sent.at(-1)?.body).toEqual({ command: "long", timeout_ms: 120_000 });
    expect(r).toEqual({
      stdout: "setsid_pid=1747\nnohup_pid=1749\nbare_pid=1750\ndone\n",
      stderr: "command timed out after 120000ms",
      exitCode: 124,
      durationMs: 127195,
      timedOut: true,
      truncated: false,
    });

    expect(await client.computers.snapshot(CMP)).toEqual({
      snapshotId: SNP,
      computerId: CMP,
      createdAt: "2026-11-07T23:55:31Z",
    });
    expect(
      new TextDecoder().decode(await client.computers.readFile(CMP, "/home/naive/t.txt")),
    ).toBe("hi\n");
    await client.computers.mkdir(CMP, "/home/naive/.anybench");
    await client.computers.deleteSnapshot(SNP);
    await client.computers.delete(CMP);
    expect(sent.map((s) => `${s.method} ${s.path}`).slice(-3)).toEqual([
      `POST /v1/computers/${CMP}/fs/mkdir`,
      `DELETE /v1/snapshots/${SNP}`,
      `DELETE /v1/computers/${CMP}`,
    ]);
  });

  it("maps error envelopes to typed Naïve errors", async () => {
    const { client } = tdm22Client({
      [`POST /v1/computers`]: envelope(402, "insufficient_credits"),
      [`POST /v1/computers/${CMP}/exec`]: envelope(409, "computer_unavailable"),
      [`DELETE /v1/snapshots/${SNP}`]: envelope(409, "state_conflict"),
      [`POST /v1/computers/${CMP}/fs/read`]: envelope(403, "forbidden"),
    });
    await expect(client.computers.create({})).rejects.toBeInstanceOf(NaiveInsufficientCreditsError);
    await expect(client.computers.exec(CMP, "x")).rejects.toBeInstanceOf(NaiveConflictError);
    await expect(client.computers.deleteSnapshot(SNP)).rejects.toMatchObject({
      code: "state_conflict",
    });
    await expect(client.computers.readFile(CMP, "/etc/passwd")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      client.computers.get("cmp_00000000000000000000000000000000"),
    ).rejects.toBeInstanceOf(NaiveNotFoundError);
  });

  it("refuses an fs/read reply that is not what Naïve documents", async () => {
    const { client } = tdm22Client({
      [`POST /v1/computers/${CMP}/fs/read`]: { status: 200, body: { content: "not base64!!" } },
    });
    const e = await client.computers.readFile(CMP, "/home/naive/x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NaiveError);
    expect((e as NaiveError).code).toBe("response_unreadable");
  });
});
