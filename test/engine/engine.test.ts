import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { processHookEvent } from "../../src/engine/engine.js";
import type { Config } from "../../src/config.js";
import { FakeModelAdapter } from "../helpers/fake-model-adapter.js";
import { buildTestConfig, makePostToolUseFailurePayload, makePostToolUsePayload, makePreCompactPayload } from "../helpers/fixtures.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

function getTriggerEvent(tmp: TempDb, sessionId: string, step: number): Record<string, unknown> | undefined {
  return tmp.db.prepare("SELECT * FROM trigger_event WHERE session_id = ? AND step = ?").get(sessionId, step);
}

function getInterventionLog(tmp: TempDb, sessionId: string, step: number): Record<string, unknown> | undefined {
  return tmp.db.prepare("SELECT * FROM intervention_log WHERE session_id = ? AND step = ?").get(sessionId, step);
}

describe("engine: processHookEvent", () => {
  let tmp: TempDb;
  let config: Config;

  beforeEach(() => {
    tmp = openTempDb();
    config = buildTestConfig();
  });
  afterEach(() => tmp.cleanup());

  test("fast path: off-cadence PostToolUse makes zero model calls and logs silence", async () => {
    const model = new FakeModelAdapter();
    const outcome = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config,
    });
    assert.equal(outcome.stdoutJson, null);
    assert.equal(model.calls.length, 0, "no model call on a fast-path non-trigger");
    const log = getInterventionLog(tmp, "s1", 1);
    assert.equal(log?.decision, "silence");
    const trig = getTriggerEvent(tmp, "s1", 1);
    assert.equal(trig?.trigger_reason, "not_due");
    assert.equal(trig?.phase2_ran, 0);
  });

  test("cadence trigger: the Nth call makes exactly one model call", async () => {
    const model = new FakeModelAdapter(["<bank_ops>[]</bank_ops>\n<no_intervention/>"]);
    for (let i = 1; i <= 4; i++) {
      // Distinct tool_input per call: identical repeated calls are a
      // *separate* forced trigger (near-duplicate) this test deliberately
      // isolates itself from — see the dedicated near-duplicate coverage in
      // trigger/near-duplicate.test.ts and trigger-policy.test.ts.
      await processHookEvent(
        makePostToolUsePayload({ session_id: "s1", tool_input: { command: `echo step-${i}` } }),
        { db: tmp.db, modelAdapter: model, config },
      );
    }
    assert.equal(model.calls.length, 1, "only the 4th call should invoke the model");
    const trig = getTriggerEvent(tmp, "s1", 4);
    assert.equal(trig?.trigger_reason, "cadence");
    assert.equal(trig?.phase2_ran, 1);
    assert.equal(trig?.phase2_outcome, "no_intervention");
  });

  test("PostToolUseFailure forces a model call even at step 1 (not a cadence multiple)", async () => {
    const model = new FakeModelAdapter(["<bank_ops>[]</bank_ops>\n<no_intervention/>"]);
    await processHookEvent(makePostToolUseFailurePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config,
    });
    assert.equal(model.calls.length, 1);
    const trig = getTriggerEvent(tmp, "s1", 1);
    assert.equal(trig?.trigger_reason, "forced_failure");
    assert.equal(trig?.forced, 1);
  });

  test("shadow mode: an accepted reminder is logged but never emitted on stdout", async () => {
    const shadowConfig = buildTestConfig({ PMS_MODE: "shadow", PMS_CADENCE_N: "1" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"the task requires X"}]</bank_ops>
<context_for_action grounding="req:a">
Reminder: the task requires X, as established earlier.
</context_for_action>`,
    ]);
    const outcome = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: shadowConfig,
    });
    assert.equal(outcome.stdoutJson, null, "shadow mode must never emit additionalContext");
    const log = getInterventionLog(tmp, "s1", 1);
    assert.equal(log?.decision, "reminder");
    assert.equal(log?.shadow, 1);
    assert.match(log?.reminder as string, /Reminder: the task requires X/);
  });

  test("live mode: an accepted reminder is emitted in the exact required wire shape", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"the task requires X"}]</bank_ops>
<context_for_action grounding="req:a">
Reminder: the task requires X, as established earlier.
</context_for_action>`,
    ]);
    const outcome = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    assert.ok(outcome.stdoutJson);
    const parsed = JSON.parse(outcome.stdoutJson) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["hookSpecificOutput"]);
    const hso = parsed.hookSpecificOutput as Record<string, unknown>;
    assert.equal(hso.hookEventName, "PostToolUse");
    assert.equal(hso.additionalContext, "Reminder: the task requires X, as established earlier.");
    assert.deepEqual(Object.keys(hso).sort(), ["additionalContext", "hookEventName"]);

    const log = getInterventionLog(tmp, "s1", 1);
    assert.equal(log?.shadow, 0);
  });

  test("live mode uses hookEventName=PostToolUseFailure for a failure-triggered reminder", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_procedural","id":"proc:fail","content":"npm test failed with exit 1"}]</bank_ops>
<context_for_action grounding="proc:fail">
Reminder: npm test was already observed failing with exit 1.
</context_for_action>`,
    ]);
    const outcome = await processHookEvent(makePostToolUseFailurePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    const parsed = JSON.parse(outcome.stdoutJson as string) as { hookSpecificOutput: { hookEventName: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  });

  test("PreCompact: Phase 1 still applies, but Phase 2 is mechanically forced to silence even if the model returns context_for_action", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_knowledge","id":"req:carryover","content":"important fact to keep across compaction"}]</bank_ops>
<context_for_action grounding="req:carryover">
Reminder: this should not be emitted for PreCompact.
</context_for_action>`,
    ]);
    const outcome = await processHookEvent(makePreCompactPayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    assert.equal(outcome.stdoutJson, null, "PreCompact must never emit additionalContext");
    assert.equal(model.calls.length, 1, "PreCompact always triggers the model for bank maintenance");

    const entry = tmp.db
      .prepare("SELECT * FROM entry WHERE session_id = ? AND id = ?")
      .get("s1", "req:carryover") as Record<string, unknown>;
    assert.ok(entry, "Phase 1 bank maintenance still applies during PreCompact");

    const log = getInterventionLog(tmp, "s1", 1);
    assert.equal(log?.decision, "silence");
    const trig = getTriggerEvent(tmp, "s1", 1);
    assert.equal(trig?.trigger_reason, "precompact_sweep");
    assert.equal(trig?.phase2_ran, 0);
    assert.equal(trig?.phase2_outcome, "not_applicable");
  });

  test("grounding may cite an entry created by this same response's own Phase 1 ops (prospective bank)", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_knowledge","id":"brand-new","content":"created and cited in the same response"}]</bank_ops>
<context_for_action grounding="brand-new">
Reminder: the bank now records a fact created moments ago.
</context_for_action>`,
    ]);
    const outcome = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    assert.ok(outcome.stdoutJson, "grounding against a just-created id must be accepted");
  });

  test("grounding a nonexistent id degrades to silence", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1" });
    const model = new FakeModelAdapter([
      `<bank_ops>[]</bank_ops>
<context_for_action grounding="does-not-exist">
Reminder: this cites nothing real.
</context_for_action>`,
    ]);
    const outcome = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    assert.equal(outcome.stdoutJson, null);
    const trig = getTriggerEvent(tmp, "s1", 1);
    assert.equal(trig?.phase2_outcome, "rejected:grounding");
  });

  test("an imperative-toned candidate degrades to silence", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"fact"}]</bank_ops>
<context_for_action grounding="req:a">
Fix the regex so it only matches single-digit octets.
</context_for_action>`,
    ]);
    const outcome = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    assert.equal(outcome.stdoutJson, null);
    const trig = getTriggerEvent(tmp, "s1", 1);
    assert.equal(trig?.phase2_outcome, "rejected:factual_prose");
  });

  test("model adapter throwing degrades to silence and records the error, without throwing to the caller", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1" });
    const model = new FakeModelAdapter([new Error("simulated network failure")]);
    const outcome = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    assert.equal(outcome.stdoutJson, null);
    const log = getInterventionLog(tmp, "s1", 1);
    assert.equal(log?.decision, "silence");
    const trig = getTriggerEvent(tmp, "s1", 1);
    assert.match(trig?.error as string, /simulated network failure/);
  });

  test("unparseable model output degrades to silence with phase2_outcome=parse_error", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1" });
    const model = new FakeModelAdapter(["I refuse to follow the format today."]);
    const outcome = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    assert.equal(outcome.stdoutJson, null);
    const trig = getTriggerEvent(tmp, "s1", 1);
    assert.equal(trig?.phase2_outcome, "parse_error");
  });

  test("cap enforcement end-to-end: delete-then-save in one Phase 1 batch succeeds at capacity", async () => {
    const tightConfig = buildTestConfig({ PMS_MODE: "shadow", PMS_CADENCE_N: "1", PMS_BANK_CAP: "1" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_knowledge","id":"first","content":"only slot"}]</bank_ops>\n<no_intervention/>`,
      `<bank_ops>[{"op":"delete","id":"first"},{"op":"save_knowledge","id":"second","content":"replacement"}]</bank_ops>\n<no_intervention/>`,
    ]);
    await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), { db: tmp.db, modelAdapter: model, config: tightConfig });
    await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), { db: tmp.db, modelAdapter: model, config: tightConfig });

    const entries = (
      tmp.db.prepare("SELECT id, deleted FROM entry WHERE session_id = ? ORDER BY id").all("s1") as Array<{
        id: string;
        deleted: number;
      }>
    ).map((r) => ({ id: r.id, deleted: r.deleted })); // plain objects: node:sqlite rows have a null prototype
    assert.deepEqual(entries, [
      { id: "first", deleted: 1 },
      { id: "second", deleted: 0 },
    ]);
  });

  test("similarity suppression: a near-duplicate reminder to a very recent one degrades to silence", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"fact"}]</bank_ops>
<context_for_action grounding="req:a">
Reminder: the task requires single-digit octets in the regex.
</context_for_action>`,
      `<bank_ops>[]</bank_ops>
<context_for_action grounding="req:a">
Reminder: the task requires single-digit octets in the regex!
</context_for_action>`,
    ]);
    const first = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    const second = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    assert.ok(first.stdoutJson, "first reminder should be accepted");
    assert.equal(second.stdoutJson, null, "near-duplicate reminder should be suppressed");
    const trig = getTriggerEvent(tmp, "s1", 2);
    assert.equal(trig?.phase2_outcome, "rejected:similarity");
  });

  test("cooldown: re-citing the same entry before cooldownSteps have elapsed degrades to silence unless forced", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1", PMS_COOLDOWN_STEPS: "6" });
    const reminderFor = (n: number): string =>
      `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"fact ${n}"}]</bank_ops>
<context_for_action grounding="req:a">
Reminder: distinct observation number ${n} about an unrelated topic entirely.
</context_for_action>`;
    const model = new FakeModelAdapter([reminderFor(1), reminderFor(2), reminderFor(3)]);

    // Distinct tool_input per call so this test exercises cadence-driven
    // triggering only, not forced-near-duplicate triggering (which would
    // bypass cooldown for an unrelated reason and mask what this test
    // checks) — see the note on the cadence test above.
    const step1 = await processHookEvent(
      makePostToolUsePayload({ session_id: "s1", tool_input: { command: "echo one" } }),
      { db: tmp.db, modelAdapter: model, config: liveConfig },
    );
    assert.ok(step1.stdoutJson, "first citation of req:a should be accepted (never injected before)");

    const step2 = await processHookEvent(
      makePostToolUsePayload({ session_id: "s1", tool_input: { command: "echo two" } }),
      { db: tmp.db, modelAdapter: model, config: liveConfig },
    );
    assert.equal(step2.stdoutJson, null, "re-citing req:a 1 step later is within cooldown");
    const trig2 = getTriggerEvent(tmp, "s1", 2);
    assert.equal(trig2?.forced, 0, "this step must not itself be a forced trigger");
    assert.equal(trig2?.phase2_outcome, "rejected:cooldown");
  });

  test("cooldown is bypassed for a forced trigger (tool failure)", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1", PMS_COOLDOWN_STEPS: "6" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"fact"}]</bank_ops>
<context_for_action grounding="req:a">
Reminder: distinct observation about topic one.
</context_for_action>`,
      `<bank_ops>[]</bank_ops>
<context_for_action grounding="req:a">
Reminder: a completely different sentence about topic two entirely, unrelated wording.
</context_for_action>`,
    ]);
    await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), { db: tmp.db, modelAdapter: model, config: liveConfig });
    const failureOutcome = await processHookEvent(makePostToolUseFailurePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    assert.ok(failureOutcome.stdoutJson, "forced (failure) trigger bypasses cooldown");
  });

  test("sessions are fully isolated: one session's bank cap does not affect another's", async () => {
    const tightConfig = buildTestConfig({ PMS_MODE: "shadow", PMS_CADENCE_N: "1", PMS_BANK_CAP: "1" });
    const model = new FakeModelAdapter([
      `<bank_ops>[{"op":"save_knowledge","id":"x","content":"a"}]</bank_ops>\n<no_intervention/>`,
      `<bank_ops>[{"op":"save_knowledge","id":"x","content":"b"}]</bank_ops>\n<no_intervention/>`,
    ]);
    await processHookEvent(makePostToolUsePayload({ session_id: "session-a" }), { db: tmp.db, modelAdapter: model, config: tightConfig });
    await processHookEvent(makePostToolUsePayload({ session_id: "session-b" }), { db: tmp.db, modelAdapter: model, config: tightConfig });

    const countA = tmp.db
      .prepare("SELECT count(*) as n FROM entry WHERE session_id = ? AND deleted = 0")
      .get("session-a") as { n: number };
    const countB = tmp.db
      .prepare("SELECT count(*) as n FROM entry WHERE session_id = ? AND deleted = 0")
      .get("session-b") as { n: number };
    assert.equal(countA.n, 1);
    assert.equal(countB.n, 1);
  });

  test("latency_ms is always populated, including on the fast path", async () => {
    const model = new FakeModelAdapter();
    await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), { db: tmp.db, modelAdapter: model, config });
    const log = getInterventionLog(tmp, "s1", 1);
    assert.equal(typeof log?.latency_ms, "number");
    assert.ok((log?.latency_ms as number) >= 0);
  });
});
