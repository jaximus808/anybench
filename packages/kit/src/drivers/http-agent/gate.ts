// The http-agent correctness gate (TDM-40 [4.8], gate kind `labeled-answers`).
//
// Runs on the scoring computer, in its own process, reading only frozen files: the conversation
// set (labels) and the transcripts the driver wrote. It never talks to the agent. Every
// conversation must pass:
//   - every labeled turn's reply matches its `expect`,
//   - the final reply matches `expected.answer`, the last reported outcome equals
//     `expected.outcome`, and the tool expectations hold;
//   - an unlabeled conversation must match the oracle's transcript (final reply, normalized).
// It writes gate.json ({pass, reason, evidence[]}) and labeled-answers.json (per-check detail).
// No latency or cost number counts unless this passes.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { GateResultSchema, type GateResult } from "@anybench/core";
import {
  isLabeledConversation,
  loadConversationSet,
  type AnswerMatcher,
  type Conversation,
  type ToolExpectation,
} from "./conversation.js";
import type { ToolCall } from "./mapping.js";
import {
  finalReply,
  readTranscript,
  httpAgentJson,
  TRANSCRIPTS_DIR,
  type Transcript,
} from "./transcript.js";

export const LABELED_ANSWERS_JSON = "labeled-answers.json";

function norm(s: string, caseSensitive: boolean): string {
  const t = s.replace(/\s+/g, " ").trim();
  return caseSensitive ? t : t.toLowerCase();
}

/** Short, single-line quote of a reply for a reason string. */
function quote(s: string | null, max = 80): string {
  if (s === null) return "no reply";
  const one = s.replace(/\s+/g, " ").trim();
  return JSON.stringify(one.length > max ? `${one.slice(0, max - 1)}…` : one);
}

const NUMBER_IN_TEXT = /-?\d[\d,]*(?:\.\d+)?/g;

/** Every way `reply` misses `m`; empty when it matches. */
export function matchAnswer(reply: string, m: AnswerMatcher): string[] {
  const cs = m.case_sensitive;
  const r = norm(reply, cs);
  const misses: string[] = [];
  if (m.equals !== undefined && r !== norm(m.equals, cs))
    misses.push(`does not equal ${JSON.stringify(m.equals)}`);
  for (const s of m.contains ?? [])
    if (!r.includes(norm(s, cs))) misses.push(`does not contain ${JSON.stringify(s)}`);
  if (m.any_of !== undefined && !m.any_of.some((s) => r.includes(norm(s, cs))))
    misses.push(`contains none of ${JSON.stringify(m.any_of)}`);
  for (const s of m.not_contains ?? [])
    if (r.includes(norm(s, cs))) misses.push(`contains ${JSON.stringify(s)}, which it must not`);
  if (m.regex !== undefined && !new RegExp(m.regex, cs ? "" : "i").test(reply))
    misses.push(`does not match /${m.regex}/`);
  if (m.number !== undefined) {
    const { value, tolerance } = m.number;
    const found = (reply.match(NUMBER_IN_TEXT) ?? []).map((n) => Number(n.replace(/,/g, "")));
    if (!found.some((n) => Math.abs(n - value) <= tolerance))
      misses.push(`has no number within ${tolerance} of ${value}`);
  }
  return misses;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    // Labels are often written as strings for ids the agent sends as numbers, and vice versa.
    return (
      (typeof a === "string" || typeof a === "number") &&
      (typeof b === "string" || typeof b === "number") &&
      String(a) === String(b)
    );
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  return (
    ak.length === bk.length &&
    ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

function callMatches(call: ToolCall, exp: ToolExpectation): boolean {
  if (call.name !== exp.name) return false;
  for (const [k, v] of Object.entries(exp.args ?? {}))
    if (!deepEqual(call.args[k], v)) return false;
  return true;
}

function describeTool(exp: ToolExpectation): string {
  return exp.args ? `${exp.name}(${JSON.stringify(exp.args)})` : exp.name;
}

export interface CheckResult {
  check: string;
  pass: boolean;
  detail?: string;
}

export interface ConversationVerdict {
  conversation_id: string;
  pass: boolean;
  checks: CheckResult[];
  /** One line per failed check, already prefixed with what was checked. */
  failures: string[];
}

/** Score one conversation against its labels (or the oracle's transcript when it has none). */
export function scoreConversation(
  c: Conversation,
  t: Transcript | null,
  oracle?: Transcript | null,
): ConversationVerdict {
  const checks: CheckResult[] = [];
  const add = (check: string, pass: boolean, detail?: string) =>
    checks.push({ check, pass, ...(detail !== undefined ? { detail } : {}) });

  if (t === null) {
    add("transcript", false, "no transcript: the driver did not record this conversation");
  } else {
    if (t.status === "error")
      add("completed", false, `the agent failed: ${t.error ?? "a turn errored"}`);

    c.turns.forEach((turn, i) => {
      if (turn.expect === undefined) return;
      const got = t.turns[i];
      const name = `turn ${i}`;
      if (got === undefined || got.status !== "ok" || got.reply === null) {
        add(name, false, `turn ${i} has no reply${got?.error ? ` (${got.error})` : ""}`);
        return;
      }
      const misses = matchAnswer(got.reply, turn.expect);
      add(
        name,
        misses.length === 0,
        misses.length
          ? `turn ${i} reply ${misses.join(", ")} (got ${quote(got.reply)})`
          : undefined,
      );
    });

    const final = finalReply(t);
    const exp = c.expected;
    if (exp?.answer !== undefined) {
      const misses = final === null ? ["is missing"] : matchAnswer(final, exp.answer);
      add(
        "final answer",
        misses.length === 0,
        misses.length ? `final answer ${misses.join(", ")} (got ${quote(final)})` : undefined,
      );
    }
    if (exp?.outcome !== undefined) {
      const got = [...t.turns].reverse().find((x) => x.outcome !== undefined)?.outcome;
      const ok = got !== undefined && got.toLowerCase() === exp.outcome.toLowerCase();
      add(
        "outcome",
        ok,
        ok
          ? undefined
          : `outcome is ${got === undefined ? "not reported" : JSON.stringify(got)}, expected ${JSON.stringify(exp.outcome)}`,
      );
    }
    const calls = t.turns.flatMap((x) => x.tool_calls);
    for (const exp of c.tools ?? []) {
      const n = calls.filter((call) => callMatches(call, exp)).length;
      const name = `tool ${exp.name}`;
      if (exp.forbidden) {
        add(
          name,
          n === 0,
          n === 0 ? undefined : `called forbidden tool ${describeTool(exp)} ${n}x`,
        );
      } else {
        const ok = n >= exp.min_calls;
        const seen = calls.length ? calls.map((x) => x.name).join(", ") : "none";
        add(
          name,
          ok,
          ok
            ? undefined
            : `expected ${exp.min_calls}+ call(s) to ${describeTool(exp)}, got ${n} (tools called: ${seen})`,
        );
      }
    }

    if (!isLabeledConversation(c)) {
      if (oracle === undefined || oracle === null) {
        add(
          "oracle match",
          false,
          "has no labels and no oracle transcript to match (add expected/expect, or pass --oracle)",
        );
      } else {
        const want = finalReply(oracle);
        const ok = want !== null && final !== null && norm(final, false) === norm(want, false);
        add(
          "oracle match",
          ok,
          ok ? undefined : `final answer ${quote(final)} differs from the oracle's ${quote(want)}`,
        );
      }
    }
  }

  const failures = checks.filter((x) => !x.pass).map((x) => x.detail ?? `${x.check} failed`);
  return { conversation_id: c.id, pass: failures.length === 0, checks, failures };
}

export interface HttpAgentGateReport {
  gate: GateResult;
  verdicts: ConversationVerdict[];
}

/** Build the gate verdict for a set of conversation verdicts. */
export function summarizeVerdicts(verdicts: readonly ConversationVerdict[]): GateResult {
  const evidence = [LABELED_ANSWERS_JSON];
  if (verdicts.length === 0)
    return { pass: false, reason: "no conversations were scored", evidence };
  const failed = verdicts.filter((v) => !v.pass);
  const checks = verdicts.reduce((n, v) => n + v.checks.length, 0);
  if (failed.length === 0) {
    return {
      pass: true,
      reason: `all ${verdicts.length} conversations match their labels (${checks} checks)`,
      evidence,
    };
  }
  const shown = failed.slice(0, 5).map((v) => `${v.conversation_id}: ${v.failures.join("; ")}`);
  const more = failed.length > shown.length ? `; and ${failed.length - shown.length} more` : "";
  return {
    pass: false,
    reason: `${failed.length} of ${verdicts.length} conversations failed: ${shown.join(" | ")}${more}`,
    evidence: [...evidence, ...failed.map((v) => `${TRANSCRIPTS_DIR}/${v.conversation_id}.json`)],
  };
}

export interface RunHttpAgentGateOptions {
  /** The conversation set (labels): `workloads/<id>/conversations/` in the kit. */
  conversationsDir: string;
  /** The frozen EVAL_OUT of the trial being scored. labeled-answers.json is written here. */
  outDir: string;
  /** Where gate.json goes. */
  verdictPath: string;
  /** A frozen EVAL_OUT of the oracle run, for unlabeled conversations (oracle match). */
  oracleOutDir?: string;
}

/**
 * Score a frozen trial and write gate.json. Never throws for a bad trial: anything that goes
 * wrong (bad labels, missing transcripts) is a failing gate.json with the reason.
 */
export async function runHttpAgentGate(
  opts: RunHttpAgentGateOptions,
): Promise<HttpAgentGateReport> {
  let gate: GateResult;
  let verdicts: ConversationVerdict[] = [];
  try {
    const conversations = await loadConversationSet(opts.conversationsDir);
    for (const c of conversations) {
      const r = await readTranscript(opts.outDir, c.id);
      let oracle: Transcript | null | undefined;
      if (!isLabeledConversation(c) && opts.oracleOutDir !== undefined) {
        const o = await readTranscript(opts.oracleOutDir, c.id);
        oracle = o.ok ? o.transcript : null;
      }
      if (r.ok) verdicts.push(scoreConversation(c, r.transcript, oracle));
      else {
        const v = scoreConversation(c, null);
        v.failures = [`transcript ${r.reason}: ${r.detail}`];
        v.checks = [{ check: "transcript", pass: false, detail: v.failures[0] as string }];
        verdicts.push(v);
      }
    }
    gate = summarizeVerdicts(verdicts);
  } catch (e) {
    verdicts = [];
    gate = { pass: false, reason: `gate error: ${(e as Error).message}`, evidence: [] };
  }
  gate = GateResultSchema.parse(gate);
  if (gate.evidence.includes(LABELED_ANSWERS_JSON)) {
    await writeFile(
      path.join(opts.outDir, LABELED_ANSWERS_JSON),
      httpAgentJson({ pass: gate.pass, conversations: verdicts }, 2) + "\n",
    );
  }
  await writeFile(opts.verdictPath, JSON.stringify(gate) + "\n");
  return { gate, verdicts };
}
