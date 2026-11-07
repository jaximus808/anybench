import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, toCsv } from "../src/csv.ts";
import { ordersFromCsv, ordersToCsv } from "../src/orders.ts";

test("toCsv writes one line per row", () => {
  assert.equal(toCsv([["a", "b"], ["c", "d"]]), "a,b\nc,d\n");
});

test("parseCsv reads simple rows and ignores the trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\nc,d\n"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(parseCsv(""), []);
});

test("orders round-trip", () => {
  const orders = [{ id: "o1", customer: "Ada", note: "first order", amountCents: 1250 }];
  assert.deepEqual(ordersFromCsv(ordersToCsv(orders)), orders);
});

test("ordersFromCsv rejects a bad header", () => {
  assert.throws(() => ordersFromCsv("nope\n"), { name: "CsvError" });
});
