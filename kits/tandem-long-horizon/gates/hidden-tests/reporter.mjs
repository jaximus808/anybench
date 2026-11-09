// node:test reporter for the hidden-tests gate: one JSON line per finished test.
// Used as `--test-reporter=<this file>`; grade.mjs reads the lines back.
export default async function* hiddenTestsReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const data = event.data;
    if (data.details?.type === "suite") continue;
    const line = { status: event.type === "test:pass" ? "pass" : "fail", name: data.name, file: data.file ?? null };
    if (event.type === "test:fail") {
      const err = data.details?.error;
      line.error = String(err?.cause?.message ?? err?.message ?? "failed").slice(0, 2000);
    }
    yield `${JSON.stringify(line)}\n`;
  }
}
