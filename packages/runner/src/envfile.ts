// ~/.anybench/env: secrets written by the worker with fs.write (0600) right before the trial.
// Parsed here rather than `source`d by a shell, so the runner knows every value and can redact it
// from everything it emits. The values go into the driver's environment only, never the runner's.
//
// Format (dotenv subset): `KEY=value`, optional `export ` prefix, `#` comment lines, blank lines,
// single quotes (literal) or double quotes (\n \t \" \\ escapes). Unquoted values are trimmed.

import { readFile } from "node:fs/promises";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvFileError";
  }
}

function unquoteDouble(body: string): string {
  return body.replace(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return c;
    }
  });
}

/** Parse env file text. Line numbers in errors, never values. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) throw new EnvFileError(`env line ${i + 1}: expected KEY=VALUE`);
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) throw new EnvFileError(`env line ${i + 1}: invalid key`);
    let value = line.slice(eq + 1).trim();
    if (value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith("'"))
        throw new EnvFileError(`env line ${i + 1}: unterminated single quote`);
      value = value.slice(1, -1);
    } else if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"'))
        throw new EnvFileError(`env line ${i + 1}: unterminated double quote`);
      value = unquoteDouble(value.slice(1, -1));
    }
    out[key] = value;
  }
  return out;
}

/** Read the env file; a missing file means no secrets. */
export async function loadEnvFile(path: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new EnvFileError(`cannot read env file: ${(err as Error).message}`);
  }
  return parseEnvFile(text);
}
