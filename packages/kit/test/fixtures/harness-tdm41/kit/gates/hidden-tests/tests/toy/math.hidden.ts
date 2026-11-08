import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/add.ts";
import { mul } from "../src/mul.ts";

test("add", () => assert.equal(add(2, 3), 5));
test("mul", () => assert.equal(mul(2, 3), 6));
