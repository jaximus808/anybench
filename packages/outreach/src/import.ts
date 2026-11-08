// Hackathon opt-in import (15.2a): `anybench outreach import <csv> --source hackathon_optin`.
// CSV only, columns name,email,repo (header row required, any order, case-insensitive; repo may be
// blank). These people replied to the chat post asking to be benchmarked, so this is the one
// source where an email comes straight from the person. No network calls.

import { z } from "zod";
import { parseRepoInput } from "./context-dev.js";
import type { LeadStore, NewLead } from "./store.js";

export const OPTIN_SOURCE = "hackathon_optin" as const;
export const OPTIN_COLUMNS = ["name", "email", "repo"] as const;

/** RFC 4180-ish: quoted fields, "" escapes, CRLF or LF, a trailing newline is fine. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("CSV: unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const OptinRowSchema = z.object({
  name: z.string().trim().min(1, "name is empty").max(200),
  email: z.string().trim().toLowerCase().pipe(z.email("not a valid email")),
  repo: z
    .string()
    .trim()
    .transform((s, ctx) => {
      if (!s) return null;
      const ref = parseRepoInput(s);
      if (!ref) {
        ctx.addIssue({ code: "custom", message: `not a GitHub repo (owner/repo or URL): ${s}` });
        return z.NEVER;
      }
      return ref;
    }),
});

export interface ImportOptions {
  csv: string;
  /** Shown in provenance (file name). */
  file: string;
  store: LeadStore;
  dryRun?: boolean;
  now?: () => number;
}

export type ImportSkipReason = "invalid" | "suppressed" | "duplicate_email" | "duplicate_repo";

export interface ImportReport {
  source: typeof OPTIN_SOURCE;
  file: string;
  dryRun: boolean;
  rows: number;
  imported: { id: string | null; row: number; email: string; githubUrl: string | null }[];
  skipped: { row: number; reason: ImportSkipReason; detail?: string }[];
}

export async function importOptinCsv(o: ImportOptions): Promise<ImportReport> {
  const table = parseCsv(o.csv);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(OPTIN_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<
    (typeof OPTIN_COLUMNS)[number],
    number
  >;
  const missing = OPTIN_COLUMNS.filter((c) => idx[c] < 0);
  if (missing.length) {
    throw new Error(
      `CSV header must have columns ${OPTIN_COLUMNS.join(",")}; missing: ${missing.join(",")}`,
    );
  }
  const now = o.now ?? Date.now;
  const report: ImportReport = {
    source: OPTIN_SOURCE,
    file: o.file,
    dryRun: o.dryRun ?? false,
    rows: table.length - 1,
    imported: [],
    skipped: [],
  };

  // Validate every row first, then one round of dedupe/suppression lookups.
  const valid: { row: number; data: z.output<typeof OptinRowSchema> }[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    const p = OptinRowSchema.safeParse({
      name: cells[idx.name] ?? "",
      email: cells[idx.email] ?? "",
      repo: cells[idx.repo] ?? "",
    });
    const row = i + 1; // 1-based file line (header is line 1)
    if (!p.success) {
      report.skipped.push({
        row,
        reason: "invalid",
        detail: p.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "),
      });
      continue;
    }
    valid.push({ row, data: p.data });
  }

  const emails = valid.map((v) => v.data.email);
  const repos = valid.flatMap((v) => (v.data.repo ? [v.data.repo.key] : []));
  const [suppressed, existing] = await Promise.all([
    o.store.suppressed(emails),
    o.store.existing({ githubUrls: repos, domains: [], emails }),
  ]);
  const seenEmails = new Set<string>();
  const seenRepos = new Set<string>();
  const importedAt = new Date(now()).toISOString();

  for (const { row, data } of valid) {
    if (suppressed.has(data.email)) {
      report.skipped.push({ row, reason: "suppressed" });
      continue;
    }
    if (seenEmails.has(data.email) || existing.emails.has(data.email)) {
      report.skipped.push({ row, reason: "duplicate_email" });
      continue;
    }
    const repoKey = data.repo?.key;
    if (repoKey && (seenRepos.has(repoKey) || existing.githubUrls.has(repoKey))) {
      report.skipped.push({ row, reason: "duplicate_repo", detail: data.repo!.url });
      continue;
    }
    const lead: NewLead = {
      source: OPTIN_SOURCE,
      query: null,
      company: null,
      contact: data.name,
      email: data.email,
      githubUrl: data.repo?.url ?? null,
      status: "new",
      signals: {
        provenance: {
          source: OPTIN_SOURCE,
          file: o.file,
          row,
          importedAt,
          consent: "replied to the hackathon chat post asking to be benchmarked",
        },
      },
    };
    const id = o.dryRun ? null : (await o.store.insert(lead)).id;
    seenEmails.add(data.email);
    if (repoKey) seenRepos.add(repoKey);
    report.imported.push({ id, row, email: data.email, githubUrl: lead.githubUrl });
  }
  return report;
}
