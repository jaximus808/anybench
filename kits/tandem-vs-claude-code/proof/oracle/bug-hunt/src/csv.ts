/** A CSV table: rows of string fields. */
export type Rows = string[][];

/** Raised when CSV input cannot be parsed. */
export class CsvError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "CsvError";
    this.line = line;
  }
}

const NEEDS_QUOTES = /[",\r\n]/;

/** RFC 4180: quote a field holding a comma, quote or line break; double the quotes inside. */
function encodeField(field: string): string {
  return NEEDS_QUOTES.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/** Serializes rows. Every row ends with "\n". */
export function toCsv(rows: Rows): string {
  return rows.map((row) => row.map(encodeField).join(",") + "\n").join("");
}

/**
 * Parses CSV text into rows (RFC 4180). Rows end with "\n" or "\r\n"; quoted fields may hold
 * commas, doubled quotes and line breaks. A trailing newline does not add an empty row.
 */
export function parseCsv(text: string): Rows {
  const rows: Rows = [];
  let row: string[] = [];
  let field = "";
  let line = 1;
  let i = 0;
  // True once the current row has any content, so a final newline doesn't add an empty row.
  let rowStarted = false;

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' && field === "") {
      const openedAt = line;
      i += 1;
      for (;;) {
        if (i >= text.length) throw new CsvError("unterminated quoted field", openedAt);
        const c = text[i]!;
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (c === "\n") line += 1;
        field += c;
        i += 1;
      }
      rowStarted = true;
      const next = text[i];
      if (next !== undefined && next !== "," && next !== "\n" && !(next === "\r" && text[i + 1] === "\n")) {
        throw new CsvError("unexpected character after a closing quote", line);
      }
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      rowStarted = true;
      i += 1;
      continue;
    }
    if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      rowStarted = false;
      line += 1;
      i += ch === "\r" ? 2 : 1;
      continue;
    }
    field += ch;
    rowStarted = true;
    i += 1;
  }
  if (rowStarted) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
