import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "@anybench/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  EnvFileError,
  globToRegExp,
  matchFiles,
  parseArgs,
  parseEnvFile,
  parseMeminfo,
  parseProcStatCpu,
  parseTrialJob,
  RedactingLineWriter,
  runnerPaths,
  TrialJobError,
  writeTarGz,
} from "../src/index.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tdm46-unit-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("TrialJob", () => {
  const minimal = {
    version: 1,
    trial_id: "t1",
    run_id: "r1",
    attempt: 1,
    driver: { type: "cli", run: "true" },
    wall_clock_s: 60,
  };

  it("fills defaults", () => {
    const job = parseTrialJob(minimal);
    expect(job).toMatchObject({
      heartbeat_s: 15,
      warmup_runs: 0,
      collect: [],
      ingest: null,
      upload: { enabled: true, bundle_name: "out.tar.gz", plans: {} },
    });
  });

  it("rejects escaping collect globs, short tokens and unknown versions", () => {
    expect(() => parseTrialJob({ ...minimal, collect: ["../etc/passwd"] })).toThrow(TrialJobError);
    expect(() => parseTrialJob({ ...minimal, collect: ["/etc/*"] })).toThrow(TrialJobError);
    expect(() =>
      parseTrialJob({ ...minimal, ingest: { url: "http://x.test", token: "short" } }),
    ).toThrow(/ingest.token/);
    expect(() => parseTrialJob({ ...minimal, version: 2 })).toThrow(TrialJobError);
    expect(() => parseTrialJob({ ...minimal, trial_id: "../x" })).toThrow(TrialJobError);
  });
});

describe("env file", () => {
  it("parses KEY=VALUE with export, quotes and comments", () => {
    expect(
      parseEnvFile('# c\nexport A=1\nB = "two words\\n"\nC=\'lit $x\'\n\nD=plain  \nE="a=b"\n'),
    ).toEqual({ A: "1", B: "two words\n", C: "lit $x", D: "plain", E: "a=b" });
  });

  it("reports the line, never the value", () => {
    try {
      parseEnvFile('OK=1\nBAD="sk-secret-unterminated\n');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvFileError);
      expect((err as Error).message).toContain("line 2");
      expect((err as Error).message).not.toContain("sk-secret");
    }
    expect(() => parseEnvFile("1BAD=x")).toThrow(EnvFileError);
  });
});

describe("glob", () => {
  it.each([
    ["*.log", "a.log", true],
    ["*.log", "d/a.log", false],
    ["**/*.log", "a.log", true],
    ["**/*.log", "d/e/a.log", true],
    ["logs/**", "logs/x/y.txt", true],
    ["out/{a,b}.txt", "out/b.txt", true],
    ["out/{a,b}.txt", "out/c.txt", false],
    ["f?.txt", "f1.txt", true],
    ["[ab].txt", "a.txt", true],
    ["[!ab].txt", "a.txt", false],
    ["a.b", "axb", false],
  ])("%s matches %s: %s", (glob, path, want) => {
    expect(globToRegExp(glob).test(path)).toBe(want);
  });

  it("walks a directory without following symlinks", async () => {
    const d = tmp();
    await mkdir(join(d, "x/y"), { recursive: true });
    await writeFile(join(d, "x/y/a.log"), "1");
    await writeFile(join(d, "b.log"), "2");
    execFileSync("ln", ["-s", "/etc", join(d, "etc-link")]);
    expect(await matchFiles(d, ["**/*.log", "etc-link/**"])).toEqual(["b.log", "x/y/a.log"]);
  });
});

describe("tar.gz writer", () => {
  it("writes an archive system tar can extract, including long paths", async () => {
    const src = tmp();
    const long = `${"deep/".repeat(30)}file.txt`;
    await mkdir(join(src, long, ".."), { recursive: true });
    await writeFile(join(src, long), "long path\n");
    await writeFile(join(src, "a.txt"), "hello\n");
    await writeFile(join(src, "empty"), "");
    await writeFile(join(src, "big.bin"), Buffer.alloc(1024 * 1024 * 2 + 7, 7));
    const dest = join(tmp(), "b.tar.gz");
    await writeTarGz(src, ["a.txt", "empty", "big.bin", long], dest);
    const out = tmp();
    execFileSync("tar", ["-xzf", dest, "-C", out]);
    expect(await readFile(join(out, "a.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(join(out, "empty"), "utf8")).toBe("");
    expect((await readFile(join(out, "big.bin"))).length).toBe(1024 * 1024 * 2 + 7);
    expect(await readFile(join(out, long), "utf8")).toBe("long path\n");
  });
});

describe("RedactingLineWriter", () => {
  it("redacts secrets split across chunks and counts written bytes", async () => {
    const d = tmp();
    const path = join(d, "log");
    const w = new RedactingLineWriter(path, createRedactor({ K: "hunter2-secret" }));
    w.write("a hunter2-");
    w.write("secret b\nno newline at end", "[t] ");
    await w.close();
    const text = await readFile(path, "utf8");
    expect(text).toBe("[t] a [REDACTED:K] b\nno newline at end\n");
    expect(w.bytes).toBe(Buffer.byteLength(text));
  });
});

describe("machine probe parsers", () => {
  it("parses /proc/meminfo and the cpu line of /proc/stat", () => {
    expect(parseMeminfo("MemTotal:       16384 kB\nMemAvailable:    8000 kB\n")).toEqual({
      MemTotal: 16384,
      MemAvailable: 8000,
    });
    expect(parseProcStatCpu("cpu  10 0 5 80 1 0 0 4 0 0\ncpu0 1 1 1 1\n")).toEqual({
      total: 100,
      steal: 4,
    });
  });
});

describe("paths and CLI args", () => {
  it("roots every path under the given HOME", () => {
    const p = runnerPaths("/home/someone");
    expect(p.trialJson).toBe("/home/someone/.anybench/trial.json");
    expect(p.statusJson).toBe("/home/someone/eval/out/status.json");
    for (const v of Object.values(p)) expect(v.startsWith("/home/someone")).toBe(true);
  });

  it("parses --trial and --trial=", () => {
    expect(parseArgs(["--trial", "t1"])).toMatchObject({ trial: "t1" });
    expect(parseArgs(["--trial=t2", "--home", "/h"])).toMatchObject({
      trial: "t2",
      home: "/h",
    });
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});
