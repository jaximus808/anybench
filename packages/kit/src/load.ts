// loadKit: the throwing front door to a kit directory (TDM-33 [4.1]).
import { KitLoadError } from "./issues.js";
import { type LoadedKit, validateKitDir } from "./validate.js";

/**
 * Load and fully validate the kit in `dir` (anybench.yaml plus every file it references).
 * Throws KitLoadError, carrying every positioned issue, when anything is wrong.
 */
export async function loadKit(dir: string = "."): Promise<LoadedKit> {
  const r = await validateKitDir(dir);
  if (!r.ok || r.kit === undefined) throw new KitLoadError(r.dir, r.errors, r.warnings);
  return r.kit;
}
