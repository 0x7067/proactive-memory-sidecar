import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decideTrigger } from "../../src/trigger/trigger-policy.js";

describe("trigger-policy: decideTrigger", () => {
  test("PreCompact always triggers, forced, phase2 ineligible", () => {
    const decision = decideTrigger({
      hookEvent: "PreCompact",
      newStep: 1,
      cadenceN: 4,
      isNearDuplicate: false,
    });
    assert.deepEqual(decision, {
      triggered: true,
      forced: true,
      reason: "precompact_sweep",
      phase2Eligible: false,
    });
  });

  test("PreCompact ignores cadence/near-duplicate inputs entirely", () => {
    const decision = decideTrigger({
      hookEvent: "PreCompact",
      newStep: 4,
      cadenceN: 4,
      isNearDuplicate: true,
    });
    assert.equal(decision.reason, "precompact_sweep");
  });

  test("PostToolUseFailure always triggers, forced, phase2 eligible", () => {
    const decision = decideTrigger({
      hookEvent: "PostToolUseFailure",
      newStep: 1,
      cadenceN: 4,
      isNearDuplicate: false,
    });
    assert.deepEqual(decision, {
      triggered: true,
      forced: true,
      reason: "forced_failure",
      phase2Eligible: true,
    });
  });

  test("PostToolUse: near-duplicate forces a trigger even off cadence", () => {
    const decision = decideTrigger({
      hookEvent: "PostToolUse",
      newStep: 5,
      cadenceN: 4,
      isNearDuplicate: true,
    });
    assert.deepEqual(decision, {
      triggered: true,
      forced: true,
      reason: "forced_near_duplicate",
      phase2Eligible: true,
    });
  });

  test("PostToolUse: near-duplicate takes precedence over cadence when both are true", () => {
    const decision = decideTrigger({
      hookEvent: "PostToolUse",
      newStep: 8, // a cadence multiple of 4
      cadenceN: 4,
      isNearDuplicate: true,
    });
    assert.equal(decision.reason, "forced_near_duplicate");
    assert.equal(decision.forced, true);
  });

  test("PostToolUse: fires on cadence multiples", () => {
    for (const step of [4, 8, 12, 40]) {
      const decision = decideTrigger({ hookEvent: "PostToolUse", newStep: step, cadenceN: 4, isNearDuplicate: false });
      assert.equal(decision.triggered, true, `step ${step} should trigger`);
      assert.equal(decision.forced, false);
      assert.equal(decision.reason, "cadence");
    }
  });

  test("PostToolUse: does not fire off cadence (fast path, not forced)", () => {
    for (const step of [1, 2, 3, 5, 6, 7, 9]) {
      const decision = decideTrigger({ hookEvent: "PostToolUse", newStep: step, cadenceN: 4, isNearDuplicate: false });
      assert.equal(decision.triggered, false, `step ${step} should not trigger`);
      assert.equal(decision.reason, "not_due");
    }
  });

  test("cadenceN=1 triggers on every PostToolUse call", () => {
    for (const step of [1, 2, 3]) {
      const decision = decideTrigger({ hookEvent: "PostToolUse", newStep: step, cadenceN: 1, isNearDuplicate: false });
      assert.equal(decision.triggered, true);
      assert.equal(decision.reason, "cadence");
    }
  });

  test("phase2Eligible is true for every non-PreCompact trigger, triggered or not", () => {
    const notDue = decideTrigger({ hookEvent: "PostToolUse", newStep: 1, cadenceN: 4, isNearDuplicate: false });
    assert.equal(notDue.phase2Eligible, true);
  });
});
