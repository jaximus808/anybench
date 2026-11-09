// Comparable setups or no comparison (plan.md 17.2 rule 4, TDM-178 [16.7]).
//
// A kit compares contenders only when their setups are equal in everything except what is
// under test. validateKitDir refuses a kit unless:
// - every agent contender pins a model id (an http-agent pins its service instead), and
//   CLI/harness versions are pinned: no `latest`/
//   `main` in `versions`, in a github `ref`, or as an adapter script's `${VAR:-latest}` fallback;
// - a version key (e.g. CLAUDE_CODE_VERSION) is pinned to the same value for every contender;
// - caps (wall clock, tokens, spend, turns) are equal, unless the cap is the `vary` axis or
//   `unequal_caps_reason` says why;
// - every assist (`human_in_loop.policy` llm-reviewer / human-sim, tools) goes to every
//   contender or to none;
// - a contender that disables subagents disables both of Claude Code's names for them.
// Warnings: deprecated `token_cap`, different pinned models, no `schedule.order_seed`, an
// http-agent service with no pinned version.
//
// Pure: the caller hands in the adapter scripts' text, so this runs in tests and on the server.
import {
  driverTokenCapTokens,
  isAgentDriver,
  type Contender,
  type Driver,
  type KitSpec,
} from "@anybench/core";
import type { KitIssueCode } from "./issues.js";

export interface ComparabilityIssue {
  severity: "error" | "warning";
  code: KitIssueCode;
  /** KitSpec field the issue is about (positioned at anybench.yaml:LINE:COL by the validator). */
  at: PropertyKey[];
  message: string;
}

/** One adapter script of a contender, as read from the kit. */
export interface ContenderScript {
  contender: number;
  /** Kit-relative path, e.g. `adapters/claude-code/install.sh`. */
  path: string;
  /** The KitSpec field that names (or defaulted) the script, e.g. `install.script`. */
  field: readonly PropertyKey[];
  text: string;
}

// ---------------------------------------------------------------------------------------------
// What "pinned" means.

/** Names that move: a version or ref spelled like this is not a pin. */
const FLOATING =
  /^(latest|main|master|head|trunk|develop|dev|next|nightly|canary|stable|edge|beta|alpha|current|default|lts|tip)$/i;

/** Model aliases that resolve to whatever the provider ships today. */
const MODEL_ALIASES = /^(sonnet|opus|haiku|opusplan|default|best|auto|latest)$/i;

const HEX_SHA = /^[0-9a-f]{7,40}$/i;
const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * A version is pinned when it names exactly one release: `v?X.Y.Z` with an optional `-pre` and
 * `+build`, or a hex commit SHA (7–40 chars). `2`, `v2`, `2.0`, `^2.0.0`, `rc1`, `latest` are
 * ranges or dist-tags that move.
 */
export function isPinnedVersion(v: string): boolean {
  const s = v.trim();
  return EXACT_SEMVER.test(s) || HEX_SHA.test(s);
}

/**
 * A git ref is pinned when it is a commit SHA or a release tag with at least three numeric
 * components (`v0.1.0`, `14.1.1`, `ripgrep-14.1.1`). `main`, `release/1.2`, `stable-2` and `v1`
 * move. A `/` is allowed only after an explicit `refs/tags/` (`refs/tags/tool/v1.2.3`).
 */
export function isPinnedGitRef(ref: string): boolean {
  const s = ref.trim();
  if (HEX_SHA.test(s)) return true;
  const explicitTag = s.startsWith("refs/tags/");
  const tag = explicitTag ? s.slice("refs/tags/".length) : s;
  if (!explicitTag && tag.includes("/")) return false;
  return /^(?:[A-Za-z][\w./-]*?[-_@/])?v?\d+\.\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/.test(tag);
}

/**
 * Snapshot ids without a trailing date that still name one fixed model: OpenAI's older `-MMDD`
 * snapshots, and Anthropic's ids from Claude Opus 4.6 / Sonnet 4.6 on, which ship with no dated
 * variant (the id is the snapshot; `claude-opus-5-5`, never `claude-opus-5-5-2026…`). Earlier
 * Claude ids such as `claude-sonnet-4-5` stay aliases of a dated snapshot. Extend when a provider
 * ships another undated snapshot id.
 */
export const UNDATED_MODEL_SNAPSHOTS: ReadonlySet<string> = new Set([
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "gpt-4-0314",
  "gpt-4-0613",
  "gpt-4-1106-preview",
  "gpt-4-0125-preview",
  "gpt-3.5-turbo-0613",
  "gpt-3.5-turbo-1106",
  "gpt-3.5-turbo-0125",
]);

/** Families whose undated ids are aliases that move to the newest snapshot. */
const DATED_FAMILIES = /^(claude-|gpt-|o\d)/i;
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * A model id is pinned when it names one snapshot. `claude-*`, `gpt-*` and `o<digit>*` need a
 * trailing `-YYYYMMDD` or `-YYYY-MM-DD` (or an entry in UNDATED_MODEL_SNAPSHOTS):
 * `claude-sonnet-4-5`, `gpt-4o` and `o3` are aliases. Other providers: not an alias
 * (`sonnet`, `*-latest`) and has a digit.
 */
export function isPinnedModelId(m: string): boolean {
  const s = m.trim();
  if (s === "" || MODEL_ALIASES.test(s) || FLOATING.test(s)) return false;
  if (/[-_.@:]latest$/i.test(s)) return false;
  if (UNDATED_MODEL_SNAPSHOTS.has(s)) return true;
  if (DATED_FAMILIES.test(s)) return DATE_SUFFIX.test(s);
  return /\d/.test(s);
}

/**
 * An http-agent's model lives in the user's service, so the service itself must be pinned: a
 * `versions` entry, a pinned `version` (`name@1.2.3`), a binary sha256, or a pinned github ref.
 */
function servicePinned(c: Contender): boolean {
  if (Object.keys(c.versions ?? {}).length > 0) return true;
  if (c.version !== undefined && isPinnedVersion(c.version.slice(c.version.lastIndexOf("@") + 1)))
    return true;
  if ("sha256" in c.source) return true;
  return "github" in c.source && isPinnedGitRef(c.source.ref);
}

// ---------------------------------------------------------------------------------------------
// Caps.

interface CapField {
  label: string;
  /** The `vary` key that makes this cap the axis under test. */
  varyKey: string;
  /** Only these contenders carry the cap. */
  applies: (d: Driver) => boolean;
  value: (d: Driver) => string | undefined;
  /** Where the cap is written for this driver. */
  path: (d: Driver) => PropertyKey[];
}

const str = (v: number | bigint | undefined) => (v === undefined ? undefined : String(v));

export const COMPARABLE_CAPS: readonly CapField[] = [
  {
    label: "wall-clock cap (wall_clock_cap_s)",
    varyKey: "WALL_CLOCK_CAP_S",
    applies: () => true,
    value: (d) => str(d.wall_clock_cap_s),
    path: (d) => (d.wall_clock_cap_s === undefined ? ["driver"] : ["driver", "wall_clock_cap_s"]),
  },
  {
    label: "token cap in tokens (token_cap_tokens)",
    varyKey: "TOKEN_CAP_TOKENS",
    applies: isAgentDriver,
    value: (d) => str(driverTokenCapTokens(d)),
    path: (d) =>
      !isAgentDriver(d)
        ? ["driver"]
        : d.token_cap_tokens !== undefined
          ? ["driver", "token_cap_tokens"]
          : d.token_cap !== undefined
            ? ["driver", "token_cap"]
            : ["driver"],
  },
  {
    label: "spend cap in micro-USD (token_cap_micro_usd)",
    varyKey: "TOKEN_CAP_MICRO_USD",
    applies: isAgentDriver,
    value: (d) => (isAgentDriver(d) ? str(d.token_cap_micro_usd) : undefined),
    path: (d) =>
      isAgentDriver(d) && d.token_cap_micro_usd !== undefined
        ? ["driver", "token_cap_micro_usd"]
        : ["driver"],
  },
  {
    label: "turn cap (max_turns)",
    varyKey: "MAX_TURNS",
    applies: isAgentDriver,
    value: (d) => (isAgentDriver(d) ? str(d.max_turns) : undefined),
    path: (d) =>
      isAgentDriver(d) && d.max_turns !== undefined ? ["driver", "max_turns"] : ["driver"],
  },
];

// ---------------------------------------------------------------------------------------------
// Script scan: `${VAR:-latest}` fallbacks and `npm install pkg@latest` / unversioned installs.

const VAR_FALLBACK = /\$\{([A-Z][A-Z0-9_]*):?-([^}]*)\}/g;
/** Package installs; group 1 is `npx`/`bunx` (runs a package, may name no version). */
const PKG_INSTALL =
  /\b(?:npm\s+(?:install|i|add)|pnpm\s+add|yarn\s+(?:global\s+)?add|(npx|bunx))\b([^\n;&|]*)/g;

/** The token a `${VAR:-x}` sits in, with the fallback filled in: `@scope/pkg@latest`. */
function shownFallback(text: string, index: number, matchLength: number, fallback: string) {
  let start = index;
  while (start > 0 && !/[\s"'=]/.test(text[start - 1]!)) start--;
  const prefix = text.slice(start, index);
  const after = text.slice(index + matchLength).match(/^[^\s"']*/)?.[0] ?? "";
  return `${prefix}${fallback}${after}`;
}

interface ScriptPin {
  kind: "fallback" | "literal";
  /** For `fallback`: the env var that pins it. */
  variable?: string;
  /** What gets installed when nothing pins it, e.g. `@anthropic-ai/claude-code@latest`. */
  shown: string;
}

function scanScript(text: string): ScriptPin[] {
  const out: ScriptPin[] = [];
  const code = text
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l))
    .join("\n");
  for (const m of code.matchAll(VAR_FALLBACK)) {
    const fallback = m[2]!.trim();
    // Only a moving default is a missing pin; `${OPT:-}` is an optional setting, not a version.
    if (!FLOATING.test(fallback)) continue;
    out.push({
      kind: "fallback",
      variable: m[1]!,
      shown: shownFallback(code, m.index, m[0].length, fallback),
    });
  }
  for (const m of code.matchAll(PKG_INSTALL)) {
    const runner = m[1] !== undefined;
    // `${VAR:?message with spaces}` is one shell word: collapse it before splitting on spaces.
    const words = m[2]!
      .replace(/\$\{[^}]*\}/g, "$V")
      .trim()
      .split(/\s+/);
    for (const raw of words) {
      const arg = raw.replace(/^["']|["']$/g, "");
      if (arg === "" || arg.startsWith("-") || arg.includes("$") || /^[./~]/.test(arg)) continue;
      if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@.*)?$/i.test(arg)) continue;
      const at = arg.indexOf("@", arg.startsWith("@") ? 1 : 0);
      const version = at < 0 ? undefined : arg.slice(at + 1);
      if (version !== undefined && isPinnedVersion(version)) continue;
      // `npx tsc` runs a local bin; only an explicit floating version (`npx pkg@latest`) counts.
      if (runner && version === undefined) continue;
      out.push({
        kind: "literal",
        shown: version === undefined ? `${arg} (no version, so latest)` : arg,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

const list = (ids: readonly string[]) => ids.join(", ");

/** driver.env key that picks a coding agent's token source (drivers/coding-agent TOKEN_SOURCE_ENV). */
const TOKEN_SOURCE_ENV_NAME = "AB_TOKEN_SOURCE";

/** Every comparability problem with a kit. Errors make the kit invalid; warnings do not. */
export function comparabilityIssues(
  spec: KitSpec,
  scripts: readonly ContenderScript[] = [],
): ComparabilityIssue[] {
  const out: ComparabilityIssue[] = [];
  const add = (
    severity: ComparabilityIssue["severity"],
    code: KitIssueCode,
    at: PropertyKey[],
    message: string,
  ) => out.push({ severity, code, at, message });
  const base = (i: number) => ["contenders", i] as PropertyKey[];
  const varyKeys = new Set(Object.keys(spec.vary));

  // 1. Pinned models, refs and versions.
  const models: [number, Contender, string][] = [];
  spec.contenders.forEach((c, i) => {
    const d = c.driver;
    if (d.type === "http-agent") {
      // The model belongs to the user's service: pin the service instead.
      if (!servicePinned(c)) {
        add(
          "warning",
          "service_unpinned",
          [...base(i)],
          `http-agent contender '${c.id}' has no pinned version: set versions, a version like '${c.id}@1.2.3', a binary sha256 or a pinned github ref, so every trial talks to the same service`,
        );
      }
    }
    if (isAgentDriver(d)) {
      if (d.type === "http-agent") {
        if (d.model !== undefined && isPinnedModelId(d.model)) models.push([i, c, d.model]);
      } else if (d.model === undefined) {
        add(
          "error",
          "model_unpinned",
          [...base(i), "driver"],
          `contender '${c.id}' runs a model but driver.model is not set, so it runs whatever the CLI defaults to: pin a model id (e.g. claude-sonnet-4-5-20250929)`,
        );
      } else if (!isPinnedModelId(d.model)) {
        add(
          "error",
          "model_unpinned",
          [...base(i), "driver", "model"],
          `model '${d.model}' is an alias that moves: pin a model id (e.g. claude-sonnet-4-5-20250929)`,
        );
      } else models.push([i, c, d.model]);

      if (d.token_cap !== undefined && d.token_cap_tokens !== undefined) {
        add(
          "error",
          "token_cap_conflict",
          [...base(i), "driver", "token_cap"],
          "token_cap and token_cap_tokens are both set: keep token_cap_tokens",
        );
      } else if (d.token_cap !== undefined) {
        add(
          "warning",
          "token_cap_deprecated",
          [...base(i), "driver", "token_cap"],
          "token_cap is read as tokens: rename it to token_cap_tokens, or use token_cap_micro_usd for a spend cap",
        );
      }
    }

    if ("github" in c.source && !isPinnedGitRef(c.source.ref)) {
      add(
        "error",
        "ref_unpinned",
        [...base(i), "source", "ref"],
        `ref '${c.source.ref}' of ${c.source.github} is a branch that moves: pin a commit SHA or a release tag`,
      );
    }

    for (const [key, v] of Object.entries(c.versions ?? {})) {
      if (!isPinnedVersion(v)) {
        add(
          "error",
          "version_unpinned",
          [...base(i), "versions", key],
          `${key} '${v}' is not a pinned version: name one release (e.g. 2.0.14) or a commit SHA`,
        );
      }
    }
  });

  if (new Set(models.map(([, , m]) => m)).size > 1) {
    add(
      "warning",
      "model_mismatch",
      [...base(models[0]![0]), "driver", "model"],
      `contenders run different models (${models.map(([, c, m]) => `${c.id} ${m}`).join(", ")}): the comparison measures the model as well as the setup`,
    );
  }

  // Adapter scripts that fall back to `latest` when their pin is missing.
  const reported = new Set<string>();
  for (const s of scripts) {
    const c = spec.contenders[s.contender];
    if (c === undefined) continue;
    for (const pin of scanScript(s.text)) {
      if (pin.kind === "fallback") {
        const v = pin.variable!;
        const value = c.versions?.[v] ?? c.driver.env?.[v];
        if (value !== undefined) continue; // a floating value is reported on `versions` above
        const key = `${s.contender}\0${v}`;
        if (reported.has(key)) continue;
        reported.add(key);
        add(
          "error",
          "version_unpinned",
          [...base(s.contender), ...s.field],
          `${s.path} installs ${pin.shown} unless ${v} is set: pin it in contenders[${s.contender}].versions.${v}`,
        );
      } else {
        const key = `${s.contender}\0${pin.shown}`;
        if (reported.has(key)) continue;
        reported.add(key);
        add(
          "error",
          "version_unpinned",
          [...base(s.contender), ...s.field],
          `${s.path} installs ${pin.shown}: pin the version (e.g. pkg@\${PKG_VERSION} with versions.PKG_VERSION)`,
        );
      }
    }
  }

  // The same tool at the same version for every contender that pins it.
  const byKey = new Map<string, [number, string][]>();
  spec.contenders.forEach((c, i) => {
    for (const [k, v] of Object.entries(c.versions ?? {})) {
      byKey.set(k, [...(byKey.get(k) ?? []), [i, v]]);
    }
  });
  for (const [k, pins] of byKey) {
    if (varyKeys.has(k) || new Set(pins.map(([, v]) => v)).size <= 1) continue;
    const odd = pins.find(([, v]) => v !== pins[0]![1])!;
    add(
      "error",
      "version_mismatch",
      [...base(odd[0]), "versions", k],
      `${k} differs across contenders (${pins.map(([i, v]) => `${spec.contenders[i]!.id} ${v}`).join(", ")}): pin the same version, or make ${k} the vary axis`,
    );
  }

  // 2. Equal caps, unless the cap is the vary axis or unequal_caps_reason says why.
  for (const cap of COMPARABLE_CAPS) {
    const holders = spec.contenders
      .map((c, i) => [i, c] as const)
      .filter(([, c]) => cap.applies(c.driver));
    if (holders.length < 2) continue;
    const values = holders.map(([, c]) => cap.value(c.driver));
    if (new Set(values).size <= 1 || varyKeys.has(cap.varyKey)) continue;
    const shown = holders.map(([, c], j) => `${c.id} ${values[j] ?? "none"}`).join(", ");
    const [oddIdx, odd] = holders.find((_, j) => values[j] !== values[0])!;
    const at = [...base(oddIdx), ...cap.path(odd.driver)];
    if (spec.unequal_caps_reason !== undefined) {
      add(
        "warning",
        "caps_unequal",
        at,
        `${cap.label} differs across contenders (${shown}), allowed by unequal_caps_reason: ${spec.unequal_caps_reason}`,
      );
    } else {
      add(
        "error",
        "caps_unequal",
        at,
        `${cap.label} differs across contenders (${shown}): make it equal, make it the vary axis (${cap.varyKey}), or say why in unequal_caps_reason`,
      );
    }
  }

  // 3. Every assist goes to every contender or to none.
  const assists = new Map<string, PropertyKey[]>();
  const policy = spec.human_in_loop?.policy;
  if (policy !== undefined && policy !== "auto") assists.set(policy, ["human_in_loop", "policy"]);
  spec.contenders.forEach((c, i) =>
    (c.assists ?? []).forEach((a, j) => {
      if (!assists.has(a)) assists.set(a, [...base(i), "assists", j]);
    }),
  );
  for (const [a, at] of assists) {
    const missing = spec.contenders.filter((c) => !(c.assists ?? []).includes(a)).map((c) => c.id);
    if (missing.length === 0) continue;
    const what = at[0] === "human_in_loop" ? `human_in_loop.policy '${a}'` : `assist '${a}'`;
    add(
      "error",
      "assist_unequal",
      at,
      `${what} must reach every contender or none, but ${list(missing)} ${missing.length === 1 ? "does" : "do"} not declare it in assists[]: add assists: [${a}] to every contender, or drop it${at[0] === "human_in_loop" ? " (policy: auto)" : ""}`,
    );
  }

  // 4. Disabling subagents takes both of Claude Code's names for the tool (followup 16).
  spec.contenders.forEach((c, i) => {
    for (const [k, v] of Object.entries(c.driver.env ?? {})) {
      if (!k.includes("DISALLOWED_TOOLS")) continue;
      const tools = new Set(v.split(/[\s,]+/).filter(Boolean));
      const hasTask = tools.has("Task");
      const hasAgent = tools.has("Agent");
      if (hasTask === hasAgent) continue;
      const [has, lacks] = hasTask ? ["Task", "Agent"] : ["Agent", "Task"];
      add(
        "error",
        "subagents_not_disabled",
        [...base(i), "driver", "env", k],
        `${k} disallows '${has}' but not '${lacks}': Claude Code names its subagent tool Task in older versions and Agent in newer ones, so list both ("Task Agent") or contender '${c.id}' may still spawn subagents`,
      );
    }
  });

  // 4b. One token source for every agent contender (TDM-39): the Naïve proxy (default) and a
  // direct Anthropic key differ in effort, thinking and price, so mixing them measures the source.
  if (!varyKeys.has(TOKEN_SOURCE_ENV_NAME)) {
    const agents = spec.contenders
      .map((c, i) => [i, c] as const)
      .filter(([, c]) => c.driver.type === "coding-agent" || c.driver.type === "harness");
    const sources = agents.map(([, c]) => c.driver.env?.[TOKEN_SOURCE_ENV_NAME] ?? "naive_proxy");
    if (new Set(sources).size > 1) {
      const j = sources.findIndex((v) => v !== sources[0]);
      const [i, c] = agents[j]!;
      add(
        "error",
        "token_source_unequal",
        [...base(i), "driver", "env", TOKEN_SOURCE_ENV_NAME],
        `contenders get their tokens from different sources (${agents.map(([, a], k) => `${a.id} ${sources[k]}`).join(", ")}): set the same ${TOKEN_SOURCE_ENV_NAME} on every agent contender (default naive_proxy); '${c.id}' differs`,
      );
    }
  }

  // 5. Contender order rotates per round from a seed.
  const setups =
    spec.contenders.length + Math.max(0, ...Object.values(spec.vary).map((v) => v.length - 1));
  if (setups >= 2 && spec.schedule.order_seed === undefined) {
    add(
      "warning",
      "order_not_rotated",
      ["schedule"],
      "schedule.order_seed is not set, so contenders run in kit order every round: set a seed to rotate the order",
    );
  }

  return out;
}
