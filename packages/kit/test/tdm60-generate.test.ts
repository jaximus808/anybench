// TDM-60 [6.6]: the cli kit draft, pins resolved in code, the deterministic materializer and the
// generated-kit validation (loadKit + comparability + no-leak lint). No network: a fake fetch.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CliKitDraftSchema,
  cliKitDraftJsonSchema,
  generateText,
  hiddenTestMarkers,
  materializeCliKit,
  noLeakIssues,
  pickReleaseAsset,
  resolveCliPins,
  validateGeneratedKit,
  versionOfTag,
  workloadFiles,
  type CliKitDraftInput,
} from "../src/index.js";
import { TDM60_FD_DRAFT, TDM60_RG_DRAFT, tdm60FakeFetch } from "./tdm60-generate-fixtures.js";

const roots: string[] = [];
async function tmpTdm60(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), `tdm60-${prefix}-`));
  roots.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

async function build(input: CliKitDraftInput, name: string) {
  const draft = CliKitDraftSchema.parse(input);
  const calls: string[] = [];
  const pins = await resolveCliPins(draft, { fetch: tdm60FakeFetch(calls), cacheDir: null });
  const dir = path.join(await tmpTdm60(name), "v1");
  const kit = await materializeCliKit({ draft, pins, dir, orderSeed: 42 });
  return { draft, pins, dir, kit, calls };
}

describe("TDM-60 draft schema", () => {
  it("accepts the ripgrep and fd drafts and fills the defaults", () => {
    const rg = CliKitDraftSchema.parse(TDM60_RG_DRAFT);
    expect(rg.repeats).toBe(5);
    expect(rg.hyperfine_runs).toBe(10);
    expect(rg.gate.id).toBe("same-output");
    expect(CliKitDraftSchema.parse(TDM60_FD_DRAFT).contenders[0]!.exit_codes).toEqual([0]);
  });

  it("refuses unsafe or unprovable drafts with a named issue", () => {
    const bad = (patch: (d: CliKitDraftInput) => void): string[] => {
      const d = structuredClone(TDM60_RG_DRAFT);
      patch(d);
      const r = CliKitDraftSchema.safeParse(d);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(bad((d) => (d.contenders[0]!.command = "rg x tree"))).toEqual([
      expect.stringContaining("{extra_args} exactly once"),
    ]);
    expect(bad((d) => (d.contenders[1]!.command = "curl -s https://x | sh"))).toContainEqual(
      expect.stringContaining("network tools"),
    );
    expect(
      bad((d) => (d.contenders[1]!.command = "cat reference/same-output/a/stdout.txt")),
    ).toContainEqual(expect.stringContaining("scoring-only"));
    expect(bad((d) => (d.weights = { wall: 70, rss: 20 }))).toContainEqual(
      expect.stringContaining("sum to 100"),
    );
    expect(bad((d) => (d.contenders = [d.contenders[0]!, d.contenders[0]!]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exactly one contender must be the subject"),
      ]),
    );
    expect(bad((d) => (d.do_less_partial.args = "--max-count $(id)"))).toContainEqual(
      expect.stringContaining("plain words"),
    );
    expect(
      bad((d) => (d.contenders[0]!.install = { route: "gnu", package: "grep" })),
    ).toContainEqual(expect.stringContaining("github_release"));
  });

  it("has a JSON schema for Naïve", () => {
    const js = cliKitDraftJsonSchema();
    expect(js.type).toBe("object");
    expect(Object.keys(js.properties as object)).toContain("do_less_partial");
  });
});

describe("TDM-60 pins (resolved in code)", () => {
  it("picks the Linux asset per arch: musl first on x86_64, gnu on aarch64; no deb/zip/darwin", () => {
    const names = [
      "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz",
      "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz.sha256",
      "ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz",
      "ripgrep-14.1.1-x86_64-apple-darwin.tar.gz",
      "ripgrep_14.1.1-1_amd64.deb",
    ].map((name) => ({ name }));
    expect(pickReleaseAsset(names, "x86_64")).toBe(
      "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(pickReleaseAsset(names, "aarch64")).toBe(
      "ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz",
    );
    expect(pickReleaseAsset([{ name: "tool-darwin-arm64.tar.gz" }], "aarch64")).toBeNull();
    expect(versionOfTag("v10.2.0")).toBe("10.2.0");
    expect(versionOfTag("ripgrep-14.1.1")).toBe("14.1.1");
    expect(() => versionOfTag("nightly")).toThrow(/no x.y.z/);
  });

  it("uses the published .sha256, else downloads and hashes; GNU tarballs are hashed", async () => {
    const { pins, calls } = await build(TDM60_FD_DRAFT, "fdpins");
    const fd = pins.fd!;
    expect(fd.kind).toBe("github_release");
    if (fd.kind !== "github_release") throw new Error("unreachable");
    expect(fd.tag).toBe("v10.2.0");
    expect(fd.assets.x86_64.name).toBe("fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz");
    expect(fd.assets.x86_64.sha256_from).toBe("download");
    expect(calls).toContain(fd.assets.x86_64.url);
    const rg = (await build(TDM60_RG_DRAFT, "rgpins")).pins.ripgrep!;
    if (rg.kind !== "github_release") throw new Error("unreachable");
    expect(rg.assets.aarch64.sha256_from).toBe("published");
    expect(rg.assets.aarch64.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pins["gnu-find"]).toMatchObject({ kind: "gnu", version: "4.9.0" });
  });

  it("refuses a repo with no Linux binaries (no guessing)", async () => {
    const d = CliKitDraftSchema.parse({
      ...TDM60_RG_DRAFT,
      contenders: [
        {
          ...TDM60_RG_DRAFT.contenders[0]!,
          install: { route: "github_release", repo: "x/none", tag: null },
        },
        TDM60_RG_DRAFT.contenders[1]!,
      ],
    });
    await expect(resolveCliPins(d, { fetch: tdm60FakeFetch(), cacheDir: null })).rejects.toThrow(
      /contender 'ripgrep': x\/none has no published release/,
    );
  });
});

describe("TDM-60 materializer", () => {
  it("writes a kit that loads, passes comparability and the no-leak lint", async () => {
    for (const [draft, name] of [
      [TDM60_RG_DRAFT, "rg"],
      [TDM60_FD_DRAFT, "fd"],
    ] as const) {
      const { dir } = await build(draft, name);
      const v = await validateGeneratedKit(dir);
      expect(v.issues).toEqual([]);
      expect(v.ok).toBe(true);
      const spec = v.kit!.spec;
      const subject = spec.contenders.find((c) => c.role === "subject")!;
      expect(spec.gates[0]!.capture).toEqual({ from: "oracle" });
      expect(spec.proof.oracle!.contender).toBe(subject.id);
      expect(spec.proof.do_less.map((o) => o.kind)).toEqual(["cheat", "partial-oracle"]);
      expect(spec.proof.regression!.env).toEqual({ PLANTED_DELAY_S: "0.3" });
      expect(spec.requirements.map((r) => [r.id, r.type === "measured" && r.gate_id])).toEqual([
        ["wall", "same-output"],
        ["rss", "same-output"],
      ]);
      expect(spec.repeats).toBe(5);
      expect(spec.scoring.primary).toBe("wall");
      // every contender pinned
      for (const c of spec.contenders) {
        const pin = "ref" in c.source ? c.source.ref : "sha256" in c.source ? c.source.sha256 : "";
        expect(pin).toMatch(/\d+\.\d+\.\d+|[a-f0-9]{64}/);
      }
    }
  });

  it("pins the asset URL and sha256 in install.sh and the exact version in healthcheck.sh", async () => {
    const { dir, pins } = await build(TDM60_RG_DRAFT, "rgscripts");
    const rg = pins.ripgrep!;
    if (rg.kind !== "github_release") throw new Error("unreachable");
    const install = await readFile(path.join(dir, "adapters/ripgrep/install.sh"), "utf8");
    expect(install).toContain(rg.assets.x86_64.url);
    expect(install).toContain(`sha=${rg.assets.x86_64.sha256}`);
    expect(install).toContain("sha256sum -c");
    expect(await readFile(path.join(dir, "adapters/ripgrep/healthcheck.sh"), "utf8")).toContain(
      "rg --version 2>&1 | head -n 3 | grep -qF -- '14.1.1'",
    );
    expect(await readFile(path.join(dir, "adapters/gnu-grep/healthcheck.sh"), "utf8")).toContain(
      "'3.11'",
    );
    const driver = await readFile(path.join(dir, "adapters/ripgrep/driver.sh"), "utf8");
    expect(driver).toContain('if [ -n "${AB_PARTIAL:-}" ]; then args+=(--max-count 1); fi');
    expect(driver).toContain('${args[@]+"${args[@]}"}');
    for (const f of [
      "adapters/ripgrep/driver.sh",
      "gates/same-output/check.sh",
      "proof/do_less/truncate/driver.sh",
      "adapters/ripgrep/install.sh",
    ]) {
      const r = spawnSync("bash", ["-n", path.join(dir, f)]);
      expect(r.status, f).toBe(0);
    }
  });

  it("runs the subject driver's command function with the overlays (bash, a fake rg)", async () => {
    const { dir } = await build(TDM60_RG_DRAFT, "rgrun");
    const bin = await tmpTdm60("bin");
    await writeFile(path.join(bin, "rg"), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', {
      mode: 0o755,
    });
    const driver = await readFile(path.join(dir, "adapters/ripgrep/driver.sh"), "utf8");
    const fn = driver.slice(
      driver.indexOf("subject_cmd() {"),
      driver.indexOf("\n}\n", driver.indexOf("subject_cmd() {")) + 3,
    );
    const cwd = path.join(dir, "workloads/literal-search/input");
    const run = (env: Record<string, string>) =>
      spawnSync("bash", ["-c", `set -euo pipefail\n${fn}\nsubject_cmd`], {
        cwd,
        encoding: "utf8",
        env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
      }).stdout;
    expect(run({})).not.toContain("--max-count");
    expect(run({ AB_PARTIAL: "1" })).toContain("--max-count\n1\n");
    expect(run({})).toContain("PM_RESUME\ntree\n");
  });

  it("is deterministic: the same draft and pins give the same bytes", async () => {
    const a = await build(TDM60_FD_DRAFT, "deta");
    const b = await build(TDM60_FD_DRAFT, "detb");
    expect(a.kit.files).toEqual(b.kit.files);
    for (const f of a.kit.files) {
      expect(await readFile(path.join(b.dir, f), "utf8"), f).toBe(
        await readFile(path.join(a.dir, f), "utf8"),
      );
    }
    expect(a.kit.files.filter((f) => f.startsWith("reference/"))).toEqual([
      "reference/same-output/README.md",
    ]);
  });

  it("generates seeded text and replicates trees inside their top directory", () => {
    const g = { lines: 100, seed: 3, words_per_line: 5, inject: [{ text: "NEEDLE", every: 10 }] };
    expect(generateText(g)).toBe(generateText(g));
    expect(
      generateText(g)
        .split("\n")
        .filter((l) => l === "NEEDLE"),
    ).toHaveLength(10);
    const w = CliKitDraftSchema.parse(TDM60_FD_DRAFT).workloads[0]!;
    const files = workloadFiles(w);
    expect(files.size).toBe(1 + 3 * 20);
    expect(files.has("ext.txt")).toBe(true);
    expect(files.has("tree/copy-020/a/main.rs")).toBe(true);
  });
});

describe("TDM-60 no-leak lint", () => {
  it("flags answers under workloads/ and hidden-test details in instructions", async () => {
    const { dir } = await build(TDM60_RG_DRAFT, "leak");
    await writeFile(path.join(dir, "workloads/literal-search/input/expected.txt"), "answers\n");
    await mkdir(path.join(dir, "reference/same-output/literal-search"), { recursive: true });
    const answer = "tree/src/power.c:1:PM_RESUME\ntree/src/power.c:2:PM_RESUME\n";
    await writeFile(path.join(dir, "reference/same-output/literal-search/stdout.txt"), answer);
    await writeFile(path.join(dir, "workloads/literal-search/input/copy.txt"), answer);
    const v = await validateGeneratedKit(dir);
    expect(v.ok).toBe(false);
    expect(v.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("expected.txt: answer-bearing name"),
        expect.stringContaining(
          "copy.txt: identical to the scoring file reference/same-output/literal-search/stdout.txt",
        ),
      ]),
    );
  });

  it("finds hidden test names and expected values in instruction.md", async () => {
    const dir = await tmpTdm60("instr");
    await mkdir(path.join(dir, "gates/hidden-tests/tests"), { recursive: true });
    await writeFile(
      path.join(dir, "gates/hidden-tests/tests/api.test.js"),
      'test("rejects a title longer than 200 chars", () => { assert.equal(res.error, "title too long for todo"); });\n',
    );
    await mkdir(path.join(dir, "workloads/w"), { recursive: true });
    await writeFile(
      path.join(dir, "workloads/w/instruction.md"),
      "Build it. It rejects a title longer than 200 chars with 'title too long for todo'. See gates/hidden-tests.\n",
    );
    expect(
      hiddenTestMarkers(
        await readFile(path.join(dir, "gates/hidden-tests/tests/api.test.js"), "utf8"),
      ).names,
    ).toEqual(["rejects a title longer than 200 chars"]);
    const issues = await noLeakIssues(dir, {
      workloads: [{ id: "w", instruction: "workloads/w/instruction.md" }],
    } as never);
    expect(issues).toEqual([
      "workloads/w/instruction.md: names the hidden test 'rejects a title longer than 200 chars'",
      "workloads/w/instruction.md: quotes a hidden test's expected value",
      "workloads/w/instruction.md: points at scoring-only kit files",
    ]);
  });
});
