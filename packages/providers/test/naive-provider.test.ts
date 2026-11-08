// TDM-22: NaiveProvider behaviour beyond the shared contract: tags in the name, the home link,
// secret-safe putFile, the detached launch line, listing, error mapping and the rate card.
import { FakeNaive, fakeNaiveError, type NaiveComputersApi } from "@anybench/naive";
import { describe, expect, it } from "vitest";
import { isProviderError, type ProviderErrorCode } from "../src/errors.js";
import {
  buildDetachedCommand,
  decodeText,
  legacyBackgroundedListCommand,
  trialTag,
} from "../src/helpers.js";
import {
  decodeNaiveComputerName,
  encodeNaiveComputerName,
  naiveBlockPriceMicroUsd,
  naiveComputerCostMicroUsd,
  NaiveProvider,
  providerErrorFromNaive,
} from "../src/naive.js";

const RUN = "0190a1b2c3d4e5f60718293a4b5c6d7e";
const TRIAL = "0190a1b2c3d4e5f60718293a4b5c6d7f";

function setup(computers: ConstructorParameters<typeof FakeNaive>[0] = {}) {
  const naive = new FakeNaive({
    ...computers,
    computers: { timeScale: 0.01, ...computers.computers },
  });
  const p = new NaiveProvider({
    client: naive,
    readyIntervalMs: 5,
    putFileCheck: { attempts: 40, intervalMs: 10 },
  });
  return { naive, fake: naive.computers, p };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

async function expectCode(p: Promise<unknown>, code: ProviderErrorCode) {
  const e = await caught(p);
  expect(isProviderError(e), String(e)).toBe(true);
  expect((e as { code: string }).code).toBe(code);
  return e as Error & { code: string; retryable: boolean };
}

describe("tags in the Naïve computer name", () => {
  it("round-trips tags and a display name", () => {
    const tag = trialTag(RUN, TRIAL);
    const raw = encodeNaiveComputerName([tag, "ab-cache-x"], "trial box :: 1");
    expect(raw).toBe(`${tag} ab-cache-x :: trial box :: 1`);
    expect(decodeNaiveComputerName(raw)).toEqual({
      name: "trial box :: 1",
      tags: [tag, "ab-cache-x"],
    });
    expect(decodeNaiveComputerName(encodeNaiveComputerName([tag]))).toEqual({
      name: "",
      tags: [tag],
    });
    expect(decodeNaiveComputerName(encodeNaiveComputerName([], "plain"))).toEqual({
      name: "plain",
      tags: [],
    });
  });

  it("gives names it did not write no tags, so the reaper never claims them", () => {
    for (const raw of [
      "agent agt_01abc",
      "tdm170-worker",
      "ab-0190-0190",
      "computer",
      "x :: y z",
    ]) {
      expect(decodeNaiveComputerName(raw).tags).toEqual(raw === "x :: y z" ? ["x"] : []);
    }
    expect(decodeNaiveComputerName("ab-infra-worker :: host 1")).toEqual({
      name: "host 1",
      tags: ["ab-infra-worker"],
    });
  });

  it("refuses a name plus tags over Naïve's 200 chars", async () => {
    const { p } = setup();
    await expectCode(
      p.create({ name: "n".repeat(150), tags: [trialTag(RUN, TRIAL)] }),
      "validation",
    );
  });

  it("create writes the tags into the name; list and inspect read them back", async () => {
    const { p, fake } = setup();
    const tag = trialTag(RUN, TRIAL);
    const c = await p.waitReady(
      (await p.create({ name: "box", vcpu: 1, memoryMb: 1024, tags: [tag] })).id,
    );
    expect((await fake.get(c.id)).name).toBe(`${tag} :: box`);
    expect(c).toMatchObject({ name: "box", tags: [tag], provider: "naive", vcpu: 1 });
    expect((await p.inspect(c.id)).tags).toEqual([tag]);
  });
});

describe("home: fs root and shell home agree", () => {
  it("links /home/naive to the shell's $HOME once, with sudo, before the first exec", async () => {
    const { p, fake } = setup();
    const c = await p.waitReady((await p.create({ vcpu: 1, memoryMb: 512 })).id);
    expect(c.home).toBe("/home/naive");
    expect(fake.shellLink(c.id, "/home/naive")).toBe("/home/tenki");
    expect((await p.exec(c.id, "echo $HOME")).stdout).toBe("/home/tenki\n");
    await p.putFile(c.id, "a/b.txt", "hello\n");
    expect((await p.exec(c.id, "cat /home/naive/a/b.txt")).stdout).toBe("hello\n");
    expect((await p.exec(c.id, "cat ~/a/b.txt")).stdout).toBe("hello\n");
    const links = fake.commandHistory.filter((h) => h.command.includes("ln -s"));
    expect(links).toHaveLength(1);
    expect(links[0]!.command).toContain("sudo -n ln -s \"$HOME\" '/home/naive'");
  });

  it("fails loudly when the fs home is a different directory than $HOME", async () => {
    const { p, fake } = setup();
    const id = (await p.create({})).id;
    await fake.get(id); // running
    // Someone made /home/naive a real directory: exec and fs would see different files.
    await fake.exec(id, "sudo mkdir -p /home/naive");
    const e = await expectCode(p.exec(id, "echo hi"), "provider");
    expect(e.message).toContain("shell's home");
  });
});

describe("fork-403: getFile of a path whose directory does not exist yet", () => {
  // Live 2026-11-08 (docs/findings/naive-fs-missing-parent.md): fs/read answers a missing file
  // in an existing directory with 404, but a missing file whose parent directory is missing too
  // with 403 "path is outside the sandbox working directory". The executor's first fs op on a
  // freshly forked trial computer reads ~/eval/out/status.json before ~/eval exists, so the 403
  // failed every trial as provider_forbidden before the runner launched.
  it("the fake answers fs/read like live Naïve: 404 in an existing dir, 403 without the dir", async () => {
    const { p, fake } = setup();
    const c = await p.waitReady((await p.create({})).id);
    await expect(fake.readFile(c.id, "/home/naive/missing.txt")).rejects.toMatchObject({
      status: 404,
    });
    await expect(fake.readFile(c.id, "/home/naive/eval/out/status.json")).rejects.toMatchObject({
      status: 403,
      message: "path is outside the sandbox working directory",
    });
  });

  it("is not_found on a fork of an env image (home link + root install), and putFile works", async () => {
    const { p, fake } = setup();
    // The env build: home link (waitReady), subject files, a root-run install that writes into
    // $HOME, then the snapshot.
    const b = await p.waitReady((await p.create({ tags: ["ab-infra-envbuild-x"] })).id);
    await p.putFile(b.id, "/home/naive/kit/scripts/setup-workspace.sh", "#!/bin/sh\n", {
      mode: 0o755,
    });
    expect((await p.exec(b.id, `sudo -n mkdir -p "$HOME/.anybench/tandem"`)).exitCode).toBe(0);
    const snap = await p.snapshot(b.id);
    await p.destroy(b.id);

    // The trial: fork it and do what the executor does first.
    const f = await p.waitReady((await p.fork(snap.snapshotId, { tags: ["ab-r-t"] })).id);
    expect(f.home).toBe("/home/naive");
    expect(fake.shellLink(f.id, "/home/naive")).toBe("/home/tenki");
    await expectCode(p.getFile(f.id, "/home/naive/eval/out/status.json"), "not_found");
    await expectCode(p.getFile(f.id, "/home/naive/.anybench/nope/trial.json"), "not_found");
    await expectCode(p.getFile(f.id, "/home/naive/.anybench/trial.json"), "not_found");
    await p.putFile(f.id, "/home/naive/.anybench/proxy.env", "K=v\n", { mode: 0o600 });
    await p.putFile(f.id, "/home/naive/eval/in/x.txt", "x\n");
    expect(decodeText(await p.getFile(f.id, "/home/naive/.anybench/proxy.env"))).toBe("K=v\n");
    expect(decodeText(await p.getFile(f.id, "/home/naive/kit/scripts/setup-workspace.sh"))).toBe(
      "#!/bin/sh\n",
    );
  });

  it("a 403 for a path that does exist stays forbidden", async () => {
    const { p, naive } = setup();
    const c = await p.waitReady((await p.create({})).id);
    await p.putFile(c.id, "secret.txt", "s");
    naive.failNext("computers.fs.read", fakeNaiveError("forbidden", 403));
    await expectCode(p.getFile(c.id, "secret.txt"), "forbidden");
  });
});

describe("putFile", () => {
  it("never puts content on an exec command line, and a 0600 file is never 0644 with content", async () => {
    const { p, fake } = setup();
    const c = await p.waitReady((await p.create({})).id);
    const secret = "ANTHROPIC_API_KEY=sk-ant-tdm22-not-a-real-key\n";
    await p.putFile(c.id, ".anybench/env", secret, { mode: 0o600 });
    expect(fake.commandHistory.map((h) => h.command).join("\n")).not.toContain("sk-ant-tdm22");
    expect(fake.shellFile(c.id, "/home/tenki/.anybench/env")).toEqual({
      text: secret,
      mode: 0o600,
    });
    // the mode was set on the empty file, before fs/write
    const pre = fake.commandHistory.findIndex(
      (h) => h.command.includes("touch") && h.command.includes("chmod 600"),
    );
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(decodeText(await p.getFile(c.id, ".anybench/env"))).toBe(secret);
  });

  it("waits until the shell sees an fs write (the live box lags ~0.7 s)", async () => {
    const lag = { computers: { timeScale: 0.01, fsVisibilityDelayMs: 150 } };
    const { p } = setup(lag);
    const c = await p.waitReady((await p.create({})).id);
    await p.putFile(c.id, "x.txt", "v1");
    expect((await p.exec(c.id, "cat x.txt")).stdout).toBe("v1");

    // Without the check, an exec right after the write misses it.
    const naive = new FakeNaive(lag);
    const raw = new NaiveProvider({ client: naive, verifyPutFile: false, readyIntervalMs: 5 });
    const d = await raw.waitReady((await raw.create({})).id);
    await raw.putFile(d.id, "x.txt", "v1");
    expect((await raw.exec(d.id, "cat x.txt")).exitCode).toBe(1);
  });

  it("refuses paths outside the fs home before calling Naïve", async () => {
    const { p, naive } = setup();
    const c = await p.waitReady((await p.create({})).id);
    const before = naive.calls.length;
    await expectCode(p.putFile(c.id, "/home/tenki/x", "x"), "forbidden");
    await expectCode(p.getFile(c.id, "../../etc/passwd"), "forbidden");
    expect(naive.calls.slice(before).some((x) => x.method.startsWith("computers.fs"))).toBe(false);
  });
});

describe("execDetached", () => {
  it("returns at once even for a long job, unlike a backgrounded && list", async () => {
    const { p, fake } = setup({ computers: { timeScale: 0.01 } });
    const c = await p.waitReady((await p.create({})).id);
    const t0 = Date.now();
    const proc = await p.execDetached(c.id, "sleep 3000 && echo late", { logPath: "logs/run.log" });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(proc).toMatchObject({ logPath: "/home/naive/logs/run.log" });
    expect(proc.pid).toBeGreaterThan(0);
    expect(fake.commandHistory.at(-1)!.command).toBe(
      buildDetachedCommand("sleep 3000 && echo late", "/home/naive/logs/run.log"),
    );
    // The pre-TDM-22 line backgrounds `mkdir && setsid …` as one job whose subshell keeps the
    // exec's stdout: on live Naïve that held the call open until the timeout.
    const held = await p.exec(
      c.id,
      legacyBackgroundedListCommand("sleep 3000", "/home/naive/logs/b.log"),
      {
        timeoutMs: 1_000,
      },
    );
    expect(held.timedOut).toBe(true);
  });
});

describe("list", () => {
  it("pages through everything, skips agent computers and destroyed ones, filters by tag", async () => {
    const { p, fake } = setup();
    const tag = trialTag(RUN, TRIAL);
    const mine = await p.create({ tags: [tag] });
    const infra = await p.create({ name: "worker", tags: ["ab-infra-worker"] });
    const gone = await p.create({ tags: [trialTag(RUN, "gone")] });
    await p.destroy(gone.id);
    const agent = fake.seed({ name: "agent agt_fake01", agentId: "agt_fake01" });
    const foreign = fake.seed({ name: "tdm170-worker" });
    for (let i = 0; i < 105; i++) fake.seed({ name: `filler ${i}` });

    const all = (await p.list()).map((c) => c.id);
    expect(all).toHaveLength(108);
    expect(all).toEqual(expect.arrayContaining([mine.id, infra.id, foreign]));
    expect(all).not.toContain(agent);
    expect(all).not.toContain(gone.id);
    expect((await p.list({ includeDestroyed: true })).map((c) => c.id)).toContain(gone.id);

    const ours = (await p.list({ tagPrefix: "ab-" })).map((c) => c.id).sort();
    expect(ours).toEqual([mine.id, infra.id].sort());
    expect((await p.list({ tag })).map((c) => c.id)).toEqual([mine.id]);
  });
});

describe("errors", () => {
  const cases: Array<[string, number, ProviderErrorCode, boolean]> = [
    ["insufficient_credits", 402, "billing", false],
    ["subscription_required", 402, "billing", false],
    ["computer_unavailable", 409, "unavailable", true],
    ["state_conflict", 409, "unavailable", true],
    ["rate_limited", 429, "capacity", true],
    ["not_found", 404, "not_found", false],
    ["forbidden", 403, "forbidden", false],
    ["validation_failed", 400, "validation", false],
    ["internal_error", 500, "provider", false],
  ];
  for (const [naiveCode, status, code, retryable] of cases) {
    it(`maps ${status} ${naiveCode} to ${code}`, async () => {
      const { p, naive } = setup();
      naive.failNext("computers.create", fakeNaiveError(naiveCode, status));
      const e = await expectCode(p.create({}), code);
      expect(e.retryable).toBe(retryable);
      expect(e.message).toContain(naiveCode);
    });
  }

  it("a balance under one block is a billing error at create", async () => {
    const { p } = setup({ balanceMicroUsd: 11_099n });
    await expectCode(p.create({ vcpu: 1, memoryMb: 1024 }), "billing");
  });

  it("exec while creating is unavailable; a failed provision is provision_failed", async () => {
    const { p, fake } = setup({ computers: { timeScale: 0.01, provisionDelayMs: 10_000 } });
    const c = await p.create({});
    expect(c.status).toBe("creating");
    await expectCode(p.exec(c.id, "echo hi"), "unavailable");
    fake.failNextProvision();
    const { p: p2, fake: f2 } = setup();
    f2.failNextProvision();
    await expectCode(p2.waitReady((await p2.create({})).id), "provision_failed");
  });

  it("destroy is idempotent but never swallows a refusal on an agent's computer", async () => {
    const { p, fake } = setup();
    const c = await p.create({});
    await p.destroy(c.id);
    await p.destroy(c.id);
    await p.destroy("cmp_fake0000000000000000zzzzzz");
    const agent = fake.seed({ name: "agent agt_fake02", agentId: "agt_fake02" });
    await expectCode(p.destroy(agent), "unavailable");
  });

  it("maps non-Naïve failures to provider errors", () => {
    expect(providerErrorFromNaive(new Error("socket hang up")).code).toBe("provider");
  });
});

describe("untrusted results", () => {
  it("caps exec output at the provider's limit", async () => {
    const naive = new FakeNaive({ computers: { timeScale: 0.01 } });
    const p = new NaiveProvider({
      client: naive,
      readyIntervalMs: 5,
      capabilities: { maxOutputChars: 8 },
    });
    const c = await p.waitReady((await p.create({})).id);
    const r = await p.exec(c.id, "echo 0123456789abcdef");
    expect(r).toMatchObject({ stdout: "01234567", truncated: true, exitCode: 0 });
  });

  it("rejects an exec result that does not parse", async () => {
    const naive = new FakeNaive({ computers: { timeScale: 0.01 } });
    const computers: NaiveComputersApi = Object.create(naive.computers) as NaiveComputersApi;
    let calls = 0;
    computers.exec = async (id, command, opts) => {
      const r = await naive.computers.exec(id, command, opts);
      return ++calls === 1 ? r : { ...r, exitCode: 1.5 };
    };
    const p = new NaiveProvider({ client: { computers }, readyIntervalMs: 5 });
    const c = await p.waitReady((await p.create({})).id);
    await expectCode(p.exec(c.id, "echo hi"), "provider");
  });
});

describe("cost (rate card, bigint micro-USD)", () => {
  it("prices a block at 8 400 per vCPU + 2 700 per GiB", () => {
    expect(naiveBlockPriceMicroUsd({ vcpu: 1, memoryMb: 1024 })).toBe(11_100n);
    expect(naiveBlockPriceMicroUsd({ vcpu: 1, memoryMb: 512 })).toBe(9_750n);
    expect(naiveBlockPriceMicroUsd({ vcpu: 2, memoryMb: 4096 })).toBe(27_600n);
    expect(naiveBlockPriceMicroUsd({ vcpu: 1, memoryMb: 1000 })).toBe(8_400n + 2_637n); // 2636.7 up
  });

  it("matches the TDM-170 ledger: prorated first part-block, then a block per boundary", () => {
    const spec = { vcpu: 1, memoryMb: 1024 };
    // created 23:35:43.431Z, charged -4 747 at create
    expect(
      naiveComputerCostMicroUsd(spec, "2026-11-07T23:35:43.431Z", "2026-11-07T23:36:00Z"),
    ).toEqual({
      blocksBilled: 1,
      costMicroUsd: 4_747n,
    });
    // then -11 100 at 23:40, 23:50, 00:00 and 00:10
    expect(
      naiveComputerCostMicroUsd(spec, "2026-11-07T23:35:43.431Z", "2026-11-08T00:10:30Z"),
    ).toEqual({
      blocksBilled: 5,
      costMicroUsd: 4_747n + 4n * 11_100n,
    });
  });

  it("FakeNaive charges a block per create", async () => {
    const { p, fake, naive } = setup();
    const before = (await naive.credits.show()).balanceMicroUsd;
    await p.create({ vcpu: 2, memoryMb: 4096 });
    expect(fake.spentMicroUsd()).toBe(27_600n);
    expect((await naive.credits.show()).balanceMicroUsd).toBe(before - 27_600n);
  });
});
