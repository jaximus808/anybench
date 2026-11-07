// Parse anybench.yaml keeping node positions, and map a KitSpec path back to LINE:COL (TDM-33 [4.1]).
import {
  type Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseDocument,
} from "yaml";
import type { KitIssue } from "./issues.js";

export interface KitYamlSource {
  file: string;
  doc: Document;
  lineCounter: LineCounter;
  /** The plain JS value, ready for safeParseKitSpec. Undefined when the YAML has errors. */
  data: unknown;
  errors: KitIssue[];
  warnings: KitIssue[];
}

export interface SourcePosition {
  line: number;
  col: number;
}

/** Parse YAML text. Syntax errors (including duplicate keys) come back as issues, never thrown. */
export function parseKitYaml(text: string, file: string): KitYamlSource {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true });
  const toIssue = (severity: "error" | "warning", e: (typeof doc.errors)[number]): KitIssue => {
    const pos = lineCounter.linePos(e.pos[0]);
    // yaml messages can span lines (context excerpts); keep the first one.
    const message = (e.message.split("\n")[0] ?? e.message).trim();
    return {
      severity,
      code: severity === "error" ? "yaml_syntax" : "yaml_warning",
      file,
      line: pos.line,
      col: pos.col,
      message,
    };
  };
  const errors = doc.errors.map((e) => toIssue("error", e));
  const warnings = doc.warnings.map((e) => toIssue("warning", e));
  let data: unknown;
  if (errors.length === 0) {
    try {
      data = doc.toJS({ maxAliasCount: 100 });
    } catch (err) {
      errors.push({
        severity: "error",
        code: "yaml_syntax",
        file,
        line: 1,
        col: 1,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { file, doc, lineCounter, data, errors, warnings };
}

/**
 * The position of the deepest node on `path` that exists in the document.
 * A missing key points at the map that should hold it; `preferKey` points at the key itself
 * (for "unrecognized key" errors).
 */
export function positionOf(
  src: Pick<KitYamlSource, "doc" | "lineCounter">,
  path: readonly PropertyKey[],
  opts: { preferKey?: boolean } = {},
): SourcePosition | undefined {
  const { doc, lineCounter } = src;
  const resolve = (n: unknown): unknown => (isAlias(n) ? n.resolve(doc) : n);
  let node: unknown = resolve(doc.contents);
  let best: Node | undefined = isNode(node) ? node : undefined;

  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    const last = i === path.length - 1;
    if (isMap(node)) {
      const pair = node.items.find(
        (p) => (isScalar(p.key) ? String(p.key.value) : String(p.key)) === String(seg),
      );
      if (pair === undefined) break;
      const value = resolve(pair.value);
      if ((last && opts.preferKey) || !isNode(value)) {
        if (isNode(pair.key)) best = pair.key;
        break;
      }
      node = value;
      best = value;
    } else if (isSeq(node) && typeof seg === "number") {
      const item = resolve(node.items[seg]);
      if (!isNode(item)) break;
      node = item;
      best = item;
    } else {
      break;
    }
  }
  const offset = best?.range?.[0];
  return offset === undefined ? undefined : lineCounter.linePos(offset);
}
