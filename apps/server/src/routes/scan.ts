// Scan routes (TDM-67, contract core apiRoutes.scan). Mounted at /scans.
//   POST /scans       store a scan request for a GitHub user or org: the listed repos (or none, so
//                     the scanner lists the owner's public repos itself), status `queued`
//   GET  /scans       the caller's scans, newest first
//   GET  /scans/:id   one scan with a verdict per repo
//
// No GitHub or Naïve call happens here. The understander ([6.2], scan flow [11.7]) picks up queued
// scans, fills `repos` with one verdict each and sets status/cost/finished_at.
// RLS (scans_tenant, migration 0003): a foreign scan id is a 404. Auth (TDM-66 requireScope):
// reads need `runs:read`, create `runs:write`; a key limited to specific runs gets 403 (a scan
// belongs to no run).
import { apiRoutes, ScanRepoSchema, uuidv7, type Scan } from "@anybench/core";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { scans } from "../db/schema/scans.js";
import { scopedDb } from "../db/scoped.js";
import {
  decodeCursor,
  encodeCursor,
  fail,
  iso,
  isoOrNull,
  parseOrFail,
  runLimited,
  send,
  type ActorContext,
  type ActorEnv,
} from "../lib/api-route.js";
import { requireScope } from "../lib/auth-key.js";
import type { AppDeps } from "../types.js";

const contract = apiRoutes.scan;

type ScanRow = typeof scans.$inferSelect;
type ScanRepo = z.infer<typeof ScanRepoSchema>;

export function toScan(row: ScanRow): Scan {
  const repos = z.array(ScanRepoSchema).safeParse(row.repos);
  return {
    id: row.id as Scan["id"],
    github_owner: row.githubOwner,
    status: row.status,
    repos: repos.success ? repos.data : [],
    cost_micro_usd: row.costMicroUsd,
    created_at: iso(row.createdAt),
    finished_at: isoOrNull(row.finishedAt),
  };
}

/** `name` or `owner/name` → `owner/name`, validated with the contract's repo pattern. */
export function normalizeScanRepos(
  owner: string,
  names: readonly string[],
): { ok: true; repos: string[] } | { ok: false; issues: string[] } {
  const repos: string[] = [];
  const issues: string[] = [];
  names.forEach((raw, i) => {
    const name = raw
      .trim()
      .replace(/^https:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
    const full = name.includes("/") ? name : `${owner}/${name}`;
    if (!ScanRepoSchema.shape.repo.safeParse(full).success) {
      issues.push(`body.repos[${i}]: expected 'repo' or 'owner/repo'`);
    } else if (!repos.some((r) => r.toLowerCase() === full.toLowerCase())) {
      repos.push(full);
    }
  });
  return issues.length ? { ok: false, issues } : { ok: true, repos };
}

function queuedRepo(repo: string): ScanRepo {
  return {
    repo,
    status: "queued",
    kind: null,
    summary: null,
    benchable: null,
    reason: null,
    better_means: [],
  };
}

export function scanRoutes(deps: AppDeps): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  const read = requireScope(deps, "runs:read");
  const write = requireScope(deps, "runs:write");
  const notRunLimited = async (c: ActorContext, next: () => Promise<void>) => {
    if (runLimited(c.get("actor")))
      return fail(c, "forbidden", "an API key limited to specific runs cannot use scans");
    await next();
  };

  r.post("/", write, notRunLimited, async (c) => {
    const route = contract.create;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const { body } = parsed.request;
    let requested: string[] | null = null;
    if (body.repos) {
      const norm = normalizeScanRepos(body.github_owner, body.repos);
      if (!norm.ok) return fail(c, "validation_failed", "invalid repos", norm.issues);
      requested = norm.repos.slice(0, body.max_repos);
    }
    const actor = c.get("actor");
    const [row] = await scopedDb(actor, deps.db).transaction((tx) =>
      tx
        .insert(scans)
        .values({
          id: uuidv7(),
          ownerId: actor.userId,
          githubOwner: body.github_owner,
          status: "queued",
          requestedRepos: requested,
          maxRepos: body.max_repos,
          repos: (requested ?? []).map(queuedRepo),
        })
        .returning(),
    );
    return send(c, route, { scan: toScan(row!) });
  });

  r.get("/", read, notRunLimited, async (c) => {
    const route = contract.list;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const { query } = parsed.request;
    const cursor = decodeCursor(query.cursor);
    if (cursor === null)
      return fail(c, "validation_failed", "invalid cursor", ["query.cursor: invalid cursor"]);
    const where: SQL[] = [];
    if (cursor)
      where.push(
        sql`(${scans.createdAt}, ${scans.id}) < (${cursor.c}::timestamptz, ${cursor.i}::uuid)`,
      );
    const rows = await scopedDb(c.get("actor"), deps.db).transaction((tx) =>
      tx
        .select({ scan: scans, c: sql<string>`${scans.createdAt}::text` })
        .from(scans)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(scans.createdAt), desc(scans.id))
        .limit(query.limit + 1),
    );
    const more = rows.length > query.limit;
    const page = more ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return send(c, route, {
      items: page.map((p) => toScan(p.scan)),
      next_cursor: more && last ? encodeCursor({ c: last.c, i: last.scan.id }) : null,
    });
  });

  r.get("/:id", read, notRunLimited, async (c) => {
    const route = contract.get;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const [row] = await scopedDb(c.get("actor"), deps.db).transaction((tx) =>
      tx.select().from(scans).where(eq(scans.id, parsed.request.params.id)).limit(1),
    );
    if (!row) return fail(c, "not_found", "scan not found");
    return send(c, route, { scan: toScan(row) });
  });

  return r;
}
