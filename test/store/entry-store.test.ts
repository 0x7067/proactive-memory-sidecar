import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  applyBankOps,
  getEntry,
  getLiveEntryCount,
  getLiveEntryIdSet,
  listLiveEntries,
  markInjected,
} from "../../src/store/entry-store.js";
import { getOrCreateSession } from "../../src/store/session-store.js";
import type { ParsedOpEntry } from "../../src/types.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

function valid(o: Extract<ParsedOpEntry, { valid: true }>["op"]): ParsedOpEntry {
  return { valid: true, op: o };
}

describe("entry-store: applyBankOps cap/upsert/delete semantics", () => {
  let tmp: TempDb;
  const sessionId = "sess-cap";

  beforeEach(() => {
    tmp = openTempDb();
    getOrCreateSession(tmp.db, sessionId, "/tmp/proj", 1000);
  });
  afterEach(() => tmp.cleanup());

  test("save_knowledge on a new id inserts and increments live count", () => {
    const results = applyBankOps(
      tmp.db,
      sessionId,
      1,
      [valid({ op: "save_knowledge", id: "a", content: "fact A" })],
      60,
      1000,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]?.applied, true);
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 1);
    const row = getEntry(tmp.db, sessionId, "a");
    assert.equal(row?.kind, "knowledge");
    assert.equal(row?.content, "fact A");
    assert.equal(row?.created_step, 1);
    assert.equal(row?.updated_step, 1);
    assert.equal(row?.deleted, 0);
  });

  test("save_procedural sets kind=procedural", () => {
    applyBankOps(tmp.db, sessionId, 1, [valid({ op: "save_procedural", id: "p", content: "obs" })], 60, 1000);
    assert.equal(getEntry(tmp.db, sessionId, "p")?.kind, "procedural");
  });

  test("upsert on an already-live id updates content in place without changing live count", () => {
    applyBankOps(tmp.db, sessionId, 1, [valid({ op: "save_knowledge", id: "a", content: "v1" })], 60, 1000);
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 1);

    const results = applyBankOps(
      tmp.db,
      sessionId,
      2,
      [valid({ op: "save_knowledge", id: "a", content: "v2" })],
      60,
      1000,
    );
    assert.equal(results[0]?.applied, true);
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 1);
    const row = getEntry(tmp.db, sessionId, "a");
    assert.equal(row?.content, "v2");
    assert.equal(row?.created_step, 1, "created_step must be preserved across upsert");
    assert.equal(row?.updated_step, 2);
  });

  test("upsert succeeds even when the bank is already exactly at cap", () => {
    const ops: ParsedOpEntry[] = [];
    for (let i = 0; i < 3; i++) ops.push(valid({ op: "save_knowledge", id: `id-${i}`, content: "x" }));
    applyBankOps(tmp.db, sessionId, 1, ops, 3, 1000); // cap=3, fills exactly
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 3);

    const results = applyBankOps(
      tmp.db,
      sessionId,
      2,
      [valid({ op: "save_knowledge", id: "id-0", content: "updated" })],
      3,
      1000,
    );
    assert.equal(results[0]?.applied, true);
    assert.equal(getEntry(tmp.db, sessionId, "id-0")?.content, "updated");
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 3);
  });

  test("save on a new id is rejected once the bank is at cap", () => {
    const ops: ParsedOpEntry[] = [];
    for (let i = 0; i < 3; i++) ops.push(valid({ op: "save_knowledge", id: `id-${i}`, content: "x" }));
    applyBankOps(tmp.db, sessionId, 1, ops, 3, 1000);

    const results = applyBankOps(
      tmp.db,
      sessionId,
      2,
      [valid({ op: "save_knowledge", id: "new-id", content: "y" })],
      3,
      1000,
    );
    assert.equal(results[0]?.applied, false);
    assert.equal(results[0]?.reason, "cap_exceeded");
    assert.equal(getEntry(tmp.db, sessionId, "new-id"), null);
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 3);
  });

  test("delete frees capacity for a LATER save in the same ordered batch", () => {
    const ops: ParsedOpEntry[] = [];
    for (let i = 0; i < 3; i++) ops.push(valid({ op: "save_knowledge", id: `id-${i}`, content: "x" }));
    applyBankOps(tmp.db, sessionId, 1, ops, 3, 1000); // at cap (3/3)

    const batch: ParsedOpEntry[] = [
      valid({ op: "delete", id: "id-0" }),
      valid({ op: "save_knowledge", id: "new-id", content: "y" }),
    ];
    const results = applyBankOps(tmp.db, sessionId, 2, batch, 3, 2000);
    assert.equal(results[0]?.applied, true, "delete should apply");
    assert.equal(results[1]?.applied, true, "save after delete in the same batch should now fit");
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 3);
    assert.equal(getEntry(tmp.db, sessionId, "id-0")?.deleted, 1);
    assert.ok(getEntry(tmp.db, sessionId, "new-id"));
  });

  test("save BEFORE a later delete in the same batch is rejected even though the delete would have freed room", () => {
    const ops: ParsedOpEntry[] = [];
    for (let i = 0; i < 3; i++) ops.push(valid({ op: "save_knowledge", id: `id-${i}`, content: "x" }));
    applyBankOps(tmp.db, sessionId, 1, ops, 3, 1000); // at cap (3/3)

    const batch: ParsedOpEntry[] = [
      valid({ op: "save_knowledge", id: "new-id", content: "y" }), // evaluated first, no room yet
      valid({ op: "delete", id: "id-0" }),
    ];
    const results = applyBankOps(tmp.db, sessionId, 2, batch, 3, 2000);
    assert.equal(results[0]?.applied, false, "save is evaluated before the delete has freed room");
    assert.equal(results[0]?.reason, "cap_exceeded");
    assert.equal(results[1]?.applied, true, "delete itself still applies");
    assert.equal(getEntry(tmp.db, sessionId, "new-id"), null);
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 2);
  });

  test("deleting an already-deleted id is a no-op, not an error, and does not change live count", () => {
    applyBankOps(tmp.db, sessionId, 1, [valid({ op: "save_knowledge", id: "a", content: "x" })], 60, 1000);
    applyBankOps(tmp.db, sessionId, 2, [valid({ op: "delete", id: "a" })], 60, 1000);
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 0);

    const results = applyBankOps(tmp.db, sessionId, 3, [valid({ op: "delete", id: "a" })], 60, 1000);
    assert.equal(results[0]?.applied, false);
    assert.equal(results[0]?.reason, "not_found_or_already_deleted");
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 0);
  });

  test("deleting an unknown id is a no-op", () => {
    const results = applyBankOps(tmp.db, sessionId, 1, [valid({ op: "delete", id: "never-existed" })], 60, 1000);
    assert.equal(results[0]?.applied, false);
    assert.equal(results[0]?.reason, "not_found_or_already_deleted");
  });

  test("reviving a soft-deleted id consumes capacity like a fresh insert", () => {
    applyBankOps(tmp.db, sessionId, 1, [valid({ op: "save_knowledge", id: "a", content: "x" })], 1, 1000);
    applyBankOps(tmp.db, sessionId, 2, [valid({ op: "delete", id: "a" })], 1, 1000);
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 0);

    // Fill the (cap=1) bank with something else first.
    applyBankOps(tmp.db, sessionId, 3, [valid({ op: "save_knowledge", id: "b", content: "y" })], 1, 1000);
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 1);

    // Reviving "a" while "b" occupies the only slot must be rejected.
    const rejected = applyBankOps(
      tmp.db,
      sessionId,
      4,
      [valid({ op: "save_knowledge", id: "a", content: "revived" })],
      1,
      1000,
    );
    assert.equal(rejected[0]?.applied, false);
    assert.equal(rejected[0]?.reason, "cap_exceeded");

    // Free the slot, then revive should succeed and preserve created_step.
    applyBankOps(tmp.db, sessionId, 5, [valid({ op: "delete", id: "b" })], 1, 1000);
    const revived = applyBankOps(
      tmp.db,
      sessionId,
      6,
      [valid({ op: "save_knowledge", id: "a", content: "revived" })],
      1,
      1000,
    );
    assert.equal(revived[0]?.applied, true);
    const row = getEntry(tmp.db, sessionId, "a");
    assert.equal(row?.deleted, 0);
    assert.equal(row?.content, "revived");
    assert.equal(row?.created_step, 1, "created_step is preserved across delete+revive");
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 1);
  });

  test("update_status writes session.status and never touches entry rows or live count", () => {
    const results = applyBankOps(
      tmp.db,
      sessionId,
      1,
      [valid({ op: "update_status", status: "debugging regex" })],
      60,
      1000,
    );
    assert.equal(results[0]?.applied, true);
    const session = tmp.db.prepare("SELECT status FROM session WHERE session_id = ?").get(sessionId) as {
      status: string;
    };
    assert.equal(session.status, "debugging regex");
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 0);
  });

  test("invalid (unparsed) op entries are recorded in original sequence order without stopping the batch", () => {
    const batch: ParsedOpEntry[] = [
      valid({ op: "save_knowledge", id: "a", content: "x" }),
      { valid: false, raw: { op: "not_a_real_op" }, reason: "unrecognized op type" },
      valid({ op: "save_knowledge", id: "b", content: "y" }),
    ];
    const results = applyBankOps(tmp.db, sessionId, 1, batch, 60, 1000);
    assert.equal(results.length, 3);
    assert.equal(results[0]?.seq, 1);
    assert.equal(results[0]?.applied, true);
    assert.equal(results[1]?.seq, 2);
    assert.equal(results[1]?.applied, false);
    assert.equal(results[1]?.op, "not_a_real_op");
    assert.equal(results[2]?.seq, 3);
    assert.equal(results[2]?.applied, true);
    assert.equal(getLiveEntryCount(tmp.db, sessionId), 2);
  });

  test("listLiveEntries excludes deleted rows and orders by created_step", () => {
    applyBankOps(tmp.db, sessionId, 1, [valid({ op: "save_knowledge", id: "z", content: "z" })], 60, 1000);
    applyBankOps(tmp.db, sessionId, 2, [valid({ op: "save_knowledge", id: "a", content: "a" })], 60, 1000);
    applyBankOps(tmp.db, sessionId, 3, [valid({ op: "delete", id: "z" })], 60, 1000);

    const live = listLiveEntries(tmp.db, sessionId);
    assert.deepEqual(
      live.map((e) => e.id),
      ["a"],
    );
  });

  test("getLiveEntryIdSet reflects only non-deleted ids", () => {
    applyBankOps(tmp.db, sessionId, 1, [valid({ op: "save_knowledge", id: "a", content: "a" })], 60, 1000);
    applyBankOps(tmp.db, sessionId, 2, [valid({ op: "save_knowledge", id: "b", content: "b" })], 60, 1000);
    applyBankOps(tmp.db, sessionId, 3, [valid({ op: "delete", id: "a" })], 60, 1000);

    const ids = getLiveEntryIdSet(tmp.db, sessionId);
    assert.equal(ids.has("a"), false);
    assert.equal(ids.has("b"), true);
  });

  test("markInjected increments inject_count and sets last_injected_step", () => {
    applyBankOps(tmp.db, sessionId, 1, [valid({ op: "save_knowledge", id: "a", content: "a" })], 60, 1000);
    markInjected(tmp.db, sessionId, ["a"], 5);
    let row = getEntry(tmp.db, sessionId, "a");
    assert.equal(row?.inject_count, 1);
    assert.equal(row?.last_injected_step, 5);

    markInjected(tmp.db, sessionId, ["a"], 9);
    row = getEntry(tmp.db, sessionId, "a");
    assert.equal(row?.inject_count, 2);
    assert.equal(row?.last_injected_step, 9);
  });
});
