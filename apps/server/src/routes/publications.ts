// Publications (E12 minimal, core apiRoutes.publications): the owner publishes a delivered run; the
// snapshot (lib/publication.ts) is signed with the Ed25519 publish key and stored as an immutable
// version under an unguessable slug. Anyone with the link reads it at GET /public/r/:slug, which
// also verifies the signature against /.well-known/anybench-keys.json. Withdrawing keeps the row
// and makes the page and badge read "withdrawn".
import {
  apiRoutes,
  ReportSchema,
  SignedPublicationSchema,
  type Attestation,
  type PublishedBenchmark,
  type PublishVersion,
  type Publication,
  type PublicationSummary,
  type RunState,
} from "@anybench/core";
import {
  loadSigningKey,
  PublishKeyError,
  serializeDocument,
  signDocument,
  type SigningKey,
  verifyDocument,
  WELL_KNOWN_KEYS_CACHE_CONTROL,
  wellKnownKeys,
} from "@anybench/publish";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { DbTx } from "../db/client.js";
import {
  contenders,
  kits,
  publishedBenchmarks,
  publishVersions,
  reports,
  runs,
  trials,
  users,
} from "../db/schema/index.js";
import { scopedDb } from "../db/scoped.js";
import {
  fail,
  isUniqueViolation,
  parseOrFail,
  send,
  type ActorContext,
  type ActorEnv,
} from "../lib/api-route.js";
import { requireScope } from "../lib/auth-key.js";
import { buildPublication, newPublicationSlug, publishable } from "../lib/publication.js";
import type { AppDeps } from "../types.js";

const contract = apiRoutes.publications;
const DEFAULT_WEB_URL = "https://anybench.jaxonp.com";
/** Public snapshots are immutable per version; the latest pointer may move, so cache briefly. */
const PUBLIC_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";

type Bench = typeof publishedBenchmarks.$inferSelect;
type Version = typeof publishVersions.$inferSelect;

function webBase(deps: AppDeps): string {
  return (deps.config.PUBLIC_WEB_URL ?? DEFAULT_WEB_URL).replace(/\/+$/, "");
}

function summaryOf(deps: AppDeps, bench: Bench, latest: Version): PublicationSummary {
  const pub = latest.reportJson as Publication;
  const page = `${webBase(deps)}/r/${bench.slug}`;
  return {
    slug: bench.slug,
    run_id: bench.runId as PublicationSummary["run_id"],
    status: bench.visibility === "withdrawn" ? "withdrawn" : "live",
    latest_version: latest.version,
    published_at: latest.createdAt.toISOString(),
    withdrawn_at: bench.withdrawnAt ? bench.withdrawnAt.toISOString() : null,
    page_url: page,
    badge_url: `${page}/badge.svg`,
    embed_url: `${page}/embed`,
    badge: pub.badge,
    verdict: pub.verdict,
  };
}

const toBase64Url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The older publish.publish response (TDM-206's dialog), from a stored version. */
function legacyPublishResponse(
  deps: AppDeps,
  out: { bench: Bench; current: Version; kitHash: string; owner: string },
  key: SigningKey,
): { benchmark: PublishedBenchmark; version: PublishVersion } | null {
  if (!/^[a-f0-9]{64}$/.test(out.kitHash)) return null;
  const pub = out.current.reportJson as Publication;
  const summary = summaryOf(deps, out.bench, out.current);
  const attestation: Attestation = {
    v: 1,
    benchmark_id: out.bench.id as Attestation["benchmark_id"],
    slug: out.bench.slug,
    version: out.current.version,
    run_id: pub.run_id,
    kit_hash: out.kitHash,
    contenders: pub.evaluation.setups.map((s) => ({
      contender_id: s.contender_id,
      name: s.name,
      version: s.version,
      snapshot_hash: null,
      score: null,
      ci95: null,
    })),
    trial_count: pub.evaluation.trials.graded,
    proof: pub.evaluation.proof.checks.map((p) => ({ check: p.check, pass: p.pass })),
    comped: pub.report.comped,
    created_at: out.current.createdAt.toISOString(),
  };
  return {
    benchmark: {
      id: out.bench.id as PublishedBenchmark["id"],
      owner: out.owner,
      slug: out.bench.slug,
      run_id: pub.run_id,
      title: pub.title,
      kind: pub.subject.kind,
      visibility: "unlisted",
      latest_version: out.current.version,
      pinned_version: null,
      auto_publish: false,
      page_url: summary.page_url,
      badge_url: summary.badge_url,
      embed_url: summary.embed_url,
      created_at: out.bench.createdAt.toISOString(),
    },
    version: {
      version: out.current.version,
      status: "live",
      report: pub.report,
      attestation,
      signature: toBase64Url(signDocument(attestation, key).signature),
      key_id: key.keyId,
      created_at: out.current.createdAt.toISOString(),
    },
  };
}

async function latestVersion(tx: DbTx, benchmarkId: string): Promise<Version | undefined> {
  const [v] = await tx
    .select()
    .from(publishVersions)
    .where(eq(publishVersions.benchmarkId, benchmarkId))
    .orderBy(desc(publishVersions.version))
    .limit(1);
  return v;
}

/** The env-shaped view of config that @anybench/publish reads. */
function keyEnv(deps: AppDeps): Record<string, string | undefined> {
  const c = deps.config;
  return {
    PUBLISH_SIGNING_KEY_ID: c.PUBLISH_SIGNING_KEY_ID,
    PUBLISH_SIGNING_PRIVATE_KEY_DER_B64: c.PUBLISH_SIGNING_PRIVATE_KEY_DER_B64,
    PUBLISH_SIGNING_PUBLIC_KEY_DER_B64: c.PUBLISH_SIGNING_PUBLIC_KEY_DER_B64,
    PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS: c.PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS,
  };
}

export function publicationsRoutes(deps: AppDeps): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  const write = requireScope(deps, "publish:write", { runIdParam: "id" });
  const read = requireScope(deps, "runs:read", { runIdParam: "id" });

  /** Freeze, sign and store (or reuse) the run's publication. Shared by both publish routes. */
  async function publishRun(c: ActorContext, runId: string) {
    let key;
    try {
      key = loadSigningKey(keyEnv(deps));
    } catch (e) {
      if (e instanceof PublishKeyError)
        return {
          ok: false as const,
          response: fail(c, "unavailable", "publishing is not configured (no signing key)"),
        };
      throw e;
    }
    type Outcome =
      | { kind: "ok"; bench: Bench; current: Version; kitHash: string; owner: string }
      | { kind: "fail"; code: "not_found" | "conflict"; message: string };
    let out: Outcome;
    try {
      out = await scopedDb(c.get("actor"), deps.db).transaction(async (tx): Promise<Outcome> => {
        const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
        if (!run) return { kind: "fail", code: "not_found", message: "run not found" };
        const [rep] = await tx
          .select({ json: reports.json })
          .from(reports)
          .where(eq(reports.runId, runId))
          .limit(1);
        const report = rep ? ReportSchema.safeParse(rep.json) : null;
        if (!report?.success)
          return { kind: "fail", code: "conflict", message: "this run has no readable report yet" };
        const ok = publishable({ state: run.state as RunState }, report.data);
        if (!ok.ok) return { kind: "fail", code: "conflict", message: ok.reason };
        const [kit] = run.kitId
          ? await tx.select().from(kits).where(eq(kits.id, run.kitId)).limit(1)
          : [];
        if (!kit) return { kind: "fail", code: "conflict", message: "this run has no kit" };

        // published_benchmarks has no RLS policy: filter by the run's owner explicitly.
        let [bench] = await tx
          .select()
          .from(publishedBenchmarks)
          .where(
            and(eq(publishedBenchmarks.runId, runId), eq(publishedBenchmarks.ownerId, run.ownerId)),
          )
          .limit(1);
        if (!bench) {
          [bench] = await tx
            .insert(publishedBenchmarks)
            .values({
              ownerId: run.ownerId,
              slug: newPublicationSlug(),
              runId,
              visibility: "unlisted",
            })
            .returning();
        }
        const latest = await latestVersion(tx, bench!.id);
        const prev = latest ? (latest.reportJson as Publication) : null;
        let current = latest;
        // Same report as the latest version: no new version (publishing is idempotent).
        if (!latest || prev?.report.generated_at !== report.data.generated_at) {
          const [ctRows, trRows] = await Promise.all([
            tx
              .select({ id: contenders.id, source: contenders.source, role: contenders.role })
              .from(contenders)
              .where(eq(contenders.runId, runId)),
            tx
              .select({
                contenderId: trials.contenderId,
                workloadId: trials.workloadId,
                repeat: trials.repeat,
                state: trials.state,
                gate: trials.gate,
                metrics: trials.metrics,
                costMicroUsd: trials.costMicroUsd,
              })
              .from(trials)
              .where(eq(trials.runId, runId)),
          ]);
          const version = (latest?.version ?? 0) + 1;
          const publication = buildPublication({
            slug: bench!.slug,
            version,
            now: new Date(),
            run: {
              id: run.id,
              question: run.question,
              state: run.state as RunState,
              createdAt: run.createdAt,
              stageOutputs: run.stageOutputs,
            },
            kit: { spec: kit.spec, hash: kit.hash, version: kit.version },
            report: report.data,
            contenders: ctRows,
            trials: trRows,
          });
          const signed = signDocument(publication, key);
          [current] = await tx
            .insert(publishVersions)
            .values({
              benchmarkId: bench!.id,
              version,
              reportJson: publication,
              attestation: signed,
              signature: signed.signature,
              keyId: signed.key_id,
              signedText: serializeDocument(signed),
            })
            .returning();
        }
        [bench] = await tx
          .update(publishedBenchmarks)
          .set({ visibility: "unlisted", withdrawnAt: null, updatedAt: new Date() })
          .where(eq(publishedBenchmarks.id, bench!.id))
          .returning();
        const [who] = await tx
          .select({ login: users.githubLogin })
          .from(users)
          .where(eq(users.id, run.ownerId))
          .limit(1);
        return {
          kind: "ok",
          bench: bench!,
          current: current!,
          kitHash: kit.hash,
          owner: who?.login ?? run.ownerId,
        };
      });
    } catch (e) {
      if (
        isUniqueViolation(e, "publish_versions_benchmark_version_uq") ||
        isUniqueViolation(e, "published_benchmarks_run_id_uq")
      )
        return {
          ok: false as const,
          response: fail(c, "conflict", "a publish for this run is already in progress; try again"),
        };
      throw e;
    }
    if (out.kind === "fail")
      return { ok: false as const, response: fail(c, out.code, out.message) };
    return { ok: true as const, ...out };
  }

  r.post("/runs/:id/publication", write, async (c) => {
    const route = contract.publish;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const out = await publishRun(c, parsed.request.params.id);
    if (!out.ok) return out.response;
    return send(c, route, { publication: summaryOf(deps, out.bench, out.current) });
  });

  // TDM-206's PublishDialog calls the older contract (publish.publish). Same publish; the chosen
  // slug, visibility and auto-publish are ignored (the link is an unguessable slug, unlisted).
  // The legacy `attestation` object is signed on its own with the same key, so its signature
  // is true of what it sits next to.
  r.post("/runs/:id/publish", write, async (c) => {
    const route = apiRoutes.publish.publish;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const out = await publishRun(c, parsed.request.params.id);
    if (!out.ok) return out.response;
    const legacy = legacyPublishResponse(deps, out, loadSigningKey(keyEnv(deps)));
    if (!legacy)
      return fail(
        c,
        "conflict",
        "this run's kit hash is not a sha256; use POST /runs/:id/publication",
      );
    return send(c, route, legacy);
  });

  async function ownBench(c: Parameters<typeof scopedDb>[0], runId: string) {
    return scopedDb(c, deps.db).transaction(async (tx) => {
      // RLS on runs: the run is only visible to its owner.
      const [run] = await tx
        .select({ ownerId: runs.ownerId })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      if (!run) return null;
      const [bench] = await tx
        .select()
        .from(publishedBenchmarks)
        .where(
          and(eq(publishedBenchmarks.runId, runId), eq(publishedBenchmarks.ownerId, run.ownerId)),
        )
        .limit(1);
      if (!bench) return { bench: null, latest: undefined };
      return { bench, latest: await latestVersion(tx, bench.id) };
    });
  }

  r.get("/runs/:id/publication", read, async (c) => {
    const route = contract.get;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const found = await ownBench(c.get("actor"), parsed.request.params.id);
    if (!found) return fail(c, "not_found", "run not found");
    if (!found.bench || !found.latest) return send(c, route, { publication: null });
    return send(c, route, { publication: summaryOf(deps, found.bench, found.latest) });
  });

  r.post("/runs/:id/publication/unpublish", write, async (c) => {
    const route = contract.unpublish;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const runId = parsed.request.params.id;
    const found = await ownBench(c.get("actor"), runId);
    if (!found) return fail(c, "not_found", "run not found");
    if (!found.bench || !found.latest) return fail(c, "not_found", "this run is not published");
    let bench: Bench = found.bench;
    if (bench.visibility !== "withdrawn") {
      const [updated] = await scopedDb(c.get("actor"), deps.db).transaction((tx) =>
        tx
          .update(publishedBenchmarks)
          .set({ visibility: "withdrawn", withdrawnAt: new Date(), updatedAt: new Date() })
          .where(eq(publishedBenchmarks.id, found.bench.id))
          .returning(),
      );
      if (updated) bench = updated;
    }
    return send(c, route, { publication: summaryOf(deps, bench, found.latest) });
  });

  // ── Public: no credentials. Reads go through the system actor (published rows only).
  const system = { kind: "system" as const, reason: "public publication page" };

  async function publicRow(slug: string, version: number | undefined) {
    return scopedDb(system, deps.db).transaction(async (tx) => {
      const [bench] = await tx
        .select()
        .from(publishedBenchmarks)
        .where(eq(publishedBenchmarks.slug, slug))
        .limit(1);
      if (!bench) return null;
      const all = await tx
        .select({ version: publishVersions.version, createdAt: publishVersions.createdAt })
        .from(publishVersions)
        .where(eq(publishVersions.benchmarkId, bench.id))
        .orderBy(desc(publishVersions.version));
      if (all.length === 0) return null;
      const want = version ?? all[0]!.version;
      const [row] = await tx
        .select()
        .from(publishVersions)
        .where(and(eq(publishVersions.benchmarkId, bench.id), eq(publishVersions.version, want)))
        .limit(1);
      return { bench, row, all };
    });
  }

  r.get("/public/r/:slug", async (c) => {
    const route = contract.public;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const { slug } = parsed.request.params;
    const found = await publicRow(slug, parsed.request.query.version);
    if (!found) return fail(c, "not_found", "no publication at this link");
    if (found.bench.visibility === "withdrawn") {
      c.header("cache-control", "public, max-age=30");
      return send(c, route, {
        status: "withdrawn",
        slug: found.bench.slug,
        withdrawn_at: (found.bench.withdrawnAt ?? found.bench.updatedAt).toISOString(),
      });
    }
    if (!found.row) return fail(c, "not_found", "no such version");
    const signed = SignedPublicationSchema.safeParse(JSON.parse(found.row.signedText));
    if (!signed.success) return fail(c, "internal", "the stored publication is not readable");
    let keyset: unknown;
    try {
      keyset = wellKnownKeys(keyEnv(deps));
    } catch {
      keyset = null;
    }
    const v = keyset
      ? verifyDocument(found.row.signedText, keyset)
      : { valid: false as const, reason: "no public key is configured to verify against" };
    c.header("cache-control", PUBLIC_CACHE);
    return send(c, route, {
      status: "live",
      signed: signed.data,
      verification: {
        valid: v.valid,
        key_id: v.valid ? v.key.key_id : null,
        reason: v.reason,
      },
      versions: found.all.map((x) => ({
        version: x.version,
        published_at: x.createdAt.toISOString(),
      })),
    });
  });

  r.get("/public/r/:slug/attestation.json", async (c) => {
    const parsed = await parseOrFail(c, contract.attestation);
    if (!parsed.ok) return parsed.response;
    const found = await publicRow(parsed.request.params.slug, parsed.request.query.version);
    if (!found?.row || found.bench.visibility === "withdrawn")
      return fail(c, "not_found", "no publication at this link");
    return c.body(found.row.signedText, 200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CACHE,
      "access-control-allow-origin": "*",
    });
  });

  r.get("/.well-known/anybench-keys.json", (c) => {
    try {
      const keys = wellKnownKeys(keyEnv(deps));
      return c.json(keys, 200, {
        "cache-control": WELL_KNOWN_KEYS_CACHE_CONTROL,
        "access-control-allow-origin": "*",
      });
    } catch (e) {
      if (e instanceof PublishKeyError)
        return fail(c, "unavailable", "no publish key is configured");
      throw e;
    }
  });

  return r;
}
