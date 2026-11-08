// TDM-186 [16.15]: a small git repo with fix+test commits, a flaky one, a docs-only one and the
// other shapes the miner must drop. node --test, CommonJS, no dependencies (so no install step).
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MineFixture {
  repo: string;
  sha: Record<
    | "init"
    | "fixSlugify"
    | "docs"
    | "fixClamp"
    | "testsOnly"
    | "lockOnly"
    | "flaky"
    | "sideDocs"
    | "merge"
    | "passesBefore"
    | "fixTitleEmpty"
    | "fixTruncate"
    | "fixPad",
    string
  >;
}

const T = `const test = require("node:test");\nconst assert = require("node:assert");\n`;

export async function buildMineFixtureRepo(repo: string): Promise<MineFixture> {
  await mkdir(repo, { recursive: true });
  let day = 1;
  const g = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
        GIT_AUTHOR_DATE: `2026-03-${String(day).padStart(2, "0")}T12:00:00Z`,
        GIT_COMMITTER_DATE: `2026-03-${String(day).padStart(2, "0")}T12:00:00Z`,
      },
    }).trim();
  const put = async (files: Record<string, string>): Promise<void> => {
    for (const [p, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, p)), { recursive: true });
      await writeFile(join(repo, p), text);
    }
  };
  const commit = async (msg: string, files: Record<string, string>): Promise<string> => {
    await put(files);
    g("add", "-A");
    g("-c", "commit.gpgsign=false", "commit", "-q", "-m", msg);
    day++;
    return g("rev-parse", "HEAD");
  };

  g("init", "-q", "-b", "main");
  const strings1 = `function slugify(s) {\n  return s.toLowerCase().replace(/ /g, "-");\n}\n\nfunction titleCase(s) {\n  return s.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");\n}\n\nmodule.exports = { slugify, titleCase };\n`;
  const stringsTest1 = `${T}const { slugify, titleCase } = require("../src/strings.js");\n\ntest("slugify lowercases", () => assert.strictEqual(slugify("Hello World"), "hello-world"));\ntest("titleCase capitalises each word", () => assert.strictEqual(titleCase("hello world"), "Hello World"));\n`;
  const init = await commit("initial import", {
    "package.json": `{\n  "name": "mine-fixture",\n  "version": "1.0.0",\n  "scripts": { "test": "node --test" }\n}\n`,
    "src/strings.js": strings1,
    "src/math.js": `function clamp(x, lo, hi) {\n  return Math.min(x, hi);\n}\n\nfunction sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n\nmodule.exports = { clamp, sum };\n`,
    "test/strings.test.js": stringsTest1,
    "test/math.test.js": `${T}const { sum } = require("../src/math.js");\n\ntest("sum adds", () => assert.strictEqual(sum([1, 2, 3]), 6));\n`,
  });

  const strings2 = strings1.replace(
    `return s.toLowerCase().replace(/ /g, "-");`,
    `return s.trim().toLowerCase().replace(/\\s+/g, "-");`,
  );
  const stringsTest2 = `${stringsTest1}test("slugify collapses runs of whitespace", () => assert.strictEqual(slugify("  Many   spaces here "), "many-spaces-here"));\n`;
  const fixSlugify = await commit("fix: slugify collapses whitespace", {
    "src/strings.js": strings2,
    "test/strings.test.js": stringsTest2,
  });

  const docs = await commit("docs: add a README", {
    "README.md": "# mine-fixture\n\nString helpers.\n",
  });

  const fixClamp = await commit("fix: clamp honours the lower bound", {
    "src/math.js": `function clamp(x, lo, hi) {\n  return Math.max(lo, Math.min(x, hi));\n}\n\nfunction sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n\nmodule.exports = { clamp, sum };\n`,
    "test/math.test.js": `${T}const { clamp, sum } = require("../src/math.js");\n\ntest("sum adds", () => assert.strictEqual(sum([1, 2, 3]), 6));\ntest("clamp raises values below the range", () => assert.strictEqual(clamp(-5, 0, 10), 0));\n`,
  });

  const stringsTest3 = `${stringsTest2}test("titleCase keeps a single word", () => assert.strictEqual(titleCase("solo"), "Solo"));\n`;
  const testsOnly = await commit("test: more titleCase coverage", {
    "test/strings.test.js": stringsTest3,
  });

  const lockOnly = await commit("chore: add a lockfile", {
    "package-lock.json": `{\n  "name": "mine-fixture",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {}\n}\n`,
  });

  // Flaky: the test passes only on every other run (a counter in /tmp), so outcomes flip.
  const flaky = await commit("fix: retry helper", {
    "src/retry.js": `function attempt() {\n  return true;\n}\n\nmodule.exports = { attempt };\n`,
    "test/retry.test.js": `${T}const fs = require("node:fs");\nconst counter = "/tmp/anybench-tdm186-flaky-count";\nlet n = 0;\ntry {\n  n = Number(fs.readFileSync(counter, "utf8")) || 0;\n} catch {}\nfs.writeFileSync(counter, String(n + 1));\nconst { attempt } = require("../src/retry.js");\n\ntest("attempt succeeds", () => assert.ok(attempt() && n % 2 === 0, "transient failure"));\n`,
  });

  g("checkout", "-q", "-b", "side");
  const sideDocs = await commit("docs: guide", { "docs/guide.md": "# Guide\n\nUse slugify.\n" });
  g("checkout", "-q", "main");
  await put({});
  g("-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "Merge branch side", "side");
  day++;
  const merge = g("rev-parse", "HEAD");

  // A refactor plus a test that already passes before it: not a fail-to-pass task.
  const strings4 = strings2.replace(
    `return s.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");`,
    `return s\n    .split(" ")\n    .map((w) => w[0].toUpperCase() + w.slice(1))\n    .join(" ");`,
  );
  const stringsTest4 = `${stringsTest3}test("titleCase keeps two words", () => assert.strictEqual(titleCase("ab cd"), "Ab Cd"));\n`;
  const passesBefore = await commit("refactor: titleCase", {
    "src/strings.js": strings4,
    "test/strings.test.js": stringsTest4,
  });

  const strings5 = strings4.replace(
    `.map((w) => w[0].toUpperCase() + w.slice(1))`,
    `.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))`,
  );
  const stringsTest5 = `${stringsTest4}test("titleCase of an empty string is empty", () => assert.strictEqual(titleCase(""), ""));\n`;
  const fixTitleEmpty = await commit("fix: titleCase on empty input", {
    "src/strings.js": strings5,
    "test/strings.test.js": stringsTest5,
  });

  const strings6 = strings5.replace(
    `module.exports = { slugify, titleCase };`,
    `function truncate(s, n) {\n  return s.length > n ? s.slice(0, n - 1) + "…" : s;\n}\n\nmodule.exports = { slugify, titleCase, truncate };`,
  );
  const fixTruncate = await commit("fix: add truncate for long labels", {
    "src/strings.js": strings6,
    "test/truncate.test.js": `${T}const { truncate } = require("../src/strings.js");\n\ntest("truncate shortens long text", () => assert.strictEqual(truncate("abcdefgh", 4), "abc…"));\ntest("truncate keeps short text", () => assert.strictEqual(truncate("abc", 4), "abc"));\n`,
    "CHANGELOG.md": "## 1.0.1\n\n- truncate\n",
  });

  const fixPad = await commit("fix: left pad numbers in labels", {
    "src/pad.js": `function padStart(s, n) {\n  return String(s).padStart(n, "0");\n}\n\nmodule.exports = { padStart };\n`,
    "test/pad.test.js": `${T}const { padStart } = require("../src/pad.js");\n\ntest("padStart pads with zeros", () => assert.strictEqual(padStart(7, 3), "007"));\n`,
  });

  return {
    repo,
    sha: {
      init,
      fixSlugify,
      docs,
      fixClamp,
      testsOnly,
      lockOnly,
      flaky,
      sideDocs,
      merge,
      passesBefore,
      fixTitleEmpty,
      fixTruncate,
      fixPad,
    },
  };
}
