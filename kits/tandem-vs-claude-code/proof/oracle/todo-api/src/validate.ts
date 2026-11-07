import { HttpError } from "./http.ts";

export function invalidBody(message: string): HttpError {
  return new HttpError(400, "invalid_body", message);
}

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidBody("body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") throw invalidBody(`${key} is required and must be a string`);
  return v;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in `YYYY-MM-DD` form. */
export function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

export function validTitle(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw invalidBody("title must be a string of 1 to 200 characters");
  }
  return value;
}
