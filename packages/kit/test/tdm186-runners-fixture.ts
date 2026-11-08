// TDM-186 follow-up: monorepo fixtures for the miner. A Go module nested at apps/api (no root
// go.mod), and an npm workspace whose TypeScript tests run under `tsx --test` (tsx a devDependency)
// next to a TypeScript package that declares no loader.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Files = Record<string, string>;

async function gitRepo(repo: string): Promise<(msg: string, files: Files) => Promise<string>> {
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
        GIT_AUTHOR_DATE: `2026-04-${String(day).padStart(2, "0")}T12:00:00Z`,
        GIT_COMMITTER_DATE: `2026-04-${String(day).padStart(2, "0")}T12:00:00Z`,
      },
    }).trim();
  g("init", "-q", "-b", "main");
  return async (msg, files) => {
    for (const [p, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, p)), { recursive: true });
      await writeFile(join(repo, p), text);
    }
    g("add", "-A");
    g("-c", "commit.gpgsign=false", "commit", "-q", "-m", msg);
    day++;
    return g("rev-parse", "HEAD");
  };
}

export interface GoMonorepoFixture {
  repo: string;
  sha: Record<"init" | "fixClampLow" | "fixSlugTrim" | "multiModule", string>;
}

const goStore = (low: boolean) =>
  `package store\n\n// Clamp limits x to [lo, hi].\nfunc Clamp(x, lo, hi int) int {\n\tif x > hi {\n\t\treturn hi\n\t}\n${low ? "\tif x < lo {\n\t\treturn lo\n\t}\n" : ""}\treturn x\n}\n`;
const goStoreTest = (low: boolean) =>
  `package store\n\nimport "testing"\n\nfunc TestClampHigh(t *testing.T) {\n\tif got := Clamp(9, 0, 5); got != 5 {\n\t\tt.Fatalf("Clamp(9, 0, 5) = %d, want 5", got)\n\t}\n}\n${low ? `\nfunc TestClampLow(t *testing.T) {\n\tif got := Clamp(-3, 0, 5); got != 0 {\n\t\tt.Fatalf("Clamp(-3, 0, 5) = %d, want 0", got)\n\t}\n}\n` : ""}`;
const goSlug = (trim: boolean) =>
  `package text\n\nimport "strings"\n\n// Slug lowercases s and joins its words with dashes.\nfunc Slug(s string) string {\n\treturn strings.ReplaceAll(strings.ToLower(${trim ? 'strings.Join(strings.Fields(s), " ")' : "s"}), " ", "-")\n}\n`;
const goSlugTest = (trim: boolean) =>
  `package text\n\nimport "testing"\n\nfunc TestSlugLower(t *testing.T) {\n\tif got := Slug("Hello World"); got != "hello-world" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n${trim ? `\nfunc TestSlugTrims(t *testing.T) {\n\tif got := Slug("  Many   spaces "); got != "many-spaces" {\n\t\tt.Fatalf("Slug = %q, want %q", got, "many-spaces")\n\t}\n}\n` : ""}`;
const goQueue = (fixed: boolean) =>
  `package queue\n\n// Next returns the index after i in a ring of n.\nfunc Next(i, n int) int {\n\treturn ${fixed ? "(i + 1) % n" : "i + 1"}\n}\n`;
const goQueueTest = (fixed: boolean) =>
  `package queue\n\nimport "testing"\n\nfunc TestNext(t *testing.T) {\n\tif Next(0, 3) != 1 {\n\t\tt.Fatal("next")\n\t}\n}\n${fixed ? `\nfunc TestNextWraps(t *testing.T) {\n\tif got := Next(2, 3); got != 0 {\n\t\tt.Fatalf("Next(2, 3) = %d", got)\n\t}\n}\n` : ""}`;

/** Go modules at apps/api and apps/worker, none at the root (the Tandem layout). */
export async function buildGoMonorepoFixture(repo: string): Promise<GoMonorepoFixture> {
  const commit = await gitRepo(repo);
  const init = await commit("initial import", {
    "package.json": `{\n  "name": "go-mono",\n  "private": true\n}\n`,
    "apps/api/go.mod": "module example.com/api\n\ngo 1.22\n",
    "apps/api/internal/store/store.go": goStore(false),
    "apps/api/internal/store/store_test.go": goStoreTest(false),
    "apps/api/internal/text/slug.go": goSlug(false),
    "apps/api/internal/text/slug_test.go": goSlugTest(false),
    "apps/worker/go.mod": "module example.com/worker\n\ngo 1.22\n",
    "apps/worker/queue/queue.go": goQueue(false),
    "apps/worker/queue/queue_test.go": goQueueTest(false),
  });
  const fixClampLow = await commit("fix: clamp honours the lower bound", {
    "apps/api/internal/store/store.go": goStore(true),
    "apps/api/internal/store/store_test.go": goStoreTest(true),
  });
  const fixSlugTrim = await commit("fix: slug trims and collapses spaces", {
    "apps/api/internal/text/slug.go": goSlug(true),
    "apps/api/internal/text/slug_test.go": goSlugTest(true),
  });
  // One commit, tests in two modules: dropped with a reason (one module per task).
  const multiModule = await commit("fix: ring index wraps; slug idempotent", {
    "apps/worker/queue/queue.go": goQueue(true),
    "apps/worker/queue/queue_test.go": goQueueTest(true),
    "apps/api/internal/text/slug.go": `${goSlug(true)}\n// Idempotent: Slug(Slug(s)) == Slug(s).\n`,
    "apps/api/internal/text/slug_test.go": `${goSlugTest(true)}\nfunc TestSlugIdempotent(t *testing.T) {\n\tif Slug(Slug("A b")) != "a-b" {\n\t\tt.Fatal("idempotent")\n\t}\n}\n`,
  });
  return { repo, sha: { init, fixClampLow, fixSlugTrim, multiModule } };
}

export interface TsWorkspaceFixture {
  repo: string;
  sha: Record<"init" | "fixSlug" | "fixClamp" | "plainNoLoader", string>;
}

const TS_HEAD = `import { test } from "node:test";\nimport assert from "node:assert/strict";\n`;
const tsStrings = (fixed: boolean) =>
  `export function slugify(s: string): string {\n  return s${fixed ? ".trim()" : ""}.toLowerCase().replace(${fixed ? "/\\s+/g" : "/ /g"}, "-");\n}\n`;
const tsStringsTest = (fixed: boolean) =>
  `${TS_HEAD}import { slugify } from "../src/strings.ts";\n\ntest("slugify lowercases", () => assert.equal(slugify("Hello World"), "hello-world"));\n${fixed ? `test("slugify collapses whitespace", () => assert.equal(slugify("  Many   spaces "), "many-spaces"));\n` : ""}`;
const tsMath = (fixed: boolean) =>
  `export function clamp(x: number, lo: number, hi: number): number {\n  return ${fixed ? "Math.max(lo, Math.min(x, hi))" : "Math.min(x, hi)"};\n}\n`;
const tsMathTest = (fixed: boolean) =>
  `${TS_HEAD}import { clamp } from "../src/math.ts";\n\ntest("clamp caps at hi", () => assert.equal(clamp(9, 0, 5), 5));\n${fixed ? `test("clamp lifts to lo", () => assert.equal(clamp(-1, 0, 5), 0));\n` : ""}`;

/**
 * An npm workspace (root package-lock.json): packages/gw tests TypeScript with
 * `tsx --test test/*.test.ts` and tsx as a devDependency; tools/plain runs `node --test` on
 * TypeScript with no loader declared.
 */
export async function buildTsWorkspaceFixture(repo: string): Promise<TsWorkspaceFixture> {
  const here = dirname(fileURLToPath(import.meta.url));
  const lock = await readFile(join(here, "fixtures/tdm186-ts-workspace/package-lock.json"), "utf8");
  const commit = await gitRepo(repo);
  const init = await commit("initial import", {
    // Byte-for-byte the manifests the fixture lockfile was generated from (npm ci checks them).
    "package.json": `{\n  "name": "ts-mono",\n  "private": true,\n  "workspaces": ["packages/*"]\n}\n`,
    "package-lock.json": lock,
    "packages/gw/package.json": `{\n  "name": "@ts-mono/gw",\n  "version": "1.0.0",\n  "type": "module",\n  "scripts": { "test": "tsx --test test/*.test.ts" },\n  "devDependencies": { "tsx": "4.19.2" }\n}\n`,
    "packages/gw/src/strings.ts": tsStrings(false),
    "packages/gw/test/strings.test.ts": tsStringsTest(false),
    "packages/gw/src/math.ts": tsMath(false),
    "packages/gw/test/math.test.ts": tsMathTest(false),
    "tools/plain/package.json": `{\n  "name": "plain",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n`,
    "tools/plain/src/id.ts": `export const id = (x: number): number => x;\n`,
    "tools/plain/test/id.test.ts": `${TS_HEAD}import { id } from "../src/id.ts";\n\ntest("id", () => assert.equal(id(1), 1));\n`,
  });
  const fixSlug = await commit("fix: slugify collapses whitespace", {
    "packages/gw/src/strings.ts": tsStrings(true),
    "packages/gw/test/strings.test.ts": tsStringsTest(true),
  });
  const fixClamp = await commit("fix: clamp honours the lower bound", {
    "packages/gw/src/math.ts": tsMath(true),
    "packages/gw/test/math.test.ts": tsMathTest(true),
  });
  const plainNoLoader = await commit("fix: id of negative numbers", {
    "tools/plain/src/id.ts": `export const id = (x: number): number => (Object.is(x, -0) ? 0 : x);\n`,
    "tools/plain/test/id.test.ts": `${TS_HEAD}import { id } from "../src/id.ts";\n\ntest("id", () => assert.equal(id(1), 1));\ntest("id of -0", () => assert.ok(Object.is(id(-0), 0)));\n`,
  });
  return { repo, sha: { init, fixSlug, fixClamp, plainNoLoader } };
}
