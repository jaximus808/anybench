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

/** Serializes rows. Every row ends with "\n". */
export function toCsv(rows: Rows): string {
  return rows.map((row) => row.join(",") + "\n").join("");
}

/** Parses CSV text into rows. A trailing newline does not add an empty row. */
export function parseCsv(text: string): Rows {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.split(","));
}
