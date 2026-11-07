// The ComputeProvider contract suite. Every adapter (fake, naive, docker-local, vultr)
// runs the same tests, so code written against the interface behaves the same everywhere:
//
//   import { runProviderContract } from "@anybench/providers/contract";
//   runProviderContract("naive", () => makeNaiveProvider(), { enabled: process.env.NAIVE_LIVE === "1" });
//
// It must be called from a vitest test file. It only uses commands any POSIX sh has
// (echo, cat, sleep, exit, test) so the FakeProvider's mini shell covers it too.
// Cost: one shared computer plus one fork (when snapshots are supported); every
// computer it creates is destroyed in afterAll even when a test fails.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProviderError, type ProviderErrorCode } from "./errors.js";
import { decodeText, trialTag } from "./helpers.js";
import type { ComputeProvider, ComputerInfo, ComputerSpecInput } from "./types.js";

export interface ProviderContractOptions {
  /** Run the suite at all (gate live providers on NAIVE_LIVE=1 etc.). Default true. */
  enabled?: boolean;
  /** Spec for the computers the suite creates (tags are added). Default 2 vCPU / 4096 MB / 5 GB. */
  spec?: Omit<ComputerSpecInput, "tags" | "snapshotId">;
  /** Max wait for a computer to reach `running`. Default 300 000 ms. */
  readyTimeoutMs?: number;
  /** waitReady poll interval. Default: the provider's own. */
  readyIntervalMs?: number;
  /** Per-test timeout. Default 120 000 ms. */
  testTimeoutMs?: number;
  /** How long to wait for a detached command's effect. Default 30 000 ms. */
  detachedWaitMs?: number;
  /** An id this provider certainly does not know (format matters on some APIs). */
  missingId?: string;
  /** A snapshot id this provider certainly does not know. */
  missingSnapshotId?: string;
  /** Run tag prefix, unique per run so live accounts never collide. Default random. */
  runId?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function expectProviderError(p: Promise<unknown>, code: ProviderErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected a ProviderError ${code}`).toBeDefined();
  expect(isProviderError(caught), `expected a ProviderError, got ${String(caught)}`).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
}

export function runProviderContract(
  name: string,
  makeProvider: () => ComputeProvider | Promise<ComputeProvider>,
  opts: ProviderContractOptions = {},
): void {
  const testTimeout = opts.testTimeoutMs ?? 120_000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 300_000;
  const detachedWaitMs = opts.detachedWaitMs ?? 30_000;
  const runId =
    opts.runId ?? `ct${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const baseSpec = { vcpu: 2, memoryMb: 4096, diskGb: 5, ...opts.spec };
  const missingId = opts.missingId ?? "ab-contract-missing-000000";
  const missingSnapshotId = opts.missingSnapshotId ?? "ab-contract-missing-snapshot-000000";

  const suite = opts.enabled === false ? describe.skip : describe;

  suite(`ComputeProvider contract: ${name}`, () => {
    let p: ComputeProvider;
    let c: ComputerInfo;
    const tag = trialTag(runId, "t1");
    const created = new Set<string>();
    const snapshots = new Set<string>();
    const waitOpts = () => ({
      timeoutMs: readyTimeoutMs,
      ...(opts.readyIntervalMs === undefined ? {} : { intervalMs: opts.readyIntervalMs }),
    });
    const home = (rel: string) => `${c.home.replace(/\/+$/, "")}/${rel}`;

    beforeAll(async () => {
      p = await makeProvider();
      const first = await p.create({ ...baseSpec, name: `ab-contract-${runId}`, tags: [tag] });
      created.add(first.id);
      expect(["creating", "running"]).toContain(first.status);
      c = await p.waitReady(first.id, waitOpts());
    }, readyTimeoutMs + testTimeout);

    afterAll(async () => {
      if (!p) return;
      for (const id of created) await p.destroy(id).catch(() => undefined);
      for (const s of snapshots) await p.deleteSnapshot(s).catch(() => undefined);
    }, testTimeout);

    it("declares sane capabilities", () => {
      expect(p.name.length).toBeGreaterThan(0);
      expect(Number.isInteger(p.capabilities.maxExecTimeoutMs)).toBe(true);
      expect(p.capabilities.maxExecTimeoutMs).toBeGreaterThanOrEqual(1_000);
      expect(p.capabilities.maxOutputChars).toBeGreaterThan(0);
      if (p.capabilities.fork) expect(p.capabilities.snapshot).toBe(true);
    });

    it("create + waitReady yields a running computer with the spec and tags", () => {
      expect(c.status).toBe("running");
      expect(c.provider).toBe(p.name);
      expect(c.tags).toContain(tag);
      expect(c.vcpu).toBe(baseSpec.vcpu);
      expect(c.home.startsWith("/")).toBe(true);
      expect(Number.isNaN(Date.parse(c.createdAt))).toBe(false);
    });

    it(
      "inspect returns the same computer",
      async () => {
        const info = await p.inspect(c.id);
        expect(info.id).toBe(c.id);
        expect(info.status).toBe("running");
        expect(info.tags).toContain(tag);
      },
      testTimeout,
    );

    it("rejects an invalid spec with a validation error", async () => {
      await expectProviderError(p.create({ ...baseSpec, vcpu: 0 }), "validation");
      await expectProviderError(p.create({ ...baseSpec, tags: ["-bad tag"] }), "validation");
    });

    it(
      "exec returns stdout and exit code 0",
      async () => {
        const r = await p.exec(c.id, "echo hello", { timeoutMs: 30_000 });
        expect(r.stdout).toBe("hello\n");
        expect(r.exitCode).toBe(0);
        expect(r.timedOut).toBe(false);
        expect(r.truncated).toBe(false);
        expect(r.durationMs).toBeGreaterThanOrEqual(0);
      },
      testTimeout,
    );

    it(
      "exec returns stderr and a non-zero exit code without throwing",
      async () => {
        const r = await p.exec(c.id, "echo oops >&2; exit 3");
        expect(r.stderr).toBe("oops\n");
        expect(r.stdout).toBe("");
        expect(r.exitCode).toBe(3);
        expect(r.timedOut).toBe(false);
      },
      testTimeout,
    );

    it(
      "exec past its timeout resolves timedOut with exit 124",
      async () => {
        const started = Date.now();
        const r = await p.exec(c.id, "sleep 30", { timeoutMs: 1_500 });
        expect(r.timedOut).toBe(true);
        expect(r.exitCode).toBe(124);
        expect(Date.now() - started).toBeLessThan(25_000);
      },
      testTimeout,
    );

    it("exec refuses a timeout over the provider cap", async () => {
      await expectProviderError(
        p.exec(c.id, "echo never", { timeoutMs: p.capabilities.maxExecTimeoutMs + 1 }),
        "validation",
      );
    });

    it(
      "putFile/getFile round-trip text and bytes, and exec sees the file",
      async () => {
        await p.putFile(c.id, home("ab-contract/hello.txt"), "hi there\n");
        expect(decodeText(await p.getFile(c.id, home("ab-contract/hello.txt")))).toBe("hi there\n");
        // relative paths resolve against home
        expect(decodeText(await p.getFile(c.id, "ab-contract/hello.txt"))).toBe("hi there\n");
        const r = await p.exec(c.id, `cat ${home("ab-contract/hello.txt")}`);
        expect(r.stdout).toBe("hi there\n");

        const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
        await p.putFile(c.id, home("ab-contract/bytes.bin"), bytes, { mode: 0o600 });
        expect(Array.from(await p.getFile(c.id, home("ab-contract/bytes.bin")))).toEqual(
          Array.from(bytes),
        );
      },
      testTimeout,
    );

    it(
      "exec writes are visible to getFile",
      async () => {
        const r = await p.exec(c.id, `echo from-exec > ${home("ab-contract/exec.txt")}`);
        expect(r.exitCode).toBe(0);
        expect(decodeText(await p.getFile(c.id, home("ab-contract/exec.txt")))).toBe("from-exec\n");
      },
      testTimeout,
    );

    it(
      "getFile of a missing file is not_found",
      async () => {
        await expectProviderError(p.getFile(c.id, home("ab-contract/nope.txt")), "not_found");
      },
      testTimeout,
    );

    it("file paths outside home are forbidden", async () => {
      await expectProviderError(p.putFile(c.id, "/etc/ab-contract.txt", "x"), "forbidden");
      await expectProviderError(p.getFile(c.id, "/etc/passwd"), "forbidden");
      await expectProviderError(p.getFile(c.id, home("../ab-contract-escape.txt")), "forbidden");
    });

    it(
      "execDetached returns at once and the command keeps running after it",
      async () => {
        const marker = home(`ab-contract/detached-${runId}.txt`);
        const logPath = home(`ab-contract/detached-${runId}.log`);
        const started = Date.now();
        const proc = await p.execDetached(
          c.id,
          `echo started && sleep 2 && echo done > ${marker}`,
          { logPath },
        );
        expect(proc.pid).toBeGreaterThan(0);
        expect(proc.logPath).toBe(logPath);
        expect(Date.now() - started).toBeLessThan(p.capabilities.maxExecTimeoutMs);

        const deadline = Date.now() + detachedWaitMs;
        let text: string | undefined;
        while (Date.now() < deadline) {
          const probe = await p.exec(c.id, `test -f ${marker}`);
          if (probe.exitCode === 0) {
            text = decodeText(await p.getFile(c.id, marker));
            break;
          }
          await sleep(250);
        }
        expect(text).toBe("done\n");
        expect(decodeText(await p.getFile(c.id, logPath))).toContain("started");
      },
      testTimeout + detachedWaitMs,
    );

    it(
      "list filters by exact tag and by run prefix",
      async () => {
        expect((await p.list({ tag })).map((x) => x.id)).toContain(c.id);
        expect((await p.list({ tagPrefix: `ab-${runId}-` })).map((x) => x.id)).toContain(c.id);
        expect((await p.list({ tag: trialTag(runId, "other") })).map((x) => x.id)).not.toContain(
          c.id,
        );
      },
      testTimeout,
    );

    it(
      "unknown ids are not_found",
      async () => {
        await expectProviderError(p.inspect(missingId), "not_found");
        await expectProviderError(p.exec(missingId, "echo x"), "not_found");
      },
      testTimeout,
    );

    it(
      "snapshot + fork copies the filesystem and the fork is independent",
      async (ctx) => {
        if (!p.capabilities.snapshot || !p.capabilities.fork) return ctx.skip();
        await p.putFile(c.id, home("ab-contract/snap.txt"), "v1");
        const snap = await p.snapshot(c.id);
        snapshots.add(snap.snapshotId);
        expect(snap.computerId).toBe(c.id);

        const forkTag = trialTag(runId, "fork");
        const f0 = await p.fork(snap.snapshotId, { ...baseSpec, tags: [forkTag] });
        created.add(f0.id);
        expect(f0.id).not.toBe(c.id);
        const f = await p.waitReady(f0.id, waitOpts());
        expect(f.snapshotId).toBe(snap.snapshotId);
        expect(f.tags).toContain(forkTag);
        expect(decodeText(await p.getFile(f.id, home("ab-contract/snap.txt")))).toBe("v1");

        await p.putFile(f.id, home("ab-contract/snap.txt"), "v2");
        expect(decodeText(await p.getFile(c.id, home("ab-contract/snap.txt")))).toBe("v1");

        await p.destroy(f.id);
        created.delete(f.id);
        await p.deleteSnapshot(snap.snapshotId);
        snapshots.delete(snap.snapshotId);
      },
      readyTimeoutMs + testTimeout,
    );

    it(
      "fork of an unknown snapshot is not_found",
      async (ctx) => {
        if (!p.capabilities.fork) return ctx.skip();
        await expectProviderError(p.fork(missingSnapshotId, baseSpec), "not_found");
      },
      testTimeout,
    );

    it(
      "pause stops it, exec on a paused computer resumes it",
      async (ctx) => {
        if (!p.capabilities.pause) return ctx.skip();
        const paused = await p.pause(c.id);
        expect(["paused", "running"]).toContain(paused.status); // pause may settle asynchronously
        expect((await p.waitReady(c.id, waitOpts())).status).toMatch(/^(paused|running)$/);
        const r = await p.exec(c.id, "echo awake");
        expect(r.stdout).toBe("awake\n");
        expect((await p.inspect(c.id)).status).toBe("running");
        const resumed = await p.resume(c.id);
        expect(resumed.status).toBe("running");
      },
      readyTimeoutMs + testTimeout,
    );

    it(
      "destroy removes it, is idempotent, and it leaves list",
      async () => {
        await p.destroy(c.id);
        created.delete(c.id);
        await p.destroy(c.id); // idempotent
        expect((await p.list({ tag })).map((x) => x.id)).not.toContain(c.id);
        try {
          const info = await p.inspect(c.id);
          expect(info.status).toBe("destroyed");
        } catch (e) {
          expect(isProviderError(e, "not_found")).toBe(true);
        }
        await expect(p.exec(c.id, "echo gone")).rejects.toSatisfy(
          (e: unknown) => isProviderError(e, "not_found") || isProviderError(e, "unavailable"),
        );
      },
      testTimeout,
    );
  });
}
