import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalizeToolInput } from "../../src/lib/canonicalize.js";

describe("canonicalizeToolInput", () => {
  test("key order does not affect the output (stable sort)", () => {
    const a = canonicalizeToolInput({ b: 2, a: 1, c: 3 });
    const b = canonicalizeToolInput({ c: 3, a: 1, b: 2 });
    assert.equal(a, b);
  });

  test("nested objects are sorted recursively", () => {
    const a = canonicalizeToolInput({ outer: { z: 1, y: 2 }, a: 1 });
    const b = canonicalizeToolInput({ a: 1, outer: { y: 2, z: 1 } });
    assert.equal(a, b);
  });

  test("arrays preserve element order (order is semantically meaningful)", () => {
    const a = canonicalizeToolInput({ list: [1, 2, 3] });
    const b = canonicalizeToolInput({ list: [3, 2, 1] });
    assert.notEqual(a, b);
  });

  test("truncates to maxChars", () => {
    const big = { command: "x".repeat(5000) };
    const result = canonicalizeToolInput(big, 100);
    assert.equal(result.length, 100);
  });

  test("handles undefined/null input without throwing", () => {
    assert.doesNotThrow(() => canonicalizeToolInput(undefined));
    assert.doesNotThrow(() => canonicalizeToolInput(null));
  });

  test("handles circular references without throwing", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    assert.doesNotThrow(() => canonicalizeToolInput(circular));
  });
});
