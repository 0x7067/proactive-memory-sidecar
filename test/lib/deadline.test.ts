import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDeadline } from "../../src/lib/deadline.js";

describe("createDeadline", () => {
  test("remainingMs starts at the full budget and decreases with elapsed time", () => {
    const d = createDeadline(1000, 0);
    assert.equal(d.remainingMs(0), 1000);
    assert.equal(d.remainingMs(400), 600);
    assert.equal(d.remainingMs(999), 1);
  });

  test("remainingMs never goes negative once the deadline has passed", () => {
    const d = createDeadline(1000, 0);
    assert.equal(d.remainingMs(1000), 0);
    assert.equal(d.remainingMs(5000), 0);
  });

  test("isExpired is false strictly before the deadline and true at/after it", () => {
    const d = createDeadline(1000, 0);
    assert.equal(d.isExpired(999), false);
    assert.equal(d.isExpired(1000), true);
    assert.equal(d.isExpired(1500), true);
  });

  test("a zero or negative budget yields an already-expired deadline", () => {
    const zero = createDeadline(0, 1000);
    assert.equal(zero.remainingMs(1000), 0);
    assert.equal(zero.isExpired(1000), true);

    const negative = createDeadline(-50, 1000);
    assert.equal(negative.remainingMs(1000), 0);
    assert.equal(negative.isExpired(1000), true);
    assert.equal(negative.deadlineAt, 1000, "deadlineAt must not go before startedAt");
  });

  test("startedAt and deadlineAt are recorded exactly", () => {
    const d = createDeadline(2500, 10_000);
    assert.equal(d.startedAt, 10_000);
    assert.equal(d.deadlineAt, 12_500);
  });

  test("defaults `startedAt` and `now` to the real clock when omitted", () => {
    const before = Date.now();
    const d = createDeadline(10_000);
    const after = Date.now();
    assert.ok(d.startedAt >= before && d.startedAt <= after);
    assert.ok(d.remainingMs() > 9000, "remainingMs() with no arg should read the real clock, near the full budget");
    assert.equal(d.isExpired(), false);
  });
});
