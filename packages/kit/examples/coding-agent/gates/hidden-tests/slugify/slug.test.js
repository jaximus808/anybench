// Hidden tests for the slugify workload. They live in the kit's gates/, never in the workspace,
// and run only on the scoring computer. Every assertion traces to workloads/slugify/instruction.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slug.js";

test("lower-cases and joins words with -", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("the instruction's first example", () => {
  assert.equal(slugify("  Hello, World!  "), "hello-world");
});

test("strips accents (the instruction's second example)", () => {
  assert.equal(slugify("Crème brûlée"), "creme-brulee");
  assert.equal(slugify("año"), "ano");
});

test("collapses runs of other characters into one -", () => {
  assert.equal(slugify("a -- b__c...d"), "a-b-c-d");
});

test("keeps digits", () => {
  assert.equal(slugify("Top 10 of 2026"), "top-10-of-2026");
});

test("no - at the start or the end", () => {
  assert.equal(slugify("--edge--"), "edge");
});

test("an empty result is untitled", () => {
  assert.equal(slugify("!!!"), "untitled");
  assert.equal(slugify(""), "untitled");
});
