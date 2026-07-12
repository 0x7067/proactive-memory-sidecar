import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { trigramSimilarity } from "../../src/lib/trigram-similarity.js";

describe("trigramSimilarity", () => {
  test("identical strings have similarity 1", () => {
    assert.equal(trigramSimilarity("the quick brown fox", "the quick brown fox"), 1);
  });

  test("identical after case/whitespace normalization has similarity 1", () => {
    assert.equal(trigramSimilarity("The  Quick Brown", "the quick brown"), 1);
  });

  test("completely different strings have low similarity", () => {
    const sim = trigramSimilarity("regex fails on ipv4 octets", "database connection timed out");
    assert.ok(sim < 0.2, `expected low similarity, got ${sim}`);
  });

  test("near-duplicate phrasing scores above the 0.85 suppression threshold", () => {
    const a = "Reminder: the task requires single-digit IPv4 octets to match.";
    const b = "Reminder: the task requires single-digit IPv4 octets to match!";
    assert.ok(trigramSimilarity(a, b) > 0.85, "trivial punctuation change should still count as near-duplicate");
  });

  test("substantively different reminders about the same topic score below the threshold", () => {
    const a = "Reminder: the task requires single-digit IPv4 octets to match.";
    const b = "Reminder: the config file must be valid JSON before the parser will accept it.";
    assert.ok(trigramSimilarity(a, b) <= 0.85);
  });

  test("both-empty strings are treated as identical", () => {
    assert.equal(trigramSimilarity("", ""), 1);
  });

  test("one empty, one non-empty is maximally dissimilar", () => {
    assert.equal(trigramSimilarity("", "something"), 0);
  });

  test("similarity is symmetric", () => {
    const a = "the regex failed on step 14";
    const b = "a completely unrelated sentence about ports";
    assert.equal(trigramSimilarity(a, b), trigramSimilarity(b, a));
  });
});
