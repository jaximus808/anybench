// The RFC 4180 round-trip tests, removed when the bug was planted (synthetic history: see
// workloads/bug-hunt/PROVENANCE.md). They are part of the grader for bug-hunt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ordersFromCsv, ordersToCsv, type Order } from "../src/orders.ts";

test("orders with commas, quotes and multi-line notes round-trip (#212)", () => {
  const orders: Order[] = [
    { id: "o-1", customer: "Acme, Inc.", note: "ship to dock 4", amountCents: 129900 },
    { id: "o-2", customer: 'Bob "The Builder" Ltd', note: "call first,\nthen deliver", amountCents: -500 },
    { id: "o-3", customer: "Plain Co", note: "", amountCents: 0 },
  ];
  const csv = ordersToCsv(orders);
  assert.ok(csv.startsWith("id,customer,note,amount_cents\n"));
  assert.deepEqual(ordersFromCsv(csv), orders);
});

test("ordersFromCsv reads a CRLF export saved by Excel (#212)", () => {
  const excel =
    "id,customer,note,amount_cents\r\n" +
    'o-9,"Smith, Jones & Co","said ""rush it""\r\nand ""gift wrap""",4250\r\n' +
    "o-10,Kim,,99\r\n";
  assert.deepEqual(ordersFromCsv(excel), [
    { id: "o-9", customer: "Smith, Jones & Co", note: 'said "rush it"\r\nand "gift wrap"', amountCents: 4250 },
    { id: "o-10", customer: "Kim", note: "", amountCents: 99 },
  ]);
});
