// Small helpers for the rendered cli scripts (TDM-36 [4.4]).

/** Quote a string as one bash word: `'it'\''s'`. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Indent every non-empty line of a block. */
export function indent(block: string, by = "  "): string {
  return block
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : by + l))
    .join("\n");
}

/** The cli scripts must run under bash 3.2 (macOS) as well as 5.x (the eval computers). */
export const CLI_SCRIPT_SHEBANG = "#!/usr/bin/env bash";
