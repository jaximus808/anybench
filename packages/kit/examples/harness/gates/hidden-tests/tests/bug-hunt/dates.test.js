import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, isLeap, isoWeek } from "../dates.js";

test("centuries are not leap years unless divisible by 400", () => {
  assert.equal(isLeap(1900), false);
  assert.equal(isLeap(2000), true);
});
test("Jan 31 + 1 month is the last day of February", () => {
  assert.equal(addMonths(new Date(2023, 0, 31), 1).getDate(), 28);
});
test("2021-01-03 is in ISO week 53", () => {
  assert.equal(isoWeek(new Date(2021, 0, 3)), 53);
});
