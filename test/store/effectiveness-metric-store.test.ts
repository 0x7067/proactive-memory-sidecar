import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  getEffectivenessMetric,
  recordEffectivenessMetric,
} from "../../src/store/effectiveness-metric-store.js";
import { getOrCreateSession } from "../../src/store/session-store.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

describe("effectiveness-metric-store", () => {
  let tmp: TempDb;
  beforeEach(() => {
    tmp = openTempDb();
    getOrCreateSession(tmp.db, "s1", tmp.dir, 1);
  });
  afterEach(() => tmp.cleanup());

  test("records only categorical and numeric effectiveness fields", () => {
    recordEffectivenessMetric(tmp.db, {
      sessionId: "s1",
      step: 1,
      harness: "codex",
      triggerReason: "cadence",
      skipReason: "guard_rejection",
      providerOutcome: "success",
      parserOutcome: "accepted",
      guardOutcome: "rejected:grounding",
      bankOperation: "mixed",
      bankOpsTotal: 2,
      bankOpsApplied: 1,
      bankOpsRejected: 1,
      emittedReminder: false,
      latencyMs: 25,
      tokensIn: 100,
      tokensOut: 10,
      createdAt: 1,
    });
    assert.deepEqual({ ...getEffectivenessMetric(tmp.db, "s1", 1) }, {
      session_id: "s1",
      step: 1,
      harness: "codex",
      trigger_reason: "cadence",
      skip_reason: "guard_rejection",
      provider_outcome: "success",
      parser_outcome: "accepted",
      guard_outcome: "rejected:grounding",
      bank_operation: "mixed",
      bank_ops_total: 2,
      bank_ops_applied: 1,
      bank_ops_rejected: 1,
      emitted_reminder: 0,
      latency_ms: 25,
      tokens_in: 100,
      tokens_out: 10,
      created_at: 1,
    });
  });
});
