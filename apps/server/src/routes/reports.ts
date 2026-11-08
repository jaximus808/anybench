// Report routes (core reportRoutes, plan.md P4): GET /runs/:id/report (JSON) and
// GET /runs/:id/report/markdown, read from the `reports` row the analyzing stage writes. 404 until
// then. RLS scopes the row to its owner; a run-scoped API key only reaches its own run.
import { apiRoutes, ReportSchema } from "@anybench/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { reports } from "../db/schema/reports.js";
import { scopedDb } from "../db/scoped.js";
import { fail, parseOrFail, send, type ActorEnv } from "../lib/api-route.js";
import { requireScope } from "../lib/auth-key.js";
import type { AppDeps } from "../types.js";

const contract = apiRoutes.reports;

export function reportsRoutes(deps: AppDeps): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  const readRun = requireScope(deps, "runs:read", { runIdParam: "id" });

  async function row(c: Parameters<typeof scopedDb>[0], runId: string) {
    return scopedDb(c, deps.db).transaction(async (tx) => {
      const [found] = await tx
        .select({ json: reports.json, md: reports.md })
        .from(reports)
        .where(eq(reports.runId, runId))
        .limit(1);
      return found;
    });
  }

  r.get("/:id/report", readRun, async (c) => {
    const route = contract.get;
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    const found = await row(c.get("actor"), parsed.request.params.id);
    if (!found) return fail(c, "not_found", "no report for this run yet");
    const report = ReportSchema.safeParse(found.json);
    if (!report.success) return fail(c, "not_found", "the stored report is not readable");
    return send(c, route, { report: report.data });
  });

  r.get("/:id/report/markdown", readRun, async (c) => {
    const parsed = await parseOrFail(c, contract.markdown);
    if (!parsed.ok) return parsed.response;
    const found = await row(c.get("actor"), parsed.request.params.id);
    if (!found) return fail(c, "not_found", "no report for this run yet");
    return c.text(found.md, 200, { "content-type": "text/markdown; charset=utf-8" });
  });

  return r;
}
