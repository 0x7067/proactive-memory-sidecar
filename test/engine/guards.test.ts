import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  checkCooldown,
  checkFactualProse,
  checkGrounding,
  checkNoWallClockTime,
  checkSimilarity,
  checkTokenCap,
  evaluateReminderGuards,
  type GuardContext,
  type ReminderCandidate,
} from "../../src/engine/guards.js";
import type { EntryRow } from "../../src/types.js";

function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: "req:a",
    session_id: "s1",
    kind: "knowledge",
    content: "fact",
    created_step: 1,
    updated_step: 1,
    inject_count: 0,
    last_injected_step: null,
    deleted: 0,
    ...overrides,
  };
}

function baseCtx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    step: 20,
    forced: false,
    maxTokens: 100,
    cooldownSteps: 6,
    similarityThreshold: 0.85,
    liveEntryIds: new Set(["req:a", "proc:b"]),
    entriesById: new Map([
      ["req:a", makeEntry({ id: "req:a" })],
      ["proc:b", makeEntry({ id: "proc:b", kind: "procedural" })],
    ]),
    recentReminderTexts: [],
    ...overrides,
  };
}

const PAPER_EXAMPLE =
  'Reminder: the task requires single-digit IPv4 octets to match; the current regex was already observed failing on "1.2.3.4" at step 14.';

describe("guard: grounding", () => {
  test("accepts when grounding ids are non-empty and all exist", () => {
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["req:a"] };
    assert.equal(checkGrounding(candidate, baseCtx()), null);
  });

  test("rejects empty grounding list", () => {
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: [] };
    const failure = checkGrounding(candidate, baseCtx());
    assert.equal(failure?.guard, "grounding");
  });

  test("rejects when a cited id does not exist in the (prospective) bank", () => {
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["req:a", "nonexistent"] };
    const failure = checkGrounding(candidate, baseCtx());
    assert.equal(failure?.guard, "grounding");
    assert.match(failure?.reason ?? "", /nonexistent/);
  });

  test("accepts an id that was only just created by this step's own Phase 1 ops (prospective bank)", () => {
    const ctx = baseCtx({ liveEntryIds: new Set(["brand-new-this-step"]) });
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["brand-new-this-step"] };
    assert.equal(checkGrounding(candidate, ctx), null);
  });
});

describe("guard: token cap", () => {
  test("accepts short factual text", () => {
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["req:a"] };
    assert.equal(checkTokenCap(candidate, baseCtx()), null);
  });

  test("rejects text over the configured cap", () => {
    const longText = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    const candidate: ReminderCandidate = { text: longText, groundingIds: ["req:a"] };
    const failure = checkTokenCap(candidate, baseCtx());
    assert.equal(failure?.guard, "token_cap");
  });

  test("respects a custom maxTokens from context", () => {
    const candidate: ReminderCandidate = { text: "one two three four five", groundingIds: ["req:a"] };
    const failure = checkTokenCap(candidate, baseCtx({ maxTokens: 3 }));
    assert.equal(failure?.guard, "token_cap");
  });
});

describe("guard: no wall-clock time (replay safety)", () => {
  test("accepts step-relative references", () => {
    assert.equal(checkNoWallClockTime({ text: PAPER_EXAMPLE, groundingIds: [] }), null);
  });

  test("rejects ISO date", () => {
    const failure = checkNoWallClockTime({
      text: "Reminder: the deploy happened on 2026-07-12.",
      groundingIds: [],
    });
    assert.equal(failure?.guard, "no_wallclock_time");
  });

  test("rejects ISO datetime", () => {
    const failure = checkNoWallClockTime({
      text: "Reminder: the build finished at 2026-07-12T14:30.",
      groundingIds: [],
    });
    assert.equal(failure?.guard, "no_wallclock_time");
  });

  test("rejects clock time with am/pm", () => {
    const failure = checkNoWallClockTime({ text: "Reminder: it failed at 3:45pm.", groundingIds: [] });
    assert.equal(failure?.guard, "no_wallclock_time");
  });

  test("rejects 'right now' / 'just now' phrasing", () => {
    assert.equal(checkNoWallClockTime({ text: "Reminder: this is happening right now.", groundingIds: [] })?.guard, "no_wallclock_time");
    assert.equal(checkNoWallClockTime({ text: "Reminder: this just happened just now.", groundingIds: [] })?.guard, "no_wallclock_time");
  });

  test("rejects slash-style dates", () => {
    const failure = checkNoWallClockTime({ text: "Reminder: as of 7/12/2026 this was true.", groundingIds: [] });
    assert.equal(failure?.guard, "no_wallclock_time");
  });

  test("does not false-positive on plain step numbers or version-like numbers", () => {
    const text = "Reminder: this was observed failing at step 14 while on attempt 3 of 4.";
    assert.equal(checkNoWallClockTime({ text, groundingIds: [] }), null);
  });
});

describe("guard: factual prose (no imperative/advisory phrasing)", () => {
  test("accepts the paper's own factual example", () => {
    assert.equal(checkFactualProse({ text: PAPER_EXAMPLE, groundingIds: [] }), null);
  });

  test("accepts purely descriptive past-tense observations", () => {
    const text = "Reminder: the previous attempt to parse the config file failed with a syntax error at line 12.";
    assert.equal(checkFactualProse({ text, groundingIds: [] }), null);
  });

  test("rejects sentence-initial imperative verb", () => {
    const failure = checkFactualProse({
      text: "Fix the regex so it only matches single-digit octets.",
      groundingIds: [],
    });
    assert.equal(failure?.guard, "factual_prose");
  });

  test("rejects 'you should' advice", () => {
    const failure = checkFactualProse({ text: "Reminder: you should double-check the regex.", groundingIds: [] });
    assert.equal(failure?.guard, "factual_prose");
  });

  test("rejects passive-voice advice using a bare modal marker ('should') without a pronoun", () => {
    const failure = checkFactualProse({
      text: "Reminder: the regex should be updated to reject multi-digit octets.",
      groundingIds: [],
    });
    assert.equal(failure?.guard, "factual_prose");
  });

  test("rejects 'make sure to' / 'try to' / 'please'", () => {
    assert.equal(checkFactualProse({ text: "Make sure to run the tests.", groundingIds: [] })?.guard, "factual_prose");
    assert.equal(checkFactualProse({ text: "Try to use a different regex.", groundingIds: [] })?.guard, "factual_prose");
    assert.equal(checkFactualProse({ text: "Please check the config.", groundingIds: [] })?.guard, "factual_prose");
  });

  test("does not false-positive on 'requires' as a descriptive verb", () => {
    const text = "Reminder: the task requires single-digit octets and the config requires valid JSON.";
    assert.equal(checkFactualProse({ text, groundingIds: [] }), null);
  });
});

describe("guard: cooldown", () => {
  test("accepts an entry that has never been injected", () => {
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["req:a"] };
    assert.equal(checkCooldown(candidate, baseCtx()), null);
  });

  test("rejects when a cited entry was injected fewer than cooldownSteps ago and not forced", () => {
    const ctx = baseCtx({
      step: 20,
      forced: false,
      cooldownSteps: 6,
      entriesById: new Map([["req:a", makeEntry({ last_injected_step: 17 })]]), // 3 steps ago
    });
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["req:a"] };
    const failure = checkCooldown(candidate, ctx);
    assert.equal(failure?.guard, "cooldown");
  });

  test("accepts once cooldownSteps have elapsed", () => {
    const ctx = baseCtx({
      step: 23,
      forced: false,
      cooldownSteps: 6,
      entriesById: new Map([["req:a", makeEntry({ last_injected_step: 17 })]]), // exactly 6 steps ago
    });
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["req:a"] };
    assert.equal(checkCooldown(candidate, ctx), null);
  });

  test("forced bypasses cooldown even for a just-injected entry", () => {
    const ctx = baseCtx({
      step: 18,
      forced: true,
      cooldownSteps: 6,
      entriesById: new Map([["req:a", makeEntry({ last_injected_step: 17 })]]), // 1 step ago
    });
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["req:a"] };
    assert.equal(checkCooldown(candidate, ctx), null);
  });
});

describe("guard: similarity", () => {
  test("accepts when no recent reminders are similar", () => {
    const ctx = baseCtx({ recentReminderTexts: ["Reminder: totally unrelated fact about ports."] });
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["req:a"] };
    assert.equal(checkSimilarity(candidate, ctx), null);
  });

  test("rejects a near-duplicate of a recent reminder, forced or not", () => {
    const ctx = baseCtx({ forced: true, recentReminderTexts: [PAPER_EXAMPLE] });
    const candidate: ReminderCandidate = {
      text: PAPER_EXAMPLE.replace("1.2.3.4", "1.2.3.4!"), // trivial variant
      groundingIds: ["req:a"],
    };
    const failure = checkSimilarity(candidate, ctx);
    assert.equal(failure?.guard, "similarity");
  });
});

describe("evaluateReminderGuards: orchestration", () => {
  test("accepts a fully valid candidate", () => {
    const candidate: ReminderCandidate = { text: PAPER_EXAMPLE, groundingIds: ["req:a", "proc:b"] };
    const result = evaluateReminderGuards(candidate, baseCtx());
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.text, PAPER_EXAMPLE);
      assert.deepEqual(result.groundingIds, ["req:a", "proc:b"]);
    }
  });

  test("short-circuits on the first failing guard (grounding before token cap)", () => {
    const longText = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    const candidate: ReminderCandidate = { text: longText, groundingIds: [] }; // fails both grounding and token cap
    const result = evaluateReminderGuards(candidate, baseCtx());
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.failure.guard, "grounding");
    }
  });

  test("a candidate that passes every mechanical guard is accepted verbatim (no rewriting)", () => {
    const text = "Reminder: the previous approach to parsing failed with an unexpected token at step 9.";
    const candidate: ReminderCandidate = { text, groundingIds: ["req:a"] };
    const result = evaluateReminderGuards(candidate, baseCtx());
    assert.equal(result.accepted, true);
  });
});
