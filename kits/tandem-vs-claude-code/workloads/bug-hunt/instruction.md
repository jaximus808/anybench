# Task: fix the broken CSV export (support ticket #231)

The repository in your working directory is `report-export` (read its `README.md`). Finance
reported this:

> The order export is broken for some customers.
>
> 1. Any customer whose name has a comma in it (`Acme, Inc.`) shows up with the columns shifted
>    one to the right when we open the export in Excel.
> 2. When we send the file back for re-import, it fails with `Invalid amount_cents` or
>    `expected 4 fields, got 5`.
> 3. Notes with quotes in them (`said "rush it"`) or with line breaks come back mangled, and a
>    multi-line note turns into extra rows.
> 4. Files we saved from Excel (Windows line endings) don't import at all.

Find the cause and fix it. The fix should follow RFC 4180, which is what Excel reads and writes:

- A field that contains a comma, a double quote, `\r` or `\n` is written inside double quotes, and
  any double quote inside it is doubled (`say "hi"` → `"say ""hi"""`). Other fields are written as is.
- Output rows still end with `\n`. Input rows may end with `\n` or `\r\n`.
- On input, quoted fields may contain commas, doubled quotes and line breaks; `""` is an empty field.
- An unterminated quoted field throws `CsvError` whose `line` is the line where the quote opened
  (1-based).
- Keep the public API in `src/index.ts` unchanged: `toCsv`, `parseCsv`, `CsvError`,
  `ordersToCsv`, `ordersFromCsv`.

Ground rules: no new dependencies; Node runs the `.ts` files directly (erasable TypeScript only).
Add regression tests under `test/` for what you fixed (`npm test` must pass).
