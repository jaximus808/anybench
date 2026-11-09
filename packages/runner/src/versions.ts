// TDM-247: put the runner's commit in the driver's versions.json at freeze, so every trial bundle
// says which runner (and so which token meter) ran it. Every driver writes its own versions.json
// (coding-agent, harness and kit adapters), so the runner adds the one field instead of each
// driver learning it. No versions.json, or one that is not a JSON object: left alone.
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "./status.js";

export async function stampVersionsJson(file: string, runnerCommit: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return false;
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  try {
    await writeJsonAtomic(file, { ...(v as Record<string, unknown>), runner_commit: runnerCommit });
    return true;
  } catch {
    return false; // never fails the trial: status.json and machine.json carry the commit too
  }
}
