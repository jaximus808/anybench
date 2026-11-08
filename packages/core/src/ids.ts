// Branded ids. Every entity id is a lowercase UUID (Postgres `uuid`); new ids are UUIDv7 so they
// sort by creation time. The zod brand makes a RunId unassignable to a TrialId at compile time.
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function idSchema<const B extends string>() {
  return z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.string().regex(UUID, "expected a UUID"))
    .brand<B>();
}

export const UserIdSchema = idSchema<"UserId">();
export const SessionIdSchema = idSchema<"SessionId">();
export const ApiKeyIdSchema = idSchema<"ApiKeyId">();
export const ProjectIdSchema = idSchema<"ProjectId">();
export const RunIdSchema = idSchema<"RunId">();
export const KitIdSchema = idSchema<"KitId">();
export const ContenderIdSchema = idSchema<"ContenderId">();
export const TrialIdSchema = idSchema<"TrialId">();
export const AgentSessionIdSchema = idSchema<"AgentSessionId">();
export const ComputerIdSchema = idSchema<"ComputerId">();
export const AlertIdSchema = idSchema<"AlertId">();
export const UsageEntryIdSchema = idSchema<"UsageEntryId">();
export const CreditGrantIdSchema = idSchema<"CreditGrantId">();
export const InterventionIdSchema = idSchema<"InterventionId">();
export const PublishedBenchmarkIdSchema = idSchema<"PublishedBenchmarkId">();
export const LeadIdSchema = idSchema<"LeadId">();

export type UserId = z.output<typeof UserIdSchema>;
export type SessionId = z.output<typeof SessionIdSchema>;
export type ApiKeyId = z.output<typeof ApiKeyIdSchema>;
export type ProjectId = z.output<typeof ProjectIdSchema>;
export type RunId = z.output<typeof RunIdSchema>;
export type KitId = z.output<typeof KitIdSchema>;
export type ContenderId = z.output<typeof ContenderIdSchema>;
export type TrialId = z.output<typeof TrialIdSchema>;
export type AgentSessionId = z.output<typeof AgentSessionIdSchema>;
export type ComputerId = z.output<typeof ComputerIdSchema>;
export type AlertId = z.output<typeof AlertIdSchema>;
export type UsageEntryId = z.output<typeof UsageEntryIdSchema>;
export type CreditGrantId = z.output<typeof CreditGrantIdSchema>;
export type InterventionId = z.output<typeof InterventionIdSchema>;
export type PublishedBenchmarkId = z.output<typeof PublishedBenchmarkIdSchema>;
export type LeadId = z.output<typeof LeadIdSchema>;

/** Any of the id schemas above (or one built the same way elsewhere). */
export type IdSchema = ReturnType<typeof idSchema<string>>;

/** A fresh UUIDv7 string (RFC 9562): 48-bit unix-ms timestamp, then 74 random bits. */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = new Uint8Array(16);
  // Web Crypto: global in Node >= 19 and every browser, so core stays free of node: imports
  // and the web app's client bundle does not pull in a crypto polyfill.
  globalThis.crypto.getRandomValues(b);
  let ts = BigInt(Math.trunc(nowMs));
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A new branded id: `newId(RunIdSchema)` returns a RunId. */
export function newId<S extends IdSchema>(schema: S): z.output<S> {
  return schema.parse(uuidv7());
}

/** The creation time (unix ms) encoded in a UUIDv7 id, or undefined for other UUID versions. */
export function uuidv7Timestamp(id: string): number | undefined {
  const hex = id.replace(/-/g, "");
  if (hex.length !== 32 || hex[12] !== "7") return undefined;
  return Number.parseInt(hex.slice(0, 12), 16);
}
