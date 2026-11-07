import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectDigestSchema } from "@anybench/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BinaryIngestError,
  BinaryIngestResultSchema,
  createDockerSandbox,
  detectFileType,
  dockerSandboxArgs,
  ingestBinary,
  roffToText,
  sandboxPlatformFor,
  type SandboxRunRequest,
  type SandboxRunner,
} from "../src/index.js";

const FIXED_NOW = () => new Date("2026-11-07T12:00:00Z");
const FAKE_KEY = "sk-ant-api03-TDM35FAKEkeyNOTreal0000000000000000";

function elfHeader(machine: number): Buffer {
  const b = Buffer.alloc(512);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  b.writeUInt16LE(2, 16);
  b.writeUInt16LE(machine, 18);
  return b;
}

/** A SandboxRunner that records requests and answers like a tiny CLI. */
function fakeSandbox(reply: (req: SandboxRunRequest) => string = () => "") {
  const calls: SandboxRunRequest[] = [];
  const run: SandboxRunner = async (req) => {
    calls.push(req);
    return { exitCode: 0, stdout: reply(req), stderr: "", timedOut: false };
  };
  return { run, calls };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tdm35-bin-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectFileType (magic bytes)", () => {
  it("classifies ELF by CPU, Mach-O, PE, scripts and archives", () => {
    expect(detectFileType(elfHeader(0x3e))).toEqual({ type: "elf", bits: 64, arch: "x86_64" });
    expect(detectFileType(elfHeader(0xb7))).toMatchObject({ type: "elf", arch: "aarch64" });
    expect(detectFileType(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]))).toEqual({
      type: "macho",
    });
    expect(detectFileType(Buffer.from("MZ\x90\x00"))).toEqual({ type: "pe" });
    expect(detectFileType(Buffer.from("#!/usr/bin/env bash\necho hi\n"))).toEqual({
      type: "script",
      interpreter: "/usr/bin/env bash",
    });
    expect(detectFileType(Buffer.from([0x1f, 0x8b, 8, 0]))).toEqual({ type: "gzip" });
    expect(detectFileType(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]))).toEqual({ type: "xz" });
    const tar = Buffer.alloc(512);
    tar.write("ustar", 257, "latin1");
    expect(detectFileType(tar)).toEqual({ type: "tar" });
    expect(detectFileType(Buffer.from("hello"))).toEqual({ type: "unknown" });
  });

  it("maps binaries to a sandbox platform, and refuses to run what Linux cannot", () => {
    expect(sandboxPlatformFor({ type: "elf", arch: "x86_64" })).toEqual({
      platform: "linux/amd64",
    });
    expect(sandboxPlatformFor({ type: "elf", arch: "aarch64" })).toEqual({
      platform: "linux/arm64",
    });
    expect(sandboxPlatformFor({ type: "script" })).toEqual({});
    expect(sandboxPlatformFor({ type: "macho" }).skip).toMatch(/Mach-O/);
    expect(sandboxPlatformFor({ type: "pe" }).skip).toMatch(/Windows/);
  });
});

describe("dockerSandboxArgs", () => {
  it("runs the subject read-only in a throwaway box with no network", () => {
    const args = dockerSandboxArgs(
      {
        binaryPath: "/tmp/x/subject",
        args: ["--help"],
        platform: "linux/amd64",
        timeoutMs: 10_000,
      },
      "anybench-ingest-abc",
      { pull: "never" },
    );
    const joined = args.join(" ");
    expect(args.slice(0, 2)).toEqual(["create", "--rm"]);
    expect(joined).toContain("--name anybench-ingest-abc");
    expect(joined).toContain("--network none");
    expect(joined).toContain("--pull never");
    expect(joined).toContain("--platform linux/amd64");
    expect(joined).toContain("--read-only");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--user 65534:65534");
    expect(joined).toContain("-v /tmp/x/subject:/bin/subject:ro");
    expect(args.slice(-3)).toEqual(["debian:stable-slim", "/bin/subject", "--help"]);
  });
});

describe("roffToText", () => {
  it("strips man macros and font escapes", () => {
    const txt = roffToText(
      '.TH RG 1\n.\\" comment\n.SH NAME\nrg \\- search \\fBfast\\fR\n.PP\nmore',
    );
    expect(txt).not.toContain(".SH");
    expect(txt).not.toContain("comment");
    expect(txt).toContain("NAME");
    expect(txt).toContain("rg - search fast");
  });
});

describe("ingestBinary with a tiny local test binary (fake sandbox, no network)", () => {
  it("captures help/version in the sandbox, never on the host, and redacts output", async () => {
    const bin = join(dir, "tinytool");
    await writeFile(bin, "#!/bin/sh\necho tinytool 1.4.2\n", { mode: 0o644 });
    const docs = join(dir, "TINY.md");
    await writeFile(docs, `# tinytool\nAPI key for the demo: ${FAKE_KEY}\n`);
    const sb = fakeSandbox((req) =>
      req.args[0] === "--version"
        ? "tinytool 1.4.2\n"
        : `tinytool: counts words in files quickly\nUsage: tinytool [FILE]...\nkey=${FAKE_KEY}\n`,
    );
    const res = await ingestBinary(
      {
        path: bin,
        upload_id: "upl_123",
        docs: [{ path: docs }, { name: "API.md", text: "GET /v1" }],
      },
      { sandbox: sb.run, now: FIXED_NOW },
    );

    expect(sb.calls.map((c) => c.args)).toEqual([["--help"], ["-h"], ["--version"]]);
    for (const c of sb.calls) {
      expect(c.binaryPath).not.toBe(bin); // a staged, executable copy
      expect(c.platform).toBeUndefined(); // scripts use the native image
      expect(c.timeoutMs).toBe(10_000);
    }
    expect(BinaryIngestResultSchema.parse(res)).toEqual(res);
    expect(ProjectDigestSchema.parse(res.digest)).toEqual(res.digest);
    expect(res.binary).toMatchObject({ name: "tinytool", type: "script", interpreter: "/bin/sh" });
    expect(res.digest).toMatchObject({
      kind: "software",
      name: "tinytool",
      source: { kind: "binary", upload_id: "upl_123", docs: ["TINY.md", "API.md"] },
      releases: { latest: "1.4.2" },
      suggested_driver_types: ["cli"],
      ingested_at: "2026-11-07T12:00:00.000Z",
    });
    expect(res.digest.summary).toContain("tinytool 1.4.2");
    expect(res.digest.summary).toContain("counts words in files quickly");
    expect(res.digest.hash).toBe(res.binary.sha256);
    expect(res.docs.map((d) => d.kind)).toEqual(["other", "api"]);
    expect(JSON.stringify(res)).not.toContain(FAKE_KEY);
    expect(res.captures[0]?.stdout).toContain("[REDACTED:ANTHROPIC_API_KEY]");
  });

  it("does not run a Mach-O binary at all", async () => {
    const bin = join(dir, "macbin");
    await writeFile(bin, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(64)]));
    const sb = fakeSandbox();
    const res = await ingestBinary({ path: bin }, { sandbox: sb.run, now: FIXED_NOW });
    expect(sb.calls).toHaveLength(0);
    expect(res.captures.every((c) => c.skipped?.includes("Mach-O"))).toBe(true);
    expect(res.digest.summary).toContain("Mach-O");
  });

  it("unpacks a release tarball, picks the ELF and reads the docs shipped with it", async () => {
    const root = join(dir, "pkg", "tool-2.0.0-x86_64-linux");
    await mkdir(join(root, "doc"), { recursive: true });
    await writeFile(join(root, "tool"), elfHeader(0x3e), { mode: 0o755 });
    await writeFile(join(root, "README.md"), "# tool\nDoes things.\n");
    await writeFile(join(root, "doc", "tool.1"), ".TH TOOL 1\n.SH NAME\ntool \\- does things\n");
    await writeFile(join(root, "LICENSE"), "MIT\n");
    const tgz = join(dir, "tool.tar.gz");
    execFileSync("tar", ["-czf", tgz, "-C", join(dir, "pkg"), "tool-2.0.0-x86_64-linux"]);

    const sb = fakeSandbox((req) =>
      req.args[0] === "--version" ? "tool 2.0.0" : "tool does things well",
    );
    const res = await ingestBinary({ path: tgz }, { sandbox: sb.run, now: FIXED_NOW });
    expect(res.binary).toMatchObject({
      name: "tool",
      type: "elf",
      arch: "x86_64",
      archive: { type: "gzip", member: "tool-2.0.0-x86_64-linux/tool" },
    });
    expect(res.digest.source).toMatchObject({ kind: "binary", sha256: res.binary.archive?.sha256 });
    expect(res.digest.hash).toBe(res.binary.sha256);
    expect(res.digest.hash).not.toBe(res.binary.archive?.sha256);
    expect(sb.calls.every((c) => c.platform === "linux/amd64")).toBe(true);
    expect(res.docs.map((d) => [d.name, d.kind])).toEqual([
      ["README.md", "readme"],
      ["doc/tool.1", "man"],
    ]);
    expect(res.docs[1]?.text).toContain("tool - does things");
    expect(res.digest.releases.latest).toBe("2.0.0");
  });

  it("downloads from a URL and enforces expected_sha256", async () => {
    const body = Buffer.from("#!/bin/sh\necho hi\n");
    const fakeFetch = (async () => new Response(body)) as unknown as typeof fetch;
    const sb = fakeSandbox(() => "hi there friend, a tool");
    const url = "https://example.com/releases/hi.sh";
    const res = await ingestBinary({ url }, { sandbox: sb.run, fetch: fakeFetch, now: FIXED_NOW });
    expect(res.digest.source).toMatchObject({ kind: "binary", url });
    expect(res.binary.name).toBe("hi.sh"); // no name given: the URL file name
    await expect(
      ingestBinary({ url, expected_sha256: "0".repeat(64) }, { sandbox: sb.run, fetch: fakeFetch }),
    ).rejects.toMatchObject({ code: "sha256_mismatch" });
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(
      ingestBinary({ url }, { sandbox: sb.run, fetch: notFound }),
    ).rejects.toBeInstanceOf(BinaryIngestError);
  });

  it("rejects input with both or neither of url and path", async () => {
    await expect(ingestBinary({})).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      ingestBinary({ url: "https://example.com/x", path: "/tmp/x" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// Real Docker, but never the network: `--pull never`, and skipped when the image is not local.
const IMAGE = "debian:stable-slim";
const dockerReady =
  spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10_000 }).status ===
  0;

describe.skipIf(!dockerReady)("docker sandbox (local image only)", () => {
  it("runs a tiny script as nobody with no network, and times out a hung one", async () => {
    const bin = join(dir, "sandboxed");
    await writeFile(
      bin,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "sandboxed 0.0.1"; exit 0; fi',
        'if [ "$1" = "-h" ]; then sleep 30; fi',
        'echo "uid=$(id -u) routes=$(tail -n +2 /proc/net/route | wc -l) eth0=$(ls /sys/class/net | grep -c ^eth)"',
      ].join("\n") + "\n",
    );
    const prefix = `tdm35-test-${process.pid}-${Date.now()}-`;
    const sandbox = createDockerSandbox({ pull: "never", namePrefix: prefix });
    const res = await ingestBinary({ path: bin }, { sandbox, now: FIXED_NOW });
    const [help, h, version] = res.captures;
    expect(help?.exit_code).toBe(0);
    expect(help?.stdout).toContain("uid=65534");
    expect(help?.stdout).toContain("routes=0 eth0=0"); // --network none: no routes, no NIC
    expect(h?.timed_out).toBe(true);
    expect(version?.stdout.trim()).toBe("sandboxed 0.0.1");
    expect(res.digest.releases.latest).toBe("0.0.1");
    // Every container of this run is gone, the timed-out one included (`--rm` is async, so poll).
    let left = "";
    for (let i = 0; i < 20; i++) {
      left = execFileSync("docker", ["ps", "-a", "-q", "--filter", `name=${prefix}`], {
        encoding: "utf8",
      }).trim();
      if (left === "") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(left).toBe("");
  }, 120_000);
});

describe("committed ripgrep 15.2.0 fixture (built once by fixtures/tdm35-ripgrep/build.mjs)", () => {
  it("is a valid ingest result for the Linux x86_64 release binary", async () => {
    const raw = JSON.parse(
      await readFile(
        new URL("./fixtures/tdm35-ripgrep/ripgrep-15.2.0.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    const res = BinaryIngestResultSchema.parse(raw);
    expect(ProjectDigestSchema.parse(res.digest)).toEqual(res.digest);
    expect(res.digest.source).toMatchObject({
      kind: "binary",
      url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz",
      sha256: res.binary.archive?.sha256,
    });
    expect(res.binary).toMatchObject({ name: "rg", type: "elf", arch: "x86_64", bits: 64 });
    expect(res.digest.hash).toBe(res.binary.sha256);
    expect(res.digest.releases.latest).toBe("15.2.0");
    expect(res.digest.suggested_driver_types).toEqual(["cli"]);
    expect(res.captures.map((c) => [c.args.join(" "), c.exit_code])).toEqual([
      ["--help", 0],
      ["-h", 0],
      ["--version", 0],
    ]);
    expect(res.captures[2]?.stdout).toMatch(/^ripgrep 15\.2\.0/);
    expect(res.captures[1]?.stdout).toContain("USAGE:");
    const man = res.docs.find((d) => d.kind === "man");
    expect(man?.name).toBe("doc/rg.1");
    expect(man?.text).not.toMatch(/^\.TH/m);
    expect(res.docs.some((d) => d.kind === "readme")).toBe(true);
  });
});
