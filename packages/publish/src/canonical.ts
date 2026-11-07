// TDM-109 [12.1]: canonical JSON for signed attestations (RFC 8785 / JCS style).
//
// - Object keys sorted by UTF-16 code units (JS default string order, as JCS specifies).
// - No whitespace.
// - Strings and numbers serialized as ECMAScript JSON.stringify does: JCS defines its number
//   format as the ES shortest round-trip form, so a float like a score total is deterministic.
// - bigint is written as a quoted decimal string (micro-USD convention), never a JSON number.
// - Properties whose value is `undefined` are omitted, like JSON.stringify.
// - Anything that has no single JSON meaning throws CanonicalJsonError: NaN/±Infinity,
//   functions, symbols, `undefined` in an array or at the top, and non-plain objects
//   (Date, Map, class instances), so a caller can never sign something ambiguous.

export class CanonicalJsonError extends Error {
  override readonly name = "CanonicalJsonError";
  constructor(
    message: string,
    /** JSON-pointer-ish path to the offending value, e.g. `/scores/0/total`. */
    readonly path: string,
  ) {
    super(`${message} at ${path === "" ? "/" : path}`);
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function write(v: unknown, path: string, out: string[]): void {
  switch (typeof v) {
    case "string":
      out.push(JSON.stringify(v));
      return;
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(v)) throw new CanonicalJsonError(`non-finite number ${v}`, path);
      out.push(JSON.stringify(v)); // -0 → "0", as JCS requires
      return;
    case "bigint":
      out.push(`"${v.toString(10)}"`);
      return;
    case "object": {
      if (v === null) {
        out.push("null");
        return;
      }
      if (Array.isArray(v)) {
        out.push("[");
        for (let i = 0; i < v.length; i++) {
          if (i > 0) out.push(",");
          const item: unknown = v[i];
          if (item === undefined)
            throw new CanonicalJsonError("undefined in array", `${path}/${i}`);
          write(item, `${path}/${i}`, out);
        }
        out.push("]");
        return;
      }
      if (!isPlainObject(v)) {
        throw new CanonicalJsonError(`non-plain object (${v.constructor?.name ?? "?"})`, path);
      }
      const rec = v as Record<string, unknown>;
      const keys = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort();
      out.push("{");
      keys.forEach((k, i) => {
        if (i > 0) out.push(",");
        out.push(JSON.stringify(k), ":");
        write(rec[k], `${path}/${k}`, out);
      });
      out.push("}");
      return;
    }
    default:
      throw new CanonicalJsonError(`unsupported ${typeof v}`, path);
  }
}

/** Canonical JSON text of `value`. Same value, same string, on every machine. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, "", out);
  return out.join("");
}

/** UTF-8 bytes of `canonicalize(value)`: what gets signed. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
