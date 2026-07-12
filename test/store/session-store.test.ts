import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { getOrCreateSession, getSession, incrementStep, updateSessionStatus } from "../../src/store/session-store.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

describe("session-store", () => {
  let tmp: TempDb;
  beforeEach(() => {
    tmp = openTempDb();
  });
  afterEach(() => tmp.cleanup());

  test("getOrCreateSession creates a new row with step_count 0", () => {
    const row = getOrCreateSession(tmp.db, "s1", "/tmp/proj", 1000);
    assert.equal(row.session_id, "s1");
    assert.equal(row.cwd, "/tmp/proj");
    assert.equal(row.step_count, 0);
    assert.equal(row.status, "");
    assert.equal(row.created_at, 1000);
    assert.equal(row.updated_at, 1000);
  });

  test("getOrCreateSession is idempotent and does not reset an existing row", () => {
    getOrCreateSession(tmp.db, "s1", "/tmp/proj", 1000);
    incrementStep(tmp.db, "s1", 2000);
    const again = getOrCreateSession(tmp.db, "s1", "/tmp/proj-different-cwd", 3000);
    assert.equal(again.step_count, 1, "existing step_count must be preserved");
    assert.equal(again.cwd, "/tmp/proj", "existing cwd must be preserved, not overwritten");
  });

  test("getSession returns null for unknown session", () => {
    assert.equal(getSession(tmp.db, "does-not-exist"), null);
  });

  test("incrementStep increases step_count by exactly 1 each call and updates updated_at", () => {
    getOrCreateSession(tmp.db, "s1", "/tmp/proj", 1000);
    assert.equal(incrementStep(tmp.db, "s1", 1001), 1);
    assert.equal(incrementStep(tmp.db, "s1", 1002), 2);
    assert.equal(incrementStep(tmp.db, "s1", 1003), 3);
    const row = getSession(tmp.db, "s1");
    assert.equal(row?.step_count, 3);
    assert.equal(row?.updated_at, 1003);
  });

  test("updateSessionStatus overwrites status and updated_at", () => {
    getOrCreateSession(tmp.db, "s1", "/tmp/proj", 1000);
    updateSessionStatus(tmp.db, "s1", "debugging auth flow", 5000);
    const row = getSession(tmp.db, "s1");
    assert.equal(row?.status, "debugging auth flow");
    assert.equal(row?.updated_at, 5000);
  });

  test("two sessions in the same db are fully isolated", () => {
    getOrCreateSession(tmp.db, "s1", "/tmp/proj", 1000);
    getOrCreateSession(tmp.db, "s2", "/tmp/proj", 1000);
    incrementStep(tmp.db, "s1", 1001);
    incrementStep(tmp.db, "s1", 1002);
    incrementStep(tmp.db, "s2", 1001);
    assert.equal(getSession(tmp.db, "s1")?.step_count, 2);
    assert.equal(getSession(tmp.db, "s2")?.step_count, 1);
  });
});
