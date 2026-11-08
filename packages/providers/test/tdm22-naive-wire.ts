// Test helper (TDM-22): a `fetch` that answers the Naïve computers routes from a FakeNaive, in
// the wire shapes the API sends (snake_case, `object` fields, error envelopes). Lets the LIVE
// client, and the real SDK's own parsing under it, run offline.
import { NaiveError, type FakeNaive, type NaiveComputer } from "@anybench/naive";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_tdm22" },
  });
}

function wireComputer(c: NaiveComputer) {
  return {
    id: c.id,
    object: "computer",
    name: c.name,
    vcpu: c.vcpu,
    memory_mb: c.memoryMb,
    disk_gb: c.diskGb,
    status: c.status,
    browser: null,
    volume: null,
    snapshot_id: c.snapshotId,
    agent_id: c.agentId,
    created_at: c.createdAt,
  };
}

export interface Tdm22WireRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export function tdm22NaiveWireFetch(naive: FakeNaive): {
  fetch: typeof globalThis.fetch;
  requests: Tdm22WireRequest[];
} {
  const fake = naive.computers;
  const requests: Tdm22WireRequest[] = [];
  const route = async (method: string, url: URL, body: Record<string, unknown>) => {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // v1, computers, id, …
    const [, kind, id, sub, op] = parts;
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
    const num = (k: string) => (typeof body[k] === "number" ? (body[k] as number) : undefined);
    if (kind === "snapshots" && method === "DELETE" && id) {
      await fake.deleteSnapshot(id);
      return json({ id, object: "snapshot", deleted: true });
    }
    if (kind !== "computers") return json({}, 404);
    if (!id) {
      if (method === "POST") {
        const c = await fake.create({
          ...(str("name") !== undefined ? { name: str("name") } : {}),
          ...(num("vcpu") !== undefined ? { vcpu: num("vcpu") } : {}),
          ...(num("memory_mb") !== undefined ? { memoryMb: num("memory_mb") } : {}),
          ...(num("disk_gb") !== undefined ? { diskGb: num("disk_gb") } : {}),
          ...(str("snapshot_id") !== undefined ? { snapshotId: str("snapshot_id") } : {}),
        });
        return json(wireComputer(c), 202);
      }
      const limit = url.searchParams.get("limit");
      const after = url.searchParams.get("after");
      const page = await fake.list({
        ...(limit ? { limit: Number(limit) } : {}),
        ...(after ? { after } : {}),
      });
      return json({
        data: page.data.map(wireComputer),
        has_more: page.hasMore,
        next_cursor: page.nextCursor,
      });
    }
    if (sub === undefined) {
      if (method === "DELETE") {
        await fake.delete(id);
        return json({ id, object: "computer", deleted: true });
      }
      return json(wireComputer(await fake.get(id)));
    }
    switch (sub) {
      case "inspect": {
        const i = await fake.inspect(id);
        return json({
          object: "computer_inspect",
          id: i.id,
          status: i.status,
          last_active_at: i.lastActiveAt,
          home: i.home,
          probe: i.probe && {
            sampled_at: i.probe.sampledAt,
            uptime_seconds: i.probe.uptimeSeconds,
            processes: i.probe.processes,
            load_1m: i.probe.load1m,
            memory_used_mb: i.probe.memoryUsedMb,
            memory_total_mb: i.probe.memoryTotalMb,
            disk_used_gb: i.probe.diskUsedGb,
            disk_total_gb: i.probe.diskTotalGb,
          },
        });
      }
      case "exec": {
        const timeout = num("timeout_ms");
        const r = await fake.exec(
          id,
          str("command") ?? "",
          timeout === undefined ? {} : { timeoutMs: timeout },
        );
        return json({
          exit_code: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          duration_ms: r.durationMs,
          timed_out: r.timedOut,
          truncated: r.truncated,
        });
      }
      case "pause":
        return json(wireComputer(await fake.pause(id)));
      case "resume":
        return json(wireComputer(await fake.resume(id)));
      case "snapshot": {
        const s = await fake.snapshot(id);
        return json(
          { snapshot_id: s.snapshotId, computer_id: s.computerId, created_at: s.createdAt },
          201,
        );
      }
      case "fs": {
        const path = str("path") ?? "";
        if (op === "read") {
          const bytes = await fake.readFile(id, path);
          const encoding = str("encoding") ?? "text";
          const content =
            encoding === "base64"
              ? Buffer.from(bytes).toString("base64")
              : new TextDecoder().decode(bytes);
          return json({ path, encoding, content });
        }
        if (op === "write") {
          const content = str("content") ?? "";
          const bytes =
            str("encoding") === "base64"
              ? new Uint8Array(Buffer.from(content, "base64"))
              : new TextEncoder().encode(content);
          await fake.writeFile(id, path, bytes);
          return json({ path, bytes: bytes.length });
        }
        if (op === "mkdir") {
          await fake.mkdir(id, path);
          return json({ path, created: true });
        }
        if (op === "remove") {
          await fake.remove(id, path);
          return json({ path, removed: true });
        }
      }
    }
    return json(
      {
        error: {
          type: "not_found",
          code: "not_found",
          message: "no route",
          request_id: "req_tdm22",
        },
      },
      404,
    );
  };

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    requests.push({ method, path: url.pathname, body });
    try {
      return await route(method, url, body ?? {});
    } catch (e) {
      if (!(e instanceof NaiveError)) throw e;
      return json(
        {
          error: {
            type: "invalid_request",
            code: e.code,
            message: e.message,
            request_id: "req_tdm22",
            ...(e.param ? { param: e.param } : {}),
          },
        },
        e.status ?? 500,
      );
    }
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}
