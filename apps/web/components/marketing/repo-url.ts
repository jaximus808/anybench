/**
 * Normalizes what a visitor types into the hero's repo field. Nothing is sent
 * anywhere: the landing page only copies the result to the clipboard so the
 * visitor can paste it into an email (TDM-99, early access).
 */
export interface NormalizedRepo {
  /** Short form shown back to the visitor, e.g. `github.com/you/project`. */
  display: string;
  /** Full URL copied to the clipboard, e.g. `https://github.com/you/project`. */
  url: string;
}

const OWNER_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const HOST_PATH = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-/]+$/;

export function normalizeRepoUrl(input: string): NormalizedRepo | null {
  let s = input.trim();
  if (s.length === 0 || s.length > 300 || /\s/.test(s)) return null;
  s = s.replace(/^git@([^:]+):/i, "$1/");
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^www\./i, "");
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (OWNER_REPO.test(s)) s = `github.com/${s}`;
  if (!HOST_PATH.test(s)) return null;
  const [host = "", ...rest] = s.split("/");
  const display = [host.toLowerCase(), ...rest].join("/");
  return { display, url: `https://${display}` };
}
