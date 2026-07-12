import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { getOrCreateSession } from "../../src/store/session-store.js";
import { finalizeTriggerEvent, getRecentToolCalls, recordTriggerEvent } from "../../src/store/trigger-event-store.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

describe("trigger-event-store", () => {
  let tmp: TempDb;
  const sessionId = "s1";
  beforeEach(() => {
    tmp = openTempDb();
    getOrCreateSession(tmp.db, sessionId, "/tmp/proj", 1000);
  });
  afterEach(() => tmp.cleanup());

  test("recordTriggerEvent inserts with phase2 defaults pending finalization", () => {
    recordTriggerEvent(tmp.db, {
      sessionId,
      step: 1,
      hookEvent: "PostToolUse",
      triggerReason: "cadence",
      forced: false,
      toolName: "Bash",
      inputSig: '{"command":"ls"}',
      ok: true,
      createdAt: 1000,
    });
    const row = tmp.db
      .prepare("SELECT * FROM trigger_event WHERE session_id = ? AND step = ?")
      .get(sessionId, 1) as Record<string, unknown>;
    assert.equal(row.hook_event, "PostToolUse");
    assert.equal(row.trigger_reason, "cadence");
    assert.equal(row.forced, 0);
    assert.equal(row.phase2_ran, 0);
    assert.equal(row.phase2_outcome, "not_applicable");
    assert.equal(row.error, null);
  });

  test("finalizeTriggerEvent updates phase2 fields on the existing row", () => {
    recordTriggerEvent(tmp.db, {
      sessionId,
      step: 1,
      hookEvent: "PostToolUseFailure",
      triggerReason: "forced_failure",
      forced: true,
      toolName: "Bash",
      inputSig: "{}",
      ok: false,
      createdAt: 1000,
    });
    finalizeTriggerEvent(tmp.db, sessionId, 1, {
      phase2Ran: true,
      phase2Outcome: "accepted",
      error: null,
    });
    const row = tmp.db
      .prepare("SELECT * FROM trigger_event WHERE session_id = ? AND step = ?")
      .get(sessionId, 1) as Record<string, unknown>;
    assert.equal(row.phase2_ran, 1);
    assert.equal(row.phase2_outcome, "accepted");
    assert.equal(row.forced, 1);
    assert.equal(row.ok, 0);
  });

  test("getRecentToolCalls filters by tool_name, most recent first, honoring the limit", () => {
    recordTriggerEvent(tmp.db, {
      sessionId,
      step: 1,
      hookEvent: "PostToolUse",
      triggerReason: "not_due",
      forced: false,
      toolName: "Bash",
      inputSig: "sig1",
      ok: true,
      createdAt: 1000,
    });
    recordTriggerEvent(tmp.db, {
      sessionId,
      step: 2,
      hookEvent: "PostToolUse",
      triggerReason: "not_due",
      forced: false,
      toolName: "Edit",
      inputSig: "sig-edit",
      ok: true,
      createdAt: 1001,
    });
    recordTriggerEvent(tmp.db, {
      sessionId,
      step: 3,
      hookEvent: "PostToolUse",
      triggerReason: "cadence",
      forced: false,
      toolName: "Bash",
      inputSig: "sig3",
      ok: true,
      createdAt: 1002,
    });

    const bashCalls = getRecentToolCalls(tmp.db, sessionId, "Bash", 10);
    assert.deepEqual(
      bashCalls.map((c) => c.step),
      [3, 1],
    );

    const limited = getRecentToolCalls(tmp.db, sessionId, "Bash", 1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.step, 3);

    const editCalls = getRecentToolCalls(tmp.db, sessionId, "Edit", 10);
    assert.equal(editCalls.length, 1);
  });

  test("getRecentToolCalls naturally excludes the current (not-yet-recorded) step when queried first", () => {
    recordTriggerEvent(tmp.db, {
      sessionId,
      step: 1,
      hookEvent: "PostToolUse",
      triggerReason: "not_due",
      forced: false,
      toolName: "Bash",
      inputSig: "sig1",
      ok: true,
      createdAt: 1000,
    });
    // Simulate the engine's required call order: query history BEFORE recording step 2.
    const before = getRecentToolCalls(tmp.db, sessionId, "Bash", 10);
    assert.equal(before.length, 1);
    recordTriggerEvent(tmp.db, {
      sessionId,
      step: 2,
      hookEvent: "PostToolUse",
      triggerReason: "not_due",
      forced: false,
      toolName: "Bash",
      inputSig: "sig2",
      ok: true,
      createdAt: 1001,
    });
    const after = getRecentToolCalls(tmp.db, sessionId, "Bash", 10);
    assert.equal(after.length, 2);
  });
});
