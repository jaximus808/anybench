// TDM-60 [6.6] (the minimal guard of plan 17.2 rule 6; the full [16.9] preregistration ticket
// adds the edit log and attestation): freeze the kit before the first contender trial.
//
//   At Go (awaiting_go → running) the orchestrator records stage_outputs.prereg: the kit row, its
//   spec hash, the sha256 of its whole file tree (generated kits: what env build and proof used,
//   including the captured reference), the weights, the primary requirement and the repeats.
//   Before it creates the trials, it recomputes them; any difference holds the run
//   (needs_human) instead of running a kit nobody preregistered.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { KitSpec } from "@anybench/core";
import { hashKitPaths } from "@anybench/kit";
import { z } from "zod";

export const PreregSchema = z.object({
  kit_id: z.string().min(1),
  kit_version: z.int().positive(),
  /** kits.hash (the spec hash). */
  kit_hash: z.string().min(1),
  /** sha256 of the kit's file tree (file:// kits only), else null. */
  files_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  weights: z.record(z.string(), z.int()),
  primary: z.string().nullable(),
  repeats: z.int().positive(),
  frozen_at: z.string(),
});
export type Prereg = z.infer<typeof PreregSchema>;

export interface PreregKitRow {
  id: string;
  version: number;
  hash: string;
  filesUrl: string | null;
}

/** sha256 over every file of a file:// kit dir (null for other kits or a missing dir). */
export async function kitFilesSha256(filesUrl: string | null): Promise<string | null> {
  if (!filesUrl?.startsWith("file://")) return null;
  const dir = fileURLToPath(filesUrl);
  let top: string[];
  try {
    top = (await readdir(dir)).filter((n) => n !== ".DS_Store").sort();
  } catch {
    return null;
  }
  const { hash, problems } = await hashKitPaths(dir, top);
  if (problems.length > 0) return null;
  return hash.sha256;
}

/** The preregistration of a kit row as it stands now. */
export async function preregistrationOf(row: PreregKitRow, spec: KitSpec): Promise<Prereg> {
  return {
    kit_id: row.id,
    kit_version: row.version,
    kit_hash: row.hash,
    files_sha256: await kitFilesSha256(row.filesUrl),
    weights: { ...spec.scoring.weights },
    primary: spec.scoring.primary ?? null,
    repeats: spec.repeats,
    frozen_at: new Date().toISOString(),
  };
}

/** What changed since the preregistration (null when nothing did). */
export function preregMismatch(frozen: Prereg, now: Prereg): string | null {
  const diffs: string[] = [];
  if (frozen.kit_id !== now.kit_id) diffs.push(`kit v${frozen.kit_version} → v${now.kit_version}`);
  if (frozen.kit_hash !== now.kit_hash) diffs.push("spec hash");
  if (frozen.files_sha256 !== now.files_sha256) diffs.push("kit files");
  if (JSON.stringify(frozen.weights) !== JSON.stringify(now.weights)) diffs.push("weights");
  if (frozen.primary !== now.primary) diffs.push("primary metric");
  if (frozen.repeats !== now.repeats) diffs.push("repeats");
  return diffs.length > 0 ? diffs.join(", ") : null;
}
