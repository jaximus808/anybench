// Shared building blocks for the kit, env and digest schemas (TDM-7, plan.md P1/P2).
import { z } from "zod";

/** Ids inside a kit: contenders, workloads, gates, requirements, proof overlays. */
export const KitSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
  error: "must be a lowercase id: letters, digits, '.', '_' or '-', at most 64 chars",
});

/** Environment variable names (secrets, vary keys). Names only, never values. */
export const KitEnvVarNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/, {
  error: "must be an UPPER_SNAKE_CASE environment variable name (names only, never a value)",
});

function isSafeRelative(p: string): boolean {
  if (p.length === 0 || p.startsWith("/") || p.startsWith("~") || p.includes("\\")) return false;
  return !p.split("/").some((seg) => seg === "..");
}

/** A path relative to the kit root. No absolute paths, no `..` escapes. */
export const KitPathSchema = z.string().refine(isSafeRelative, {
  error: "must be a path relative to the kit root, with no leading '/', '~' or '..' segments",
});

/** A glob relative to EVAL_OUT or the kit root (`collect:` entries). Same rules as KitPathSchema. */
export const KitGlobSchema = z.string().refine(isSafeRelative, {
  error: "must be a relative glob, with no leading '/', '~' or '..' segments",
});

/** Lowercase hex sha256. */
export const KitSha256Schema = z.string().regex(/^[a-f0-9]{64}$/, {
  error: "must be a lowercase hex sha256 (64 chars)",
});

/** Plain env values passed to an overlay or driver (not secrets). */
export const KitEnvMapSchema = z.record(KitEnvVarNameSchema, z.string());

/** What kind of project is under test. */
export const SubjectKindSchema = z.enum(["agent", "harness", "software"]);
export type SubjectKind = z.infer<typeof SubjectKindSchema>;
