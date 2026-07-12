import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { recordBankOpLog } from "../../src/store/bank-op-log-store.js";
import { getOrCreateSession } from "../../src/store/session-store.js";
import type { AppliedOpResult } from "../../src/types.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

describe("bank-op-log-store", () => {
  let tmp: TempDb;
  const sessionId = "s1";
  beforeEach(() => {
    tmp = openTempDb();
    getOrCreateSession(tmp.db, sessionId, "/tmp/proj", 1000);
  });
  afterEach(() => tmp.cleanup());

  test("records every result in order with seq preserved", () => {
    const results: AppliedOpResult[] = [
      { seq: 1, op: "save_knowledge", entryId: "a", applied: true, reason: null },
      { seq: 2, op: "delete", entryId: "z", applied: false, reason: "not_found_or_already_deleted" },
      { seq: 3, op: "unknown_op", entryId: null, applied: false, reason: "unrecognized op type" },
    ];
    recordBankOpLog(tmp.db, sessionId, 7, results, 5000);

    const rows = tmp.db
      .prepare("SELECT * FROM bank_op_log WHERE session_id = ? AND step = ? ORDER BY seq")
      .all(sessionId, 7) as Array<Record<string, unknown>>;

    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.op, "save_knowledge");
    assert.equal(rows[0]?.applied, 1);
    assert.equal(rows[1]?.applied, 0);
    assert.equal(rows[1]?.reason, "not_found_or_already_deleted");
    assert.equal(rows[2]?.entry_id, null);
  });
});
