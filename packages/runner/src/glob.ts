// Minimal glob matching for `collect:` (no dependency, same behaviour under Node and bun).
// Supports `**` (any number of path segments), `*` and `?` (within one segment), `[abc]` classes
// and `{a,b}` alternatives. Paths are `/`-separated and relative to the base directory. Symlinks
// are not followed, and dotfiles match like any other file.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

function escapeRe(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more whole segments; a trailing `**` matches everything below.
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*(?:/|$))*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
      } else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (c === "{") {
      braceDepth++;
      re += "(?:";
    } else if (c === "}" && braceDepth > 0) {
      braceDepth--;
      re += ")";
    } else if (c === "," && braceDepth > 0) {
      re += "|";
    } else {
      re += escapeRe(c);
    }
    i++;
  }
  return new RegExp(`^${re}$`);
}

/** Every regular file under `base`, as `/`-separated relative paths, sorted. */
export async function listFiles(base: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(join(base, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      // Symlinks are skipped: one in the workspace could point anywhere on the machine.
      else if (e.isFile()) out.push(r);
    }
  };
  await walk("");
  return out.sort();
}

/** Files under `base` matching any of `globs`. */
export async function matchFiles(base: string, globs: readonly string[]): Promise<string[]> {
  if (globs.length === 0) return [];
  const res = globs.map((g) => globToRegExp(g.replace(/^\.\//, "")));
  const files = await listFiles(base);
  return files.filter((f) => res.some((re) => re.test(f)));
}
