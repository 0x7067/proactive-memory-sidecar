import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { getOrCreateSession } from "../../src/store/session-store.js";
import {
  advanceCommittedStep,
  getSessionProgress,
  incrementPostToolUseSuccessCount,
} from "../../src/store/session-progress-store.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

describe("session-progress-store", () => {
  let tmp: TempDb;
  const sessionId = "s1";
  beforeEach(() => {
    tmp = openTempDb();
    getOrCreateSession(tmp.db, sessionId, "/tmp/proj", 1000);
  });
  afterEach(() => tmp.cleanup());

  test("getSessionProgress defaults to zeros for a session with no progress row yet", () => {
    assert.deepEqual(getSessionProgress(tmp.db, sessionId), { committedStep: 0, postToolUseSuccessCount: 0 });
  });

  test("incrementPostToolUseSuccessCount increases by exactly 1 per call and returns the new value", () => {
    assert.equal(incrementPostToolUseSuccessCount(tmp.db, sessionId), 1);
    assert.equal(incrementPostToolUseSuccessCount(tmp.db, sessionId), 2);
    assert.equal(incrementPostToolUseSuccessCount(tmp.db, sessionId), 3);
    assert.equal(getSessionProgress(tmp.db, sessionId).postToolUseSuccessCount, 3);
  });

  test("advanceCommittedStep sets the watermark forward", () => {
    advanceCommittedStep(tmp.db, sessionId, 5);
    assert.equal(getSessionProgress(tmp.db, sessionId).committedStep, 5);
  });

  test("advanceCommittedStep never regresses the watermark, even if called with a smaller step", () => {
    advanceCommittedStep(tmp.db, sessionId, 5);
    advanceCommittedStep(tmp.db, sessionId, 2);
    assert.equal(getSessionProgress(tmp.db, sessionId).committedStep, 5, "watermark must not go backwards");
    advanceCommittedStep(tmp.db, sessionId, 9);
    assert.equal(getSessionProgress(tmp.db, sessionId).committedStep, 9);
  });

  test("committedStep and postToolUseSuccessCount are independent counters", () => {
    incrementPostToolUseSuccessCount(tmp.db, sessionId);
    advanceCommittedStep(tmp.db, sessionId, 40);
    const progress = getSessionProgress(tmp.db, sessionId);
    assert.equal(progress.postToolUseSuccessCount, 1);
    assert.equal(progress.committedStep, 40);
  });

  test("two sessions are fully isolated", () => {
    getOrCreateSession(tmp.db, "s2", "/tmp/proj", 1000);
    incrementPostToolUseSuccessCount(tmp.db, sessionId);
    incrementPostToolUseSuccessCount(tmp.db, sessionId);
    advanceCommittedStep(tmp.db, sessionId, 7);

    incrementPostToolUseSuccessCount(tmp.db, "s2");
    advanceCommittedStep(tmp.db, "s2", 1);

    assert.deepEqual(getSessionProgress(tmp.db, sessionId), { committedStep: 7, postToolUseSuccessCount: 2 });
    assert.deepEqual(getSessionProgress(tmp.db, "s2"), { committedStep: 1, postToolUseSuccessCount: 1 });
  });
});
