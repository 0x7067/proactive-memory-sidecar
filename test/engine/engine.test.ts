import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { processHookEvent } from "../../src/engine/engine.js";
import type { Config } from "../../src/config.js";
import type { Deadline } from "../../src/lib/deadline.js";
import { DeferredModelAdapter, FakeModelAdapter } from "../helpers/fake-model-adapter.js";
import { buildTestConfig, makePostToolUseFailurePayload, makePostToolUsePayload, makePreCompactPayload } from "../helpers/fixtures.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

/** A Deadline stub with a fixed remainingMs()/isExpired() answer, for deterministic tests with no real timers. */
function fixedDeadline(remainingMs: number): Deadline {
  return {
    startedAt: 0,
    deadlineAt: remainingMs,
    remainingMs: () => Math.max(0, remainingMs),
    isExpired: () => remainingMs <= 0,
  };
}

function getTriggerEvent(tmp: TempDb, sessionId: string, step: number): Record<string, unknown> | undefined {
  return tmp.db.prepare("SELECT * FROM trigger_event WHERE session_id = ? AND step = ?").get(sessionId, step);
}

function getInterventionLog(tmp: TempDb, sessionId: string, step: number): Record<string, unknown> | undefined {
  return tmp.db.prepare("SELECT * FROM intervention_log WHERE session_id = ? AND step = ?").get(sessionId, step);
}

function getEntryRow(tmp: TempDb, sessionId: string, id: string): Record<string, unknown> | undefined {
  return tmp.db.prepare("SELECT * FROM entry WHERE session_id = ? AND id = ?").get(sessionId, id);
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

  test("model adapter throwing degrades to silence and records a content-free provider outcome", async () => {
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
    assert.equal(trig?.error, "provider_error");
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

describe("engine: provider-egress privacy boundary", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = openTempDb();
  });
  afterEach(() => tmp.cleanup());

  for (const [name, command] of [
    ["denied external command", "TOKEN=do-not-store railway status"],
    ["denied nested command", "echo $(curl -H 'Authorization: Bearer do-not-store' https://example.invalid)"],
    ["ambiguous executable", "private-company-cli --secret do-not-store"],
  ] as const) {
    test(`${name} creates no prompt, makes zero adapter calls, and persists no raw command`, async () => {
      const config = buildTestConfig({ PMS_CADENCE_N: "1", PMS_MODE: "shadow" });
      const model = new FakeModelAdapter();
      let promptBuilds = 0;
      const promptBuilder = () => {
        promptBuilds += 1;
        return { system: "must not exist", user: "must not exist" };
      };

      const outcome = await processHookEvent(
        makePostToolUsePayload({ session_id: `privacy-${name}`, tool_input: { command } }),
        { db: tmp.db, modelAdapter: model, config, promptBuilder },
      );

      assert.equal(outcome.stdoutJson, null);
      assert.equal(promptBuilds, 0, "provider-bound prompt construction must not run");
      assert.equal(model.calls.length, 0, "the model adapter must not be called");

      const persisted = tmp.db.prepare(
        `SELECT input_sig, error FROM trigger_event WHERE session_id = ?`,
      ).get(`privacy-${name}`) as { input_sig: string | null; error: string | null } | undefined;
      assert.ok(persisted?.input_sig?.startsWith("sha256:"));
      assert.equal(persisted?.error, null);
      const persistedDatabase = [
        "session",
        "entry",
        "intervention_log",
        "trigger_event",
        "bank_op_log",
        "session_progress",
        "effectiveness_metric",
      ].flatMap((table) => tmp.db.prepare(`SELECT * FROM ${table}`).all());
      assert.doesNotMatch(
        JSON.stringify(persistedDatabase),
        /do-not-store|railway|curl|private-company-cli|example\.invalid/,
      );
      const metric = tmp.db.prepare(
        `SELECT skip_reason, provider_outcome, parser_outcome, guard_outcome, emitted_reminder
           FROM effectiveness_metric WHERE session_id = ?`,
      ).get(`privacy-${name}`) as Record<string, unknown> | undefined;
      assert.equal(metric?.provider_outcome, "not_called");
      assert.match(String(metric?.skip_reason), /^egress_/);
      assert.equal(metric?.parser_outcome, "not_run");
      assert.equal(metric?.guard_outcome, "not_run");
      assert.equal(metric?.emitted_reminder, 0);
    });
  }
});

describe("engine: Codex recent-trajectory regression", () => {
  let tmp: TempDb;
  beforeEach(() => {
    tmp = openTempDb();
  });
  afterEach(() => tmp.cleanup());

  test("Codex response_item messages reach prompt construction before cadence is tuned", async () => {
    const transcriptPath = join(tmp.dir, "codex-rollout.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "preserve fail-open execution" }] },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking the current implementation" }] },
      }),
    ].join("\n"));

    const model = new FakeModelAdapter();
    let observedTexts: string[] = [];
    await processHookEvent(
      makePostToolUsePayload({
        session_id: "codex-trajectory",
        harness: "codex",
        transcript_path: transcriptPath,
        tool_input: { command: "echo safe" },
      }),
      {
        db: tmp.db,
        modelAdapter: model,
        config: buildTestConfig({ PMS_CADENCE_N: "1" }),
        promptBuilder: (ctx) => {
          observedTexts = ctx.transcriptTail.map((message) => message.text);
          return { system: "system", user: "user" };
        },
      },
    );
    assert.deepEqual(observedTexts, ["preserve fail-open execution", "checking the current implementation"]);
    assert.equal(model.calls.length, 1);
    const metric = tmp.db.prepare(
      `SELECT harness, provider_outcome, parser_outcome FROM effectiveness_metric
        WHERE session_id = 'codex-trajectory' AND step = 1`,
    ).get() as Record<string, unknown> | undefined;
    assert.deepEqual({ ...metric }, { harness: "codex", provider_outcome: "success", parser_outcome: "accepted" });
  });
});

describe("engine: concurrency ordering (stale Phase 2 responses)", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = openTempDb();
  });
  afterEach(() => tmp.cleanup());

  // Regression test for: "Concurrent hook processes can run model calls out
  // of order. A slower earlier step can currently overwrite, delete, or
  // regress last_injected_step after a later step has committed."
  //
  // Step 1 is a forced trigger (PostToolUseFailure — bypasses the cooldown
  // guard) so its stale reminder isn't accidentally saved by cooldown
  // rejection alone; step 2 is a normal cadence trigger. Both are started
  // (their Phase A bookkeeping commits, in call order) before either
  // model call is settled, then step 2's ("the newer step") response is
  // settled first and step 1's ("the stale, late-arriving response")
  // second — simulating a slower earlier step whose model call finishes
  // after a later step already committed.
  test("a late response for an earlier step must not overwrite bank/status/injection state a newer step already committed", async () => {
    const liveConfig = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1" });
    const model = new DeferredModelAdapter();

    const p1 = processHookEvent(makePostToolUseFailurePayload({ session_id: "s1", tool_input: { command: "false one" } }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });
    const p2 = processHookEvent(makePostToolUsePayload({ session_id: "s1", tool_input: { command: "echo two" } }), {
      db: tmp.db,
      modelAdapter: model,
      config: liveConfig,
    });

    assert.equal(model.calls.length, 2, "both steps' Phase A bookkeeping must commit before either model call resolves");

    // Step 2 (the newer step) "answers" first.
    model.settle(
      1,
      `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"fact from step two"}]</bank_ops>
<context_for_action grounding="req:a">
Reminder: distinct observation established at step two about an unrelated topic entirely.
</context_for_action>`,
    );
    const outcome2 = await p2;

    // Step 1 (the older, forced step) "answers" late, after step 2 already committed.
    model.settle(
      0,
      `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"STALE fact from step one"}]</bank_ops>
<context_for_action grounding="req:a">
Reminder: a totally separate stale sentence about the original failure that should never surface.
</context_for_action>`,
    );
    const outcome1 = await p1;

    assert.ok(outcome2.stdoutJson, "the newer step's reminder should be accepted and emitted normally");
    assert.equal(outcome1.stdoutJson, null, "a stale, late-arriving response must never be emitted, even in live mode");

    // Final bank content/status must retain the NEWER step's values.
    const entry = getEntryRow(tmp, "s1", "req:a");
    assert.equal(entry?.content, "fact from step two", "stale step must not overwrite content a newer step already committed");
    assert.equal(entry?.updated_step, 2, "updated_step must not regress to the stale step's number");

    // Non-regressing injection bookkeeping: last_injected_step must stay at
    // the newer step (2), never regress to the stale step's number (1).
    assert.equal(entry?.last_injected_step, 2, "last_injected_step must not regress");
    assert.equal(entry?.inject_count, 1, "the stale step must not have injected a second time");

    // Truthful audit trail: the stale step is recorded as suppressed, not
    // silently dropped and not misreported as a normal silence/rejection.
    const trig1 = getTriggerEvent(tmp, "s1", 1);
    assert.equal(trig1?.phase2_outcome, "stale_superseded");
    assert.match(trig1?.error as string, /stale|supersede/i);

    const log1 = getInterventionLog(tmp, "s1", 1);
    assert.equal(log1?.decision, "silence");
    assert.equal(log1?.tokens_in, 123, "token spend is still logged truthfully even though the response was suppressed");

    // The newer step's own audit trail is unaffected.
    const trig2 = getTriggerEvent(tmp, "s1", 2);
    assert.equal(trig2?.phase2_outcome, "accepted");
    const log2 = getInterventionLog(tmp, "s1", 2);
    assert.equal(log2?.decision, "reminder");
  });
});

describe("engine: cadence counts only successful PostToolUse events", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = openTempDb();
  });
  afterEach(() => tmp.cleanup());

  // Regression test for: README states cadence is "every Nth successful
  // PostToolUse", but step_count (and therefore the cadence check) was also
  // incremented for PostToolUseFailure and PreCompact, shifting cadence.
  test("three PostToolUse, then a PreCompact, then the fourth PostToolUse is due at N=4", async () => {
    const config = buildTestConfig({ PMS_CADENCE_N: "4" });
    const model = new FakeModelAdapter([
      "<bank_ops>[]</bank_ops>\n<no_intervention/>", // PreCompact sweep (always triggers)
      "<bank_ops>[]</bank_ops>\n<no_intervention/>", // 4th successful PostToolUse
    ]);

    for (let i = 1; i <= 3; i++) {
      await processHookEvent(
        makePostToolUsePayload({ session_id: "s1", tool_input: { command: `echo step-${i}` } }),
        { db: tmp.db, modelAdapter: model, config },
      );
    }
    assert.equal(model.calls.length, 0, "the first 3 PostToolUse calls are off-cadence and must not trigger the model");

    await processHookEvent(makePreCompactPayload({ session_id: "s1" }), { db: tmp.db, modelAdapter: model, config });
    assert.equal(model.calls.length, 1, "PreCompact always triggers its own Phase 1 sweep");

    const fourthPostToolUse = await processHookEvent(
      makePostToolUsePayload({ session_id: "s1", tool_input: { command: "echo step-4" } }),
      { db: tmp.db, modelAdapter: model, config },
    );
    assert.equal(model.calls.length, 2, "the 4th successful PostToolUse call must be the cadence-due one, not shifted by the PreCompact in between");

    // trigger_event.step is the all-event chronological step (5th event overall).
    const trig = getTriggerEvent(tmp, "s1", 5);
    assert.equal(trig?.hook_event, "PostToolUse");
    assert.equal(trig?.trigger_reason, "cadence");
    assert.equal(trig?.phase2_ran, 1);
    assert.notEqual(fourthPostToolUse, undefined);
  });

  test("a PostToolUseFailure in between does not shift which PostToolUse call is the cadence-Nth one", async () => {
    const config = buildTestConfig({ PMS_CADENCE_N: "3" });
    const model = new FakeModelAdapter([
      "<bank_ops>[]</bank_ops>\n<no_intervention/>", // forced failure (always triggers)
      "<bank_ops>[]</bank_ops>\n<no_intervention/>", // 3rd successful PostToolUse
    ]);

    await processHookEvent(
      makePostToolUsePayload({ session_id: "s1", tool_input: { command: "echo one" } }),
      { db: tmp.db, modelAdapter: model, config },
    );
    await processHookEvent(makePostToolUseFailurePayload({ session_id: "s1", tool_input: { command: "false" } }), {
      db: tmp.db,
      modelAdapter: model,
      config,
    });
    assert.equal(model.calls.length, 1, "the forced failure itself triggers, independent of cadence");

    await processHookEvent(
      makePostToolUsePayload({ session_id: "s1", tool_input: { command: "echo two" } }),
      { db: tmp.db, modelAdapter: model, config },
    );
    assert.equal(model.calls.length, 1, "this is only the 2nd successful PostToolUse; must remain off-cadence");

    await processHookEvent(
      makePostToolUsePayload({ session_id: "s1", tool_input: { command: "echo three" } }),
      { db: tmp.db, modelAdapter: model, config },
    );
    assert.equal(model.calls.length, 2, "this is the 3rd successful PostToolUse and must be due");
  });
});

describe("engine: time budget / deadline propagation", () => {
  let tmp: TempDb;
  let config: Config;

  beforeEach(() => {
    tmp = openTempDb();
    config = buildTestConfig({ PMS_MODE: "live", PMS_CADENCE_N: "1" });
  });
  afterEach(() => tmp.cleanup());

  test("the model call is skipped entirely and the step fails open when the deadline is already exhausted", async () => {
    const model = new FakeModelAdapter(["<bank_ops>[]</bank_ops>\n<no_intervention/>"]);
    const outcome = await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config,
      deadline: fixedDeadline(0),
    });
    assert.equal(model.calls.length, 0, "the model must never be called once the deadline is already exhausted");
    assert.equal(outcome.stdoutJson, null);

    const log = getInterventionLog(tmp, "s1", 1);
    assert.equal(log?.decision, "silence");
    const trig = getTriggerEvent(tmp, "s1", 1);
    assert.match(trig?.error as string, /deadline|budget/i);
  });

  test("the model request's timeoutMs is clamped to the deadline's remaining budget, not the full configured model timeout", async () => {
    const configWithLongModelTimeout = buildTestConfig({
      PMS_MODE: "live",
      PMS_CADENCE_N: "1",
      PMS_MODEL_TIMEOUT_MS: "15000",
    });
    const model = new FakeModelAdapter(["<bank_ops>[]</bank_ops>\n<no_intervention/>"]);
    await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: configWithLongModelTimeout,
      deadline: fixedDeadline(250),
    });
    assert.equal(model.calls.length, 1);
    assert.equal(
      model.calls[0]?.timeoutMs,
      250,
      "the request timeout must be clamped to the deadline's remaining budget",
    );
  });

  test("without an injected deadline, the model call uses the full configured timeout (backward compatible)", async () => {
    const configWithCustomModelTimeout = buildTestConfig({
      PMS_MODE: "live",
      PMS_CADENCE_N: "1",
      PMS_MODEL_TIMEOUT_MS: "12345",
    });
    const model = new FakeModelAdapter(["<bank_ops>[]</bank_ops>\n<no_intervention/>"]);
    await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config: configWithCustomModelTimeout,
    });
    assert.equal(model.calls[0]?.timeoutMs, 12345);
  });

  test("a deadline with ample remaining budget does not shrink a shorter configured model timeout", async () => {
    const model = new FakeModelAdapter(["<bank_ops>[]</bank_ops>\n<no_intervention/>"]);
    await processHookEvent(makePostToolUsePayload({ session_id: "s1" }), {
      db: tmp.db,
      modelAdapter: model,
      config, // PMS_MODEL_TIMEOUT_MS default (15000)
      deadline: fixedDeadline(999_999),
    });
    assert.equal(model.calls[0]?.timeoutMs, config.model.timeoutMs);
  });
});
