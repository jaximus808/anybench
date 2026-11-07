import { CsvError, parseCsv, toCsv } from "./csv.ts";

export interface Order {
  id: string;
  customer: string;
  note: string;
  /** Integer cents. */
  amountCents: number;
}

export const HEADER = ["id", "customer", "note", "amount_cents"] as const;

export function ordersToCsv(orders: readonly Order[]): string {
  return toCsv([[...HEADER], ...orders.map((o) => [o.id, o.customer, o.note, String(o.amountCents)])]);
}

export function ordersFromCsv(text: string): Order[] {
  const [header, ...rows] = parseCsv(text);
  if (header === undefined || header.join(",") !== HEADER.join(",")) {
    throw new CsvError(`expected header ${HEADER.join(",")}`, 1);
  }
  return rows.map((row, i) => {
    if (row.length !== HEADER.length) {
      throw new CsvError(`expected ${HEADER.length} fields, got ${row.length}`, i + 2);
    }
    const [id, customer, note, amount] = row as [string, string, string, string];
    if (!/^-?\d+$/.test(amount)) throw new CsvError(`Invalid amount_cents '${amount}'`, i + 2);
    return { id, customer, note, amountCents: Number(amount) };
  });
}
