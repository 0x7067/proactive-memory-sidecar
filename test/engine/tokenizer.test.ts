import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { estimateTokens } from "../../src/engine/tokenizer.js";

describe("estimateTokens", () => {
  test("empty string is 0 tokens", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("   "), 0);
  });

  test("uses word count when it exceeds the char/4 estimate", () => {
    // 5 short words, ~19 chars -> char estimate ceil(19/4)=5, word count=5 -> max=5
    const text = "a b c d e";
    assert.equal(estimateTokens(text), Math.max(5, Math.ceil(text.length / 4)));
  });

  test("uses char/4 estimate when text has few/no spaces (dense token)", () => {
    const dense = "a".repeat(400); // 1 "word", 400 chars -> char estimate 100
    assert.equal(estimateTokens(dense), 100);
  });

  test("matches the documented formula: max(wordCount, ceil(chars/4))", () => {
    const text = "the quick brown fox jumps over the lazy dog and then keeps running";
    const words = text.split(/\s+/).filter(Boolean).length;
    const chars = Math.ceil(text.length / 4);
    assert.equal(estimateTokens(text), Math.max(words, chars));
  });

  test("the paper's own example reminder is comfortably under 100 tokens", () => {
    const text =
      'Reminder: the task requires single-digit IPv4 octets to match; the current regex was already observed failing on "1.2.3.4" at step 14.';
    assert.ok(estimateTokens(text) <= 100, `expected <=100, got ${estimateTokens(text)}`);
  });

  test("a long paragraph exceeds the 100 token cap", () => {
    const text = Array.from({ length: 110 }, (_, i) => `word${i}`).join(" ");
    assert.ok(estimateTokens(text) > 100, `expected >100, got ${estimateTokens(text)}`);
  });
});
