// A tiny flag parser for the kit and run commands (TDM-219): `--flag`, `--opt value`,
// `--opt=value`, at most `maxPositionals` positionals. No dependencies, so the CLI stays small.

export interface FlagSpec {
  /** Boolean flags, e.g. `json`, `force`. Aliases map a short form (`-q`) to the long name. */
  booleans?: readonly string[];
  /** Flags that take one value. */
  strings?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  maxPositionals?: number;
}

export interface ParsedFlags {
  positionals: string[];
  booleans: Set<string>;
  strings: Map<string, string>;
}

export function parseFlags(
  argv: readonly string[],
  spec: FlagSpec,
): ParsedFlags | { error: string } {
  const booleans = new Set<string>();
  const strings = new Map<string, string>();
  const positionals: string[] = [];
  const isBool = (n: string) => n === "help" || (spec.booleans ?? []).includes(n);
  const isStr = (n: string) => (spec.strings ?? []).includes(n);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      const eq = a.indexOf("=");
      const rawName = eq >= 0 ? a.slice(0, eq) : a;
      const alias = spec.aliases?.[rawName] ?? (rawName === "-h" ? "help" : undefined);
      const name = alias ?? rawName.replace(/^--/, "");
      if (!rawName.startsWith("--") && alias === undefined)
        return { error: `unknown option: ${a}` };
      if (isBool(name)) {
        if (eq >= 0) return { error: `--${name} takes no value` };
        booleans.add(name);
      } else if (isStr(name)) {
        const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined || (eq < 0 && value.startsWith("--"))) {
          return { error: `--${name} needs a value` };
        }
        strings.set(name, value);
      } else {
        return { error: `unknown option: ${rawName}` };
      }
      continue;
    }
    positionals.push(a);
  }
  const max = spec.maxPositionals ?? 1;
  if (positionals.length > max) return { error: `unexpected argument: ${positionals[max]}` };
  return { positionals, booleans, strings };
}

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const defaultIo: CliIo = {
  stdout: (l) => process.stdout.write(`${l}\n`),
  stderr: (l) => process.stderr.write(`${l}\n`),
};
