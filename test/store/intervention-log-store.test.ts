import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { getRecentReminders, recordInterventionLog } from "../../src/store/intervention-log-store.js";
import { getOrCreateSession } from "../../src/store/session-store.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

describe("intervention-log-store", () => {
  let tmp: TempDb;
  const sessionId = "s1";
  beforeEach(() => {
    tmp = openTempDb();
    getOrCreateSession(tmp.db, sessionId, "/tmp/proj", 1000);
  });
  afterEach(() => tmp.cleanup());

  test("recordInterventionLog persists a silence row with nullable fields left null", () => {
    recordInterventionLog(tmp.db, {
      sessionId,
      step: 1,
      decision: "silence",
      reminder: null,
      entryIds: null,
      latencyMs: 3,
      tokensIn: null,
      tokensOut: null,
      shadow: false,
    });
    const row = tmp.db
      .prepare("SELECT * FROM intervention_log WHERE session_id = ? AND step = ?")
      .get(sessionId, 1) as Record<string, unknown>;
    assert.equal(row.decision, "silence");
    assert.equal(row.reminder, null);
    assert.equal(row.entry_ids, null);
    assert.equal(row.shadow, 0);
  });

  test("recordInterventionLog serializes entry_ids as a JSON array string", () => {
    recordInterventionLog(tmp.db, {
      sessionId,
      step: 2,
      decision: "reminder",
      reminder: "Reminder: fact.",
      entryIds: ["req:a", "proc:b"],
      latencyMs: 120,
      tokensIn: 500,
      tokensOut: 40,
      shadow: true,
    });
    const row = tmp.db
      .prepare("SELECT * FROM intervention_log WHERE session_id = ? AND step = ?")
      .get(sessionId, 2) as Record<string, unknown>;
    assert.equal(row.shadow, 1);
    assert.deepEqual(JSON.parse(row.entry_ids as string), ["req:a", "proc:b"]);
  });

  test("(session_id, step) is the primary key: a duplicate insert throws", () => {
    recordInterventionLog(tmp.db, {
      sessionId,
      step: 1,
      decision: "silence",
      reminder: null,
      entryIds: null,
      latencyMs: 1,
      tokensIn: null,
      tokensOut: null,
      shadow: false,
    });
    assert.throws(() => {
      recordInterventionLog(tmp.db, {
        sessionId,
        step: 1,
        decision: "silence",
        reminder: null,
        entryIds: null,
        latencyMs: 1,
        tokensIn: null,
        tokensOut: null,
        shadow: false,
      });
    });
  });

  test("getRecentReminders returns only decision='reminder' rows, most recent first, honoring the limit", () => {
    recordInterventionLog(tmp.db, {
      sessionId,
      step: 1,
      decision: "reminder",
      reminder: "first",
      entryIds: ["a"],
      latencyMs: 1,
      tokensIn: null,
      tokensOut: null,
      shadow: false,
    });
    recordInterventionLog(tmp.db, {
      sessionId,
      step: 2,
      decision: "silence",
      reminder: null,
      entryIds: null,
      latencyMs: 1,
      tokensIn: null,
      tokensOut: null,
      shadow: false,
    });
    recordInterventionLog(tmp.db, {
      sessionId,
      step: 3,
      decision: "reminder",
      reminder: "second",
      entryIds: ["b"],
      latencyMs: 1,
      tokensIn: null,
      tokensOut: null,
      shadow: true,
    });
    recordInterventionLog(tmp.db, {
      sessionId,
      step: 4,
      decision: "reminder",
      reminder: "third",
      entryIds: ["c"],
      latencyMs: 1,
      tokensIn: null,
      tokensOut: null,
      shadow: false,
    });

    const recent = getRecentReminders(tmp.db, sessionId, 2);
    assert.deepEqual(
      recent.map((r) => r.reminder),
      ["third", "second"],
    );

    const all = getRecentReminders(tmp.db, sessionId, 10);
    assert.equal(all.length, 3, "shadow reminders must be included, not just live ones");
  });
});
