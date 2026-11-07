# report-export

Turns orders into CSV for the finance team's spreadsheet, and reads those CSV files back
(finance edits them in Excel and sends them back for re-import).

No runtime dependencies, no build step: Node 22.18+ runs the TypeScript directly (type stripping),
so only erasable syntax is allowed and local imports keep their `.ts` extension.

```sh
npm test
```

| File | What it does |
| --- | --- |
| `src/csv.ts` | `toCsv(rows)` and `parseCsv(text)`: the CSV codec. |
| `src/orders.ts` | `ordersToCsv(orders)` and `ordersFromCsv(text)`, with the `id,customer,note,amount_cents` header. |
| `src/index.ts` | Public exports. |

Amounts are integer cents. Rows end with `\n` on output; input may use `\n` or `\r\n`.
