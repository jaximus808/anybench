import { errors } from "./http.ts";

export type Body = Record<string, unknown>;

export function isObject(v: unknown): v is Body {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function has(o: Body, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** The updatable field names present in a PATCH body, sorted; throws if there are none. */
export function patchFields(body: Body, updatable: readonly string[]): string[] {
  const fields = updatable.filter((f) => has(body, f)).sort();
  if (fields.length === 0) throw errors.invalidBody(`body must contain one of: ${updatable.join(", ")}`);
  return fields;
}

export function trimmed(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw errors.invalidBody(`${field} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) {
    throw errors.invalidBody(`${field} must be ${min} to ${max} characters after trimming`);
  }
  return t;
}

export function plain(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw errors.invalidBody(`${field} must be a string`);
  if (v.length < min || v.length > max) throw errors.invalidBody(`${field} must be ${min} to ${max} characters`);
  return v;
}

/** Validates an email (section 1). Returns it trimmed and lowercased. */
export function email(v: unknown, field = "email"): string {
  if (typeof v !== "string") throw errors.invalidBody(`${field} must be a string`);
  const t = v.trim();
  const at = t.indexOf("@");
  if (t.length > 254 || at <= 0 || at !== t.lastIndexOf("@") || at === t.length - 1) {
    throw errors.invalidBody(`${field} is not a valid email`);
  }
  return t.toLowerCase();
}

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export function handle(v: unknown): string {
  if (typeof v !== "string" || !HANDLE_RE.test(v)) {
    throw errors.invalidBody("handle must match ^[a-z0-9_]{3,20}$");
  }
  return v;
}

export function password(v: unknown, field: string): string {
  return plain(v, field, 8, 200);
}

export function integer(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw errors.invalidBody(`${field} must be an integer from ${min} to ${max}`);
  }
  return v;
}

export function boolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw errors.invalidBody(`${field} must be a boolean`);
  return v;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a `YYYY-MM-DD` string naming a real calendar date. */
export function isDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function nullableDate(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !isDate(v)) throw errors.invalidBody(`${field} must be null or a YYYY-MM-DD date`);
  return v;
}

export function nullableString(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw errors.invalidBody(`${field} must be null or a string`);
  return v;
}

/** Card labels (section 5): trimmed, lowercased, 1..30 chars, de-duplicated, sorted, at most 10. */
export function labels(v: unknown): string[] {
  if (!Array.isArray(v)) throw errors.invalidBody("labels must be an array of strings");
  const out = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string") throw errors.invalidBody("labels must be an array of strings");
    const t = item.trim().toLowerCase();
    if (t.length < 1 || t.length > 30) throw errors.invalidBody("each label must be 1 to 30 characters");
    out.add(t);
  }
  if (out.size > 10) throw errors.invalidBody("at most 10 distinct labels");
  return [...out].sort();
}

export function wipLimit(v: unknown): number | null {
  if (v === null) return null;
  return integer(v, "wipLimit", 1, 1000);
}
