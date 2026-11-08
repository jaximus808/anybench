// TDM-60 [6.6]: fixtures for the generated-kit tests: kit designer drafts for ripgrep and fd,
// and a fake `fetch` that serves GitHub release JSON, `.sha256` side files and tarball bytes.
import { createHash } from "node:crypto";
import type { CliKitDraftInput, PinFetch } from "../src/index.js";

export const TDM60_RG_DRAFT: CliKitDraftInput = {
  driver: "cli",
  subject: {
    name: "ripgrep",
    summary: "A line-oriented search tool that recursively searches directories for a regex.",
    better_means: ["same matches as GNU grep", "less wall-clock time", "lower peak memory"],
  },
  contenders: [
    {
      id: "ripgrep",
      role: "subject",
      name: "ripgrep",
      binary: "rg",
      install: { route: "github_release", repo: "BurntSushi/ripgrep", tag: "14.1.1" },
      version_command: "rg --version",
      command:
        'rg --no-heading --line-number --only-matching --color never --no-ignore --hidden {extra_args} -e "$(cat pattern.txt)" tree',
      exit_codes: [0, 1],
      why: "the repo under test",
    },
    {
      id: "gnu-grep",
      role: "baseline",
      name: "GNU grep",
      binary: "grep",
      install: { route: "gnu", package: "grep" },
      version_command: "grep --version",
      command: 'LC_ALL=C.UTF-8 grep -rnoP -e "$(cat pattern.txt)" tree',
      exit_codes: [0, 1],
      why: "the plain default recursive search every Linux box has",
    },
  ],
  workloads: [
    {
      id: "literal-search",
      title: "Literal needle over generated text",
      files: [
        { path: "pattern.txt", content: "PM_RESUME" },
        {
          path: "tree/logs/a.log",
          generate: { lines: 2000, seed: 7, inject: [{ text: "x PM_RESUME y", every: 97 }] },
        },
        { path: "tree/src/power.c", content: "int PM_RESUME = 1;\n/* PM_RESUME again */\n" },
      ],
      replicate: 3,
    },
    {
      id: "regex-search",
      title: "Regex over generated text",
      files: [
        { path: "pattern.txt", content: "[a-z]+_[0-9]{3}" },
        {
          path: "tree/data.txt",
          generate: { lines: 1500, seed: 11, inject: [{ text: "id abc_123 ok", every: 50 }] },
        },
      ],
    },
  ],
  gate: {
    description: "Exit 0 or 1, and the sorted path:line:match stdout equals the reference.",
    sort_lines: true,
    exit_codes: [0, 1],
  },
  do_less_partial: {
    id: "first-match-only",
    description: "Stops after the first match per file, so later matches are missing.",
    args: "--max-count 1",
  },
  weights: { wall: 70, rss: 30 },
};

export const TDM60_FD_DRAFT: CliKitDraftInput = {
  driver: "cli",
  subject: {
    name: "fd",
    summary: "A simple, fast and user-friendly alternative to find.",
    better_means: ["same files as find", "less wall-clock time", "lower peak memory"],
  },
  contenders: [
    {
      id: "fd",
      role: "subject",
      name: "fd",
      binary: "fd",
      install: { route: "github_release", repo: "sharkdp/fd", tag: null },
      version_command: "fd --version",
      command: 'fd --hidden --no-ignore --type f {extra_args} -e "$(cat ext.txt)" . tree',
      why: "the repo under test",
    },
    {
      id: "gnu-find",
      role: "baseline",
      name: "GNU find",
      binary: "find",
      install: { route: "gnu", package: "findutils" },
      version_command: "find --version",
      command: 'find tree -type f -name "*.$(cat ext.txt)"',
      why: "the plain default",
    },
  ],
  workloads: [
    {
      id: "by-extension",
      title: "Files by extension",
      files: [
        { path: "ext.txt", content: "rs" },
        { path: "tree/a/main.rs", content: "fn main() {}\n" },
        { path: "tree/a/lib.rs", content: "pub fn f() {}\n" },
        { path: "tree/b/readme.md", content: "# b\n" },
      ],
      replicate: 20,
    },
    {
      id: "c-files",
      title: "C sources",
      files: [
        { path: "ext.txt", content: "c" },
        { path: "tree/x/y.c", content: "int y;\n" },
        { path: "tree/x/z.h", content: "int z;\n" },
        { path: "tree/w.c", content: "int w;\n" },
      ],
      replicate: 10,
    },
  ],
  gate: { description: "The sorted list of paths equals the reference.", sort_lines: true },
  do_less_partial: {
    id: "max-one-result",
    description: "Stops after one result.",
    args: "--max-results 1",
  },
  weights: { wall: 80, rss: 20 },
  primary: "wall",
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Release JSON + side files + bytes for BurntSushi/ripgrep 14.1.1 and sharkdp/fd (latest = v10.2.0). */
export function tdm60FakeFetch(calls: string[] = []): PinFetch {
  const bytes = new Map<string, string>();
  const releases = new Map<string, unknown>();
  const rel = (repo: string, tag: string, names: string[], withSide: boolean) => {
    const assets: { name: string; browser_download_url: string }[] = [];
    for (const n of names) {
      const url = `https://github.com/${repo}/releases/download/${tag}/${n}`;
      bytes.set(url, `bytes of ${n}`);
      assets.push({ name: n, browser_download_url: url });
      if (withSide) {
        const side = `${url}.sha256`;
        bytes.set(side, `${sha(`bytes of ${n}`)}  ${n}\n`);
        assets.push({ name: `${n}.sha256`, browser_download_url: side });
      }
    }
    return { tag_name: tag, assets };
  };
  releases.set(
    "https://api.github.com/repos/BurntSushi/ripgrep/releases/tags/14.1.1",
    rel(
      "BurntSushi/ripgrep",
      "14.1.1",
      [
        "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz",
        "ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz",
        "ripgrep-14.1.1-x86_64-apple-darwin.tar.gz",
        "ripgrep_14.1.1-1_amd64.deb",
        "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip",
      ],
      true,
    ),
  );
  releases.set(
    "https://api.github.com/repos/sharkdp/fd/releases/latest",
    rel(
      "sharkdp/fd",
      "v10.2.0",
      [
        "fd-v10.2.0-x86_64-unknown-linux-gnu.tar.gz",
        "fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz",
        "fd-v10.2.0-aarch64-unknown-linux-gnu.tar.gz",
        "fd-v10.2.0-aarch64-unknown-linux-musl.tar.gz",
        "fd-musl_10.2.0_amd64.deb",
      ],
      false,
    ),
  );
  for (const u of [
    "https://ftp.gnu.org/gnu/grep/grep-3.11.tar.xz",
    "https://ftp.gnu.org/gnu/findutils/findutils-4.9.0.tar.xz",
  ])
    bytes.set(u, `bytes of ${u}`);
  return async (url) => {
    calls.push(url);
    const r = releases.get(url);
    if (r) return new Response(JSON.stringify(r), { status: 200 });
    const b = bytes.get(url);
    if (b !== undefined) return new Response(b, { status: 200 });
    return new Response("not found", { status: 404 });
  };
}
