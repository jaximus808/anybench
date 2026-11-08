// The RFC 4180 codec's tests, removed when the bug was planted (synthetic history: see
// workloads/bug-hunt/PROVENANCE.md). They are the grader for bug-hunt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, toCsv } from "../src/csv.ts";

test("toCsv quotes a field that contains a comma", () => {
  assert.equal(toCsv([["Acme, Inc.", "ok"]]), '"Acme, Inc.",ok\n');
});

test("toCsv doubles quotes inside a quoted field", () => {
  assert.equal(toCsv([['say "hi"', "x"]]), '"say ""hi""",x\n');
});

test("toCsv quotes fields with line breaks", () => {
  assert.equal(toCsv([["line 1\nline 2", "a\r\nb"]]), '"line 1\nline 2","a\r\nb"\n');
});

test("parseCsv unquotes a field that contains a comma", () => {
  assert.deepEqual(parseCsv('"Acme, Inc.",ok\n'), [["Acme, Inc.", "ok"]]);
});

test("parseCsv turns doubled quotes back into one", () => {
  assert.deepEqual(parseCsv('"say ""hi""",x\n'), [['say "hi"', "x"]]);
});

test("parseCsv keeps line breaks inside quoted fields in the same row", () => {
  assert.deepEqual(parseCsv('"line 1\nline 2",x\ny,z\n'), [["line 1\nline 2", "x"], ["y", "z"]]);
});

test("parseCsv accepts CRLF row endings", () => {
  assert.deepEqual(parseCsv("a,b\r\nc,d\r\n"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(parseCsv('"x,1",y\r\nz,w'), [["x,1", "y"], ["z", "w"]]);
});

test("parseCsv reads empty quoted fields and trailing empty fields", () => {
  assert.deepEqual(parseCsv('"",x,\n'), [["", "x", ""]]);
});

test("parseCsv rejects an unterminated quoted field with CsvError", () => {
  assert.throws(() => parseCsv('ok,fine\n"never closed,x\n'), (err: Error & { line?: number }) => {
    assert.equal(err.name, "CsvError");
    assert.equal(err.line, 2, "the error points at the line where the quote opened");
    return true;
  });
});

test("parseCsv(toCsv(rows)) round-trips awkward fields", () => {
  const rows = [
    ["plain", "", " padded ", "trailing,"],
    [",", '"', '""', "a\"b"],
    ["\n", "\r\n", "multi\nline\nnote", "comma, and \"quote\""],
    ["ünïcödé, ok", "tab\there", "=SUM(A1)", "last"],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});
