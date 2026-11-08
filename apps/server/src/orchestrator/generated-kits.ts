// Generated kit directories on the worker's disk (TDM-44 contract C1).
//
// The kit designer writes each generated kit version to `<root>/<run_id>/v<n>/`, where root is
// ANYBENCH_GENERATED_KITS_DIR (default ~/.anybench/generated-kits). kitDraft stores the directory as
// a file:// kits.files_url; after kit_draft only the proof stage writes into it (reference capture,
// scoring-only files under reference/).
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_GENERATED_KITS_SUBDIR = path.join(".anybench", "generated-kits");

/** The generated kits root: the override (ANYBENCH_GENERATED_KITS_DIR), else ~/.anybench/generated-kits. */
export function generatedKitsRoot(override?: string): string {
  return override ? path.resolve(override) : path.join(homedir(), DEFAULT_GENERATED_KITS_SUBDIR);
}

const GeneratedKitDirInput = z.object({
  /** The run id (a UUID; anything else could escape the root). */
  runId: z.uuid(),
  /** The kit version, 1-based (kits.version). */
  version: z.number().int().positive(),
  root: z.string().min(1).optional(),
});

/** `<root>/<run_id>/v<n>/` (absolute, trailing slash-free) for one generated kit version. */
export function generatedKitDir(input: z.input<typeof GeneratedKitDirInput>): string {
  const { runId, version, root } = GeneratedKitDirInput.parse(input);
  return path.join(generatedKitsRoot(root), runId.toLowerCase(), `v${version}`);
}
