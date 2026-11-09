// Shared helpers: errors, validation, dates, tokens, CSV.
import { createHash, randomBytes } from "node:crypto";

export class HttpError extends Error {
  status: number;
  code: string;
  details: any;
  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const E = {
  notFound: (m = "not found") => new HttpError(404, "not_found", m),
  unauthorized: () => new HttpError(401, "unauthorized", "authentication required"),
  forbidden: (m = "your role does not allow this") => new HttpError(403, "forbidden", m),
  body: (m: string) => new HttpError(400, "invalid_body", m),
  query: (m: string) => new HttpError(400, "invalid_query", m),
  conflict: (code: string, m = code.replace(/_/g, " "), details?: any) => new HttpError(409, code, m, details),
  bad: (code: string, m = code.replace(/_/g, " "), details?: any) => new HttpError(400, code, m, details),
  quota: (resource: string, limit: number, used: number) =>
    new HttpError(409, "quota_exceeded", `the ${resource} quota is exhausted`, { resource, limit, used }),
};

export type Body = Record<string, any>;

export function isObj(v: unknown): v is Body {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function has(o: any, k: string): boolean {
  return isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
}

export function patchFields(body: Body, updatable: readonly string[]): string[] {
  const f = updatable.filter((x) => has(body, x)).sort();
  if (f.length === 0) throw E.body(`body must contain one of: ${updatable.join(", ")}`);
  return f;
}

export function trimmed(v: unknown, field: string, min: number, max: number, err = E.body): string {
  if (typeof v !== "string") throw err(`${field} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw err(`${field} must be ${min} to ${max} characters`);
  return t;
}
export function plain(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw E.body(`${field} must be a string`);
  if (v.length < min || v.length > max) throw E.body(`${field} must be ${min} to ${max} characters`);
  return v;
}
export function isEmail(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = v.trim();
  const at = t.indexOf("@");
  return !(t.length > 254 || at <= 0 || at !== t.lastIndexOf("@") || at === t.length - 1);
}
export function email(v: unknown): string {
  if (!isEmail(v)) throw E.body("email is not valid");
  return (v as string).trim().toLowerCase();
}
export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
export function integer(v: unknown, field: string, min: number, max: number, err = E.body): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw err(`${field} must be an integer from ${min} to ${max}`);
  return v;
}
export function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw E.body(`${field} must be a boolean`);
  return v;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
export function nullableDate(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (!isDate(v)) throw E.body(`${field} must be null or a YYYY-MM-DD date`);
  return v;
}
export const DAY = 86_400_000;
export function startOf(d: string): number {
  return Date.parse(d + "T00:00:00.000Z");
}
export function endOf(d: string): number {
  return startOf(d) + DAY;
}
export function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(d: string, n: number): string {
  return dateOf(startOf(d) + n * DAY);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((startOf(b) - startOf(a)) / DAY);
}
export function weekday(d: string): number {
  return new Date(startOf(d)).getUTCDay();
}
export function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"];
export const POINTS = [0, 1, 2, 3, 5, 8, 13, 21];
export const CATEGORIES = ["todo", "in_progress", "done"];

export function normLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (t.length < 1 || t.length > 30) return null;
  return t;
}
export function labels(v: unknown): string[] {
  if (!Array.isArray(v)) throw E.body("labels must be an array of strings");
  const out = new Set<string>();
  for (const x of v) {
    const t = normLabel(x);
    if (t === null) throw E.body("each label must be a string of 1 to 30 characters");
    out.add(t);
  }
  if (out.size > 10) throw E.body("at most 10 distinct labels");
  return [...out].sort();
}
export function sortLabels(a: string[]): string[] {
  return [...new Set(a)].sort();
}
export function priority(v: unknown): string {
  if (typeof v !== "string" || !PRIORITIES.includes(v)) throw E.body("priority is not valid");
  return v;
}
export function points(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !POINTS.includes(v)) throw E.body("points is not valid");
  return v;
}
export function wipLimit(v: unknown): number | null {
  if (v === null) return null;
  return integer(v, "wipLimit", 1, 1000);
}
export function isHttpUrl(v: unknown, max = Infinity): boolean {
  if (typeof v !== "string" || v.length > max) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;
}
export function alnum(n: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += chars[b[i]! % chars.length];
  return s;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

export const MENTION_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])/g;

// ---- CSV -------------------------------------------------------------------------------------

export function csvCell(s: string): string {
  if (/[,"\r\n]/.test(s) || s.startsWith(" ") || s.endsWith(" ")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
export function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}

/** Parses CSV. Returns rows, or { malformed: rowIndex } (0-based row index of the broken row). */
export function parseCsv(text: string): { rows: string[][]; malformedAt: number | null } {
  const rows: string[][] = [];
  if (text === "") return { rows, malformedAt: null };
  let i = 0;
  const n = text.length;
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let atCellStart = true;
  for (;;) {
    if (i >= n) {
      if (inQuotes) return { rows, malformedAt: rows.length };
      row.push(cell);
      rows.push(row);
      break;
    }
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && atCellStart) {
      inQuotes = true;
      atCellStart = false;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      atCellStart = true;
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      atCellStart = true;
      i += 2;
      if (i >= n) break;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      atCellStart = true;
      i++;
      if (i >= n) break;
      continue;
    }
    cell += ch;
    atCellStart = false;
    i++;
  }
  return { rows, malformedAt: null };
}

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
