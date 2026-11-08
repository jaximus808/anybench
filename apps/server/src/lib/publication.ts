// Publications (E12 minimal): build the frozen snapshot of a delivered run (core PublicationSchema)
// from its report, kit, run and trials. Pure: the route reads the rows and signs the result.
//
// Honest by construction (plan.md 17.2):
// - publishable() refuses unless the run is delivered and its gate is proven (all six checks) or
//   curated (oracle passes and do-nothing fails, verified offline): no number without a gate.
// - The snapshot carries the whole report: every setup, requirement, verdict and scope line.
// - badgeOf() words come from verdicts only: "better"/"worse" only when the decision rule called
//   it, "no detectable difference" otherwise, and "on these N tasks" when the claim is scoped.
import { randomBytes } from "node:crypto";
import {
  PROOF_CHECKS,
  PUBLICATION_SCHEMA,
  PublicationSchema,
  type Publication,
  type PublicationBadge,
  type PublicationEvaluation,
  type Report,
  SubjectKindSchema,
  type RunState,
  type SubjectKind,
  type Verdict,
} from "@anybench/core";
import { z } from "zod";
import { gatesOf } from "../orchestrator/proof-score.js";

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 20 chars of [a-z0-9] by rejection sampling (no modulo bias): ~103 bits. */
export function newPublicationSlug(): string {
  let out = "";
  while (out.length < 20) {
    for (const b of randomBytes(32)) {
      if (b >= 252) continue; // 252 = 7 × 36
      out += SLUG_ALPHABET[b % 36];
      if (out.length === 20) break;
    }
  }
  return out;
}

/** The loose kit shape we read (the stored spec is KitSpec; older rows may lack fields). */
const KitFactsSchema = z.object({
  subject: z.object({ name: z.string().min(1), kind: z.string() }).loose(),
  contenders: z
    .array(
      z
        .object({
          id: z.string(),
          name: z.string().optional(),
          role: z.string().optional(),
          version: z.string().optional(),
          versions: z.record(z.string(), z.string()).optional(),
          driver: z.object({ model: z.string().optional() }).loose().optional(),
        })
        .loose(),
    )
    .default([]),
  workloads: z
    .array(
      z
        .object({
          id: z.string(),
          title: z.string().optional(),
          params: z.record(z.string(), z.unknown()).optional(),
        })
        .loose(),
    )
    .default([]),
  gates: z
    .array(
      z
        .object({ id: z.string(), kind: z.string().optional(), description: z.string().optional() })
        .loose(),
    )
    .default([]),
  scoring: z.object({ primary: z.string().optional() }).loose().optional(),
});

export interface PublicationInput {
  slug: string;
  version: number;
  now: Date;
  run: { id: string; question: string; state: RunState; createdAt: Date; stageOutputs: unknown };
  kit: { spec: unknown; hash: string; version: number };
  report: Report;
  /** DB contender rows of the run: `source` is the kit contender id for kit-written rows. */
  contenders: { id: string; source: string; role: string }[];
  trials: {
    contenderId: string;
    repeat: number;
    state: string;
    gate: unknown;
    metrics: unknown;
    costMicroUsd: bigint;
  }[];
}

export type Publishable =
  { ok: true; basis: "proven" | "curated"; label: string } | { ok: false; reason: string };

/** Split the analyst's answer: "<headline> proof: … tokens: …". */
export function splitAnswer(answer: string): {
  headline: string;
  proof: string | null;
  disclosure: string | null;
} {
  const text = answer.trim();
  const find = (m: string) => (text.startsWith(m) ? 0 : text.indexOf(` ${m}`) + 1 || -1);
  const p = find("proof: ");
  const t = find("tokens: ");
  const cuts = [p, t].filter((i) => i > 0).sort((a, b) => a - b);
  const headline = (cuts.length ? text.slice(0, cuts[0]) : text).trim() || text;
  const part = (start: number) => {
    if (start < 0) return null;
    const end = [p, t].filter((i) => i > start).sort((a, b) => a - b)[0] ?? text.length;
    return text.slice(start, end).trim() || null;
  };
  return { headline, proof: part(p), disclosure: part(t) };
}

/** Proven (all six), curated (oracle + do-nothing, verified offline) or not publishable. */
export function publishable(run: { state: RunState }, report: Report): Publishable {
  if (run.state !== "delivered")
    return {
      ok: false,
      reason: `only a delivered run can be published (this one is ${run.state})`,
    };
  const passed = (c: (typeof PROOF_CHECKS)[number]) =>
    report.proof.some((p) => p.check === c && p.pass);
  if (PROOF_CHECKS.every(passed))
    return { ok: true, basis: "proven", label: "all six proof checks passed" };
  if (passed("oracle_passes") && passed("do_less_fails")) {
    const { proof } = splitAnswer(report.answer);
    const curated =
      (proof && /\bcurated\b/.test(proof) ? proof : null) ??
      report.proof
        .filter((p) => p.pass)
        .map((p) => /^proof: curated(?: \([^)]*\))?/.exec(p.reason)?.[0])
        .find(Boolean) ??
      null;
    if (curated) return { ok: true, basis: "curated", label: curated.replace(/^proof:\s*/, "") };
  }
  return {
    ok: false,
    reason:
      "the gate is not proven: the oracle must pass and the do-nothing contender must fail before a result is public",
  };
}

/** "C · Tandem ×3" → "Tandem ×3": the kit's setup letters mean nothing outside the report. */
export function shortName(name: string): string {
  return name.replace(/^[A-Z]\s*·\s*/, "").trim() || name;
}

const WORD: Record<Verdict, string> = {
  better: "better",
  worse: "worse",
  indistinguishable: "no detectable difference",
};

/** "Tandem ×1", "Tandem ×3" → "Tandem"; otherwise the kit's subject name, capitalized. */
function groupName(names: string[], fallback: string): string {
  if (names.length === 1) return names[0]!;
  let prefix = names[0] ?? "";
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[\s×x(·,-]+$/u, "").trim();
  if (prefix.length >= 3) return prefix;
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

export function badgeOf(report: Report, kitSubject: string, primary?: string): PublicationBadge {
  const baseline = report.contenders.find((c) => c.role === "baseline") ?? null;
  const others = report.contenders.filter((c) => c !== baseline);
  const subjects = others.some((c) => c.role === "subject")
    ? others.filter((c) => c.role === "subject")
    : others;
  const reqIds = report.contenders.flatMap((c) =>
    c.requirements.filter((r) => r.comparison).map((r) => r.requirement_id),
  );
  const requirement = primary && reqIds.includes(primary) ? primary : (reqIds[0] ?? null);
  const cmps = subjects.flatMap((c) => {
    const r = c.requirements.find((x) => x.requirement_id === requirement);
    return r?.comparison ? [{ name: shortName(c.name), cmp: r.comparison }] : [];
  });
  const base = baseline ? shortName(baseline.name) : null;
  const subjectName = groupName(
    subjects.map((c) => shortName(c.name)),
    kitSubject,
  );
  if (!baseline || cmps.length === 0) {
    const who = subjects.length === 1 ? shortName(subjects[0]!.name) : subjectName;
    return {
      subject: who,
      baseline: base,
      requirement,
      verdict: null,
      message: `${who}: no verdict at this n`,
      scope: null,
    };
  }
  const tasks = Math.max(...cmps.map((c) => c.cmp.n.tasks));
  const scoped = cmps.some((c) => c.cmp.claim === "these_tasks");
  const scope = scoped ? `on these ${tasks} task${tasks === 1 ? "" : "s"}` : null;
  const called = cmps.filter((c) => c.cmp.verdict !== "indistinguishable");
  const on = requirement ? ` on ${requirement}` : "";
  let subject: string;
  let verdict: Verdict;
  let message: string;
  if (called.length === 0) {
    subject = cmps.length === 1 ? cmps[0]!.name : subjectName;
    verdict = "indistinguishable";
    message = `${subject} vs ${base}: no detectable difference`;
  } else {
    const kinds = new Set(called.map((c) => c.cmp.verdict));
    verdict = kinds.size === 1 ? called[0]!.cmp.verdict : "indistinguishable";
    subject = called.map((c) => c.name).join(", ");
    message =
      kinds.size === 1
        ? `${subject} vs ${base}: ${WORD[verdict]}${on}`
        : `${subjectName} vs ${base}: mixed${on}, see report`;
    if (kinds.size !== 1) subject = subjectName;
  }
  return {
    subject,
    baseline: base,
    requirement,
    verdict,
    message: message.length > 160 ? `${message.slice(0, 157)}…` : message,
    scope,
  };
}

const SUBJECT_KINDS = new Set<string>(SubjectKindSchema.options);

export function buildPublication(input: PublicationInput): Publication {
  const { report, run, kit } = input;
  const facts = KitFactsSchema.parse(kit.spec);
  const proof = publishable(run, report);
  if (!proof.ok) throw new Error(proof.reason);
  const { headline, disclosure } = splitAnswer(report.answer);

  const kitById = new Map(facts.contenders.map((c) => [c.id, c]));
  const sourceOf = new Map(input.contenders.map((c) => [c.id, c.source]));
  const specFor = (contenderId: string, name: string) => {
    const src = sourceOf.get(contenderId);
    if (src !== undefined) {
      const hit =
        kitById.get(src) ??
        facts.contenders.find((k) => src.startsWith(`${k.id}@`) || src.startsWith(`${k.id}:`));
      if (hit) return hit;
    }
    return facts.contenders.find((k) => k.name === name || k.id === name);
  };

  const graded = input.trials.filter(
    (t) => t.repeat >= 0 && (t.state === "done" || t.state === "failed_subject"),
  );
  const gatePassed = graded.filter((t) => {
    if (t.state !== "done") return false;
    const gs = Object.values(gatesOf(t.gate));
    return gs.length > 0 && gs.every((g) => g.applicable === false || g.pass);
  });
  const count = (pred: (t: PublicationInput["trials"][number]) => boolean) =>
    input.trials.filter(pred).length;

  const firstCmp = report.contenders
    .flatMap((c) => c.requirements.map((r) => r.comparison))
    .find((c) => c != null);
  const outputs = (run.stageOutputs ?? {}) as Record<string, unknown>;
  const finalized =
    typeof outputs.finalized_at === "string" && !Number.isNaN(Date.parse(outputs.finalized_at))
      ? new Date(outputs.finalized_at).toISOString()
      : report.generated_at;

  const preregParsed = z
    .object({
      files_sha256: z.string().nullable().optional(),
      frozen_at: z.iso.datetime({ offset: true }).optional(),
    })
    .safeParse(outputs.prereg);
  const prereg = preregParsed.success ? preregParsed.data : null;

  const evaluation: PublicationEvaluation = {
    kit_hash: kit.hash,
    kit_version: kit.version,
    kit_files_sha256: prereg?.files_sha256 ?? null,
    preregistered_at: prereg?.frozen_at ?? null,
    run_started_at: run.createdAt.toISOString(),
    run_delivered_at: finalized,
    disclosure,
    setups: report.contenders.map((c) => {
      const spec = specFor(c.contender_id, c.name);
      return {
        contender_id: c.contender_id,
        name: c.name,
        role: c.role,
        model: spec?.driver?.model ?? null,
        version: spec?.version ?? null,
        versions: spec?.versions ?? {},
        graded_trials: graded.filter((t) => t.contenderId === c.contender_id).length,
      };
    }),
    tasks: facts.workloads.map((w) => {
      const hidden = w.params?.hidden_tests;
      const shape = w.params?.shape;
      return {
        id: w.id,
        title: w.title ?? w.id,
        hidden_tests: typeof hidden === "number" && Number.isInteger(hidden) ? hidden : null,
        shape: typeof shape === "string" ? shape : null,
      };
    }),
    gates: facts.gates.map((g) => ({
      id: g.id,
      kind: g.kind ?? "custom",
      description: g.description?.trim() ?? null,
    })),
    proof: { basis: proof.basis, label: proof.label, checks: report.proof },
    trials: {
      graded: graded.length,
      gate_passed: gatePassed.length,
      infra_excluded: count((t) => t.repeat >= 0 && t.state === "failed_infra"),
      cancelled: count((t) => t.repeat >= 0 && t.state === "cancelled"),
      warmups: count((t) => t.repeat < 0),
    },
    stats: {
      alpha: firstCmp?.alpha ?? null,
      family: firstCmp?.family ?? null,
      per_task_family: report.per_task?.family ?? null,
      per_task_scope: report.per_task?.scope ?? null,
    },
    metrics: {
      wall_clock: input.trials.some((t) => {
        const m = t.metrics as Record<string, unknown> | null;
        return m !== null && typeof m === "object" && typeof m.wall_s === "number";
      }),
      cost: input.trials.some((t) => t.costMicroUsd > 0n),
    },
  };

  const kind = SUBJECT_KINDS.has(facts.subject.kind) ? facts.subject.kind : "software";
  return PublicationSchema.parse({
    schema: PUBLICATION_SCHEMA,
    slug: input.slug,
    version: input.version,
    run_id: run.id,
    published_at: input.now.toISOString(),
    title: run.question,
    subject: { name: facts.subject.name, kind: kind as SubjectKind },
    verdict: headline,
    badge: badgeOf(report, facts.subject.name, facts.scoring?.primary),
    report,
    evaluation,
  });
}
