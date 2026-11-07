import { describe, expect, it } from "vitest";
import {
  FakeProvider,
  ProviderBillingError,
  ProviderCapacityError,
  ProviderError,
  buildDetachedCommand,
  isProviderError,
  parseDetachedPid,
  parseTrialTag,
  resolveHomePath,
  runTagPrefix,
  shellQuote,
  trialTag,
} from "../src/index.js";
import { decodeText } from "../src/helpers.js";

async function readyFake(opts: ConstructorParameters<typeof FakeProvider>[0] = {}) {
  const p = new FakeProvider({ timeScale: 0.01, ...opts });
  const c = await p.waitReady((await p.create({ tags: [trialTag("run1", "t1")] })).id);
  return { p, c };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("tags", () => {
  it("builds and parses ab-<run>-<trial>", () => {
    expect(trialTag("run_01H", "trl_9")).toBe("ab-run_01H-trl_9");
    expect(parseTrialTag("ab-run_01H-trl_9")).toEqual({ runId: "run_01H", trialId: "trl_9" });
    expect(parseTrialTag("other")).toBeNull();
    expect(runTagPrefix("r1")).toBe("ab-r1-");
  });

  it("refuses ids that would make the tag ambiguous", () => {
    expect(() => trialTag("run-1", "t1")).toThrow(ProviderError);
    expect(() => trialTag("r1", "t 1")).toThrow(/trial id/);
  });
});

describe("resolveHomePath", () => {
  const home = "/home/naive";
  it("keeps paths inside home and resolves relative ones", () => {
    expect(resolveHomePath(home, "/home/naive/a/b.txt")).toBe("/home/naive/a/b.txt");
    expect(resolveHomePath(home, "a/./b/../c.txt")).toBe("/home/naive/a/c.txt");
  });
  it("forbids escapes, sibling prefixes and the home itself", () => {
    expect(
      isProviderError(
        caughtSync(() => resolveHomePath(home, "/etc/passwd")),
        "forbidden",
      ),
    ).toBe(true);
    expect(
      isProviderError(
        caughtSync(() => resolveHomePath(home, "../x")),
        "forbidden",
      ),
    ).toBe(true);
    expect(
      isProviderError(
        caughtSync(() => resolveHomePath(home, "/home/naiveevil/x")),
        "forbidden",
      ),
    ).toBe(true);
    expect(
      isProviderError(
        caughtSync(() => resolveHomePath(home, "/home/naive")),
        "validation",
      ),
    ).toBe(true);
  });
});

function caughtSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("detached command line", () => {
  it("uses setsid nohup, appends to the log, closes stdin and prints the pid", () => {
    const line = buildDetachedCommand("runner --trial 't1'", "/home/naive/eval/runner.log");
    expect(line).toContain("setsid nohup sh -c ");
    expect(line).toContain(shellQuote("runner --trial 't1'"));
    expect(line).toContain(">> '/home/naive/eval/runner.log' 2>&1 < /dev/null & echo $!");
    expect(parseDetachedPid("4242\n")).toBe(4242);
    expect(() => parseDetachedPid("nope")).toThrow(ProviderError);
  });
});

describe("FakeProvider", () => {
  it("scripted handlers win over the built-in shell and see the fs", async () => {
    const { p, c } = await readyFake();
    p.onExec(/^claude --version$/, () => "2.1.0 (Claude Code)\n");
    p.onExec(/^grade (\S+)$/, (ctx) => ({
      stdout: `${ctx.readFile(ctx.match![1]!) ?? "missing"}\n`,
      exitCode: 0,
    }));
    await p.putFile(c.id, "out.txt", "PASS");
    expect((await p.exec(c.id, "claude --version")).stdout).toBe("2.1.0 (Claude Code)\n");
    expect((await p.exec(c.id, "grade ~/out.txt")).stdout).toBe("PASS\n");
    // per-statement matching inside a compound command
    expect((await p.exec(c.id, "echo a && claude --version")).stdout).toBe(
      "a\n2.1.0 (Claude Code)\n",
    );
  });

  it("unknown commands exit 127; unsupported syntax is a shell error", async () => {
    const { p, c } = await readyFake();
    const r = await p.exec(c.id, "frobnicate");
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toContain("command not found");
    expect((await p.exec(c.id, "ls | wc -l")).exitCode).toBe(2);
  });

  it("supports &&, ||, ; and redirections", async () => {
    const { p, c } = await readyFake();
    expect((await p.exec(c.id, "false && echo no; echo yes")).stdout).toBe("yes\n");
    expect((await p.exec(c.id, "false || echo fallback")).stdout).toBe("fallback\n");
    await p.exec(c.id, "echo one > $HOME/f.txt && echo two >> ~/f.txt && echo gone > /dev/null");
    expect(decodeText(await p.getFile(c.id, "f.txt"))).toBe("one\ntwo\n");
    expect((await p.exec(c.id, "cat /nope 2>&1")).stdout).toContain("No such file");
  });

  it("a handler's virtual duration over the timeout times out", async () => {
    const { p, c } = await readyFake();
    p.onExec("slow", () => ({ stdout: "partial", durationMs: 120_000 }));
    const r = await p.exec(c.id, "slow", { timeoutMs: 1_000 });
    expect(r).toMatchObject({ timedOut: true, exitCode: 124 });
  });

  it("truncates output at maxOutputChars", async () => {
    const { p, c } = await readyFake({ capabilities: { maxOutputChars: 10 } });
    p.onExec("big", () => "x".repeat(50));
    const r = await p.exec(c.id, "big");
    expect(r.stdout).toBe("x".repeat(10));
    expect(r.truncated).toBe(true);
  });

  it("records commands, detached processes and file modes", async () => {
    const { p, c } = await readyFake();
    await p.putFile(c.id, ".anybench/env", "SECRET=1\n", { mode: 0o600 });
    await p.exec(c.id, "echo hi");
    const proc = await p.execDetached(c.id, "sleep 1 && echo bye");
    expect(proc.logPath).toBe(`/home/naive/.anybench/logs/detached-${proc.pid}.log`);
    await p.settle();
    expect(p.commands(c.id).map((x) => x.kind)).toEqual(["exec", "detached"]);
    expect(p.commands().some((x) => x.command.includes("SECRET"))).toBe(false);
    expect(p.detached(c.id)[0]).toMatchObject({ state: "exited", exitCode: 0 });
    expect(decodeText(await p.getFile(c.id, proc.logPath))).toBe("bye\n");
    expect(p.fileStat(c.id, "/home/naive/.anybench/env")).toEqual({ mode: 0o600, size: 9 });
  });

  it("injects typed faults once per call", async () => {
    const p = new FakeProvider();
    p.failNext("create", new ProviderBillingError("insufficient_credits", { provider: "fake" }));
    const err = await caught(p.create({}));
    expect(err).toBeInstanceOf(ProviderBillingError);
    expect((err as ProviderError).retryable).toBe(false);
    await expect(p.create({})).resolves.toMatchObject({ status: "running" });
  });

  it("throws ProviderCapacityError past maxComputers, and frees a slot on destroy", async () => {
    const p = new FakeProvider({ maxComputers: 1 });
    const a = await p.create({});
    const err = await caught(p.create({}));
    expect(err).toBeInstanceOf(ProviderCapacityError);
    expect((err as ProviderError).retryable).toBe(true);
    await p.destroy(a.id);
    await expect(p.create({})).resolves.toBeDefined();
  });

  it("a failed provision makes waitReady throw provision_failed and exec unavailable", async () => {
    const p = new FakeProvider();
    p.failNextProvision();
    const c = await p.create({});
    expect(isProviderError(await caught(p.waitReady(c.id)), "provision_failed")).toBe(true);
    expect(isProviderError(await caught(p.exec(c.id, "echo x")), "unavailable")).toBe(true);
  });

  it("waitReady times out while still creating", async () => {
    let now = 0;
    const p = new FakeProvider({ provisionDelayMs: 1_000, now: () => now });
    const c = await p.create({});
    expect(c.status).toBe("creating");
    expect(isProviderError(await caught(p.exec(c.id, "echo x")), "unavailable")).toBe(true);
    expect(
      isProviderError(await caught(p.waitReady(c.id, { timeoutMs: 1, intervalMs: 1 })), "timeout"),
    ).toBe(true);
    now = 1_000;
    await expect(p.waitReady(c.id)).resolves.toMatchObject({ status: "running" });
  });

  it("deleteSnapshot is refused while a live fork uses it", async () => {
    const { p, c } = await readyFake();
    const snap = await p.snapshot(c.id);
    const f = await p.fork(snap.snapshotId);
    expect(isProviderError(await caught(p.deleteSnapshot(snap.snapshotId)), "unavailable")).toBe(
      true,
    );
    await p.destroy(f.id);
    await expect(p.deleteSnapshot(snap.snapshotId)).resolves.toBeUndefined();
  });

  it("list can include destroyed computers", async () => {
    const { p, c } = await readyFake();
    await p.destroy(c.id);
    expect(await p.list()).toEqual([]);
    expect((await p.list({ includeDestroyed: true }))[0]).toMatchObject({
      id: c.id,
      status: "destroyed",
    });
  });
});
