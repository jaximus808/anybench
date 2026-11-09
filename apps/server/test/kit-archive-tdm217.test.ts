// TDM-217 [19.1]: the strict kit tarball reader and the temp-dir extractor. Pure (no Postgres).
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { KIT_UPLOAD_LIMITS } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { KitArchiveError, readKitArchive, type KitArchive } from "../src/lib/kit-upload/archive.js";
import { checkKitArchive, writeKitArchive } from "../src/lib/kit-upload/extract.js";
import {
  dirEntriesTdm217,
  paxBodyTdm217,
  tarTdm217,
  tgzTdm217,
} from "./helpers/kit-upload-tdm217.js";

const TANDEM_KIT = fileURLToPath(new URL("../../../kits/tandem-vs-claude-code", import.meta.url));

function refused(fn: () => unknown, code: string, status: number, match?: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(KitArchiveError);
    const e = err as KitArchiveError;
    expect(e.code, e.message).toBe(code);
    expect(e.status).toBe(status);
    if (match) expect(e.message).toMatch(match);
    return;
  }
  throw new Error(`expected KitArchiveError ${code}`);
}

const ok = { name: "anybench.yaml", data: "schema_version: 2\n" };

describe("readKitArchive refuses unsafe entries (TDM-217)", () => {
  it.each([
    ["../evil.sh", /escapes the kit/],
    ["a/../../evil", /escapes the kit/],
    ["./../evil", /escapes the kit/],
    ["/etc/passwd", /absolute path/],
    ["//etc/passwd", /absolute path/],
    ["C:/Windows/evil", /drive letter/],
    ["a\\..\\evil", /backslash/],
    ["a//b", /empty path segment/],
    ["a/./b", /\. segment/],
    ["bad\u0001name", /control character/],
  ])("path %j", (name, match) => {
    refused(() => readKitArchive(tgzTdm217([ok, { name, data: "x" }])), "unsafe_path", 400, match);
  });

  it("a `..` hidden in a pax path or the ustar prefix", () => {
    refused(
      () =>
        readKitArchive(
          tgzTdm217([
            ok,
            { name: "././@PaxHeader", type: "x", data: paxBodyTdm217({ path: "x/../../evil" }) },
            { name: "harmless", data: "x" },
          ]),
        ),
      "unsafe_path",
      400,
    );
    refused(
      () => readKitArchive(tgzTdm217([ok, { name: "evil", prefix: "../..", data: "x" }])),
      "unsafe_path",
      400,
    );
    refused(
      () =>
        readKitArchive(
          tgzTdm217([
            ok,
            { name: "././@LongLink", type: "L", data: "../evil\0" },
            { name: "h", data: "x" },
          ]),
        ),
      "unsafe_path",
      400,
    );
  });

  it("symlinks, hardlinks and pax linkpath", () => {
    refused(
      () =>
        readKitArchive(
          tgzTdm217([ok, { name: "gates/g/check.sh", type: "2", linkname: "/etc/passwd" }]),
        ),
      "link",
      400,
      /symlink/,
    );
    refused(
      () =>
        readKitArchive(tgzTdm217([ok, { name: "inside", type: "2", linkname: "anybench.yaml" }])),
      "link",
      400,
    );
    refused(
      () => readKitArchive(tgzTdm217([ok, { name: "h", type: "1", linkname: "anybench.yaml" }])),
      "link",
      400,
      /hard link/,
    );
    refused(
      () =>
        readKitArchive(
          tgzTdm217([
            ok,
            { name: "././@PaxHeader", type: "x", data: paxBodyTdm217({ linkpath: "/etc/shadow" }) },
            { name: "l", type: "2" },
          ]),
        ),
      "link",
      400,
    );
  });

  it.each(["3", "4", "6", "S", "V"])("special entry type %s", (type) => {
    refused(() => readKitArchive(tgzTdm217([ok, { name: "dev", type }])), "special_file", 400);
  });

  it("duplicates, case-folded duplicates and file/directory clashes", () => {
    refused(() => readKitArchive(tgzTdm217([ok, ok])), "duplicate", 400);
    refused(
      () =>
        readKitArchive(tgzTdm217([ok, { name: "A.sh", data: "1" }, { name: "a.sh", data: "2" }])),
      "duplicate",
      400,
    );
    refused(
      () => readKitArchive(tgzTdm217([ok, { name: "x", data: "1" }, { name: "x/y", data: "2" }])),
      "duplicate",
      400,
    );
    refused(
      () => readKitArchive(tgzTdm217([ok, { name: "x/y", data: "1" }, { name: "x", data: "2" }])),
      "duplicate",
      400,
    );
  });

  it("not gzip, a bad checksum, a truncated entry", () => {
    refused(() => readKitArchive(Buffer.from("PK\u0003\u0004 a zip")), "malformed", 400, /gzip/);
    refused(
      () => readKitArchive(tgzTdm217([{ ...ok, badChecksum: true }])),
      "malformed",
      400,
      /checksum/,
    );
    // A header plus 1 KiB of its 4 KiB body.
    const raw = tarTdm217([{ name: "big", data: Buffer.alloc(4096, 1) }]).subarray(0, 512 + 1024);
    refused(() => readKitArchive(gzipSync(raw)), "malformed", 400, /past the end/);
  });
});

describe("readKitArchive limits (TDM-217)", () => {
  const small = {
    ...KIT_UPLOAD_LIMITS,
    maxBytes: 64 * 1024,
    maxUnpackedBytes: 1024 * 1024,
    maxEntries: 10,
  };

  it("over the compressed size", () => {
    refused(() => readKitArchive(Buffer.alloc(small.maxBytes + 1, 0x1f), small), "too_large", 413);
  });

  it("a gzip bomb stops at the unpacked cap", () => {
    // 8 MiB of zeros gzips to ~8 KiB: under the compressed cap, far over the unpacked one.
    const bomb = tgzTdm217([ok, { name: "zeros", data: Buffer.alloc(8 * 1024 * 1024) }]);
    expect(bomb.byteLength).toBeLessThan(small.maxBytes);
    refused(() => readKitArchive(bomb, small), "too_large", 413, /unpacks to more than/);
  });

  it("the sum of file sizes over the unpacked cap", () => {
    const files = [0, 1, 2].map((i) => ({ name: `f${i}`, data: Buffer.alloc(400 * 1024, i) }));
    refused(
      () => readKitArchive(tgzTdm217([ok, ...files]), { ...small, maxUnpackedBytes: 1024 * 1024 }),
      "too_large",
      413,
    );
  });

  it("too many entries", () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ name: `w/${i}.txt`, data: "x" }));
    refused(
      () => readKitArchive(tgzTdm217([ok, ...files]), small),
      "too_large",
      413,
      /more than 10/,
    );
  });

  it("over-long paths and over-deep trees", () => {
    refused(
      () =>
        readKitArchive(
          tgzTdm217([
            ok,
            { name: "././@PaxHeader", type: "x", data: paxBodyTdm217({ path: "a".repeat(300) }) },
            { name: "a", data: "x" },
          ]),
        ),
      "unsafe_path",
      400,
      /segment longer/,
    );
    const deep = Array.from({ length: 40 }, () => "d").join("/");
    refused(
      () => readKitArchive(tgzTdm217([ok, { name: deep, data: "x" }])),
      "unsafe_path",
      400,
      /deeper/,
    );
  });
});

describe("readKitArchive accepts a normal kit (TDM-217)", () => {
  it("keeps exec bits (never setuid), drops macOS litter, implies parent dirs", () => {
    const a = readKitArchive(
      tgzTdm217([
        { name: "./", type: "5", mode: 0o755 },
        ok,
        { name: "gates/g/", type: "5", mode: 0o755 },
        { name: "gates/g/check.sh", data: "#!/bin/sh\n", mode: 0o4755 },
        { name: "readme.md", data: "hi", mode: 0o600 },
        { name: "._readme.md", data: "appledouble" },
        { name: "__MACOSX/._x", data: "litter" },
        { name: ".DS_Store", data: "litter" },
      ]),
    );
    expect(a.stripped).toBe("");
    expect(a.files.map((f) => [f.path, f.mode])).toEqual([
      ["anybench.yaml", 0o644],
      ["gates/g/check.sh", 0o755],
      ["readme.md", 0o644],
    ]);
    expect(a.dirs).toEqual(["gates/g"]);
  });

  it("strips one wrapping directory that holds anybench.yaml", () => {
    const a = readKitArchive(
      tgzTdm217([
        { name: "my-kit/", type: "5" },
        { name: "my-kit/anybench.yaml", data: "x" },
        { name: "my-kit/w/in.txt", data: "y" },
      ]),
    );
    expect(a.stripped).toBe("my-kit");
    expect(a.files.map((f) => f.path)).toEqual(["anybench.yaml", "w/in.txt"]);
    expect(a.dirs).toEqual([]);
  });
});

describe("writeKitArchive / checkKitArchive (TDM-217)", () => {
  it("re-checks every target against the extraction dir (defense in depth)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tdm217-"));
    try {
      const evil: KitArchive = {
        files: [{ path: "../escaped-tdm217", mode: 0o644, data: new Uint8Array([1]) }],
        dirs: [],
        stripped: "",
        unpackedBytes: 1,
      };
      await expect(writeKitArchive(evil, root)).rejects.toBeInstanceOf(KitArchiveError);
      expect(existsSync(path.join(root, "..", "escaped-tdm217"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates the curated Tandem kit from a tarball and removes the temp dir", async () => {
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith("anybench-kit-upload-"));
    const archive = readKitArchive(
      tgzTdm217(dirEntriesTdm217(TANDEM_KIT, "tandem-vs-claude-code")),
    );
    expect(archive.stripped).toBe("tandem-vs-claude-code");
    const checked = await checkKitArchive(archive);
    expect(checked.validation.lines).toEqual([]);
    expect(checked.validation.ok).toBe(true);
    expect(checked.treeHash).toMatch(/^[a-f0-9]{64}$/);
    const after = (await readdir(tmpdir())).filter((n) => n.startsWith("anybench-kit-upload-"));
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
    // Same bytes, same tree hash.
    expect((await checkKitArchive(archive)).treeHash).toBe(checked.treeHash);
  });

  it("exec bits survive extraction: losing them shows as validateKitDir warnings", async () => {
    const kept = await checkKitArchive(readKitArchive(tgzTdm217(dirEntriesTdm217(TANDEM_KIT))));
    expect(kept.validation.warnings.some((i) => i.code === "not_executable")).toBe(false);
    const entries = dirEntriesTdm217(TANDEM_KIT).map((e) => ({ ...e, mode: 0o644 }));
    const checked = await checkKitArchive(readKitArchive(tgzTdm217(entries)));
    expect(checked.validation.warnings.some((i) => i.code === "not_executable")).toBe(true);
    expect(checked.validation.lines.join("\n")).not.toContain(tmpdir());
  });
});
