import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { canonicalizeToolInput } from "../../src/lib/canonicalize.js";
import { getOrCreateSession } from "../../src/store/session-store.js";
import { recordTriggerEvent } from "../../src/store/trigger-event-store.js";
import { isNearDuplicateToolCall } from "../../src/trigger/near-duplicate.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

describe("isNearDuplicateToolCall", () => {
  let tmp: TempDb;
  const sessionId = "s1";
  beforeEach(() => {
    tmp = openTempDb();
    getOrCreateSession(tmp.db, sessionId, "/tmp/proj", 1000);
  });
  afterEach(() => tmp.cleanup());

  function seed(step: number, toolName: string, input: unknown): void {
    recordTriggerEvent(tmp.db, {
      sessionId,
      step,
      hookEvent: "PostToolUse",
      triggerReason: "not_due",
      forced: false,
      toolName,
      inputSig: canonicalizeToolInput(input),
      ok: true,
      createdAt: 1000 + step,
    });
  }

  test("no history -> never a near-duplicate", () => {
    const sig = canonicalizeToolInput({ command: "ls" });
    assert.equal(isNearDuplicateToolCall(tmp.db, sessionId, "Bash", sig, 5, 0.85), false);
  });

  test("exact repeat of the same tool input is a near-duplicate", () => {
    seed(1, "Bash", { command: "npm test" });
    const sig = canonicalizeToolInput({ command: "npm test" });
    assert.equal(isNearDuplicateToolCall(tmp.db, sessionId, "Bash", sig, 5, 0.85), true);
  });

  test("trivially-varied repeat (e.g. changed whitespace) is still a near-duplicate", () => {
    seed(1, "Bash", { command: "npm test --watch=false" });
    const sig = canonicalizeToolInput({ command: "npm test --watch=false " }); // trailing space
    assert.equal(isNearDuplicateToolCall(tmp.db, sessionId, "Bash", sig, 5, 0.85), true);
  });

  test("substantively different input to the same tool is not a near-duplicate", () => {
    seed(1, "Bash", { command: "npm test" });
    const sig = canonicalizeToolInput({ command: "git status --porcelain" });
    assert.equal(isNearDuplicateToolCall(tmp.db, sessionId, "Bash", sig, 5, 0.85), false);
  });

  test("only compares within the same tool_name", () => {
    seed(1, "Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" });
    const sig = canonicalizeToolInput({ file_path: "/a.ts", old_string: "x", new_string: "y" });
    assert.equal(isNearDuplicateToolCall(tmp.db, sessionId, "Bash", sig, 5, 0.85), false);
  });

  test("only looks back `window` calls", () => {
    seed(1, "Bash", { command: "unique-command-one" });
    for (let i = 2; i <= 6; i++) seed(i, "Bash", { command: `filler-${i}` });
    const sig = canonicalizeToolInput({ command: "unique-command-one" });
    // window=3 should not reach back to step 1 (5 filler calls now sit in between).
    assert.equal(isNearDuplicateToolCall(tmp.db, sessionId, "Bash", sig, 3, 0.85), false);
    assert.equal(isNearDuplicateToolCall(tmp.db, sessionId, "Bash", sig, 10, 0.85), true);
  });

  test("threshold is configurable", () => {
    seed(1, "Bash", { command: "run the full test suite now" });
    const sig = canonicalizeToolInput({ command: "run a different suite entirely" });
    // Loosen the threshold enough that even a fairly different string counts.
    assert.equal(isNearDuplicateToolCall(tmp.db, sessionId, "Bash", sig, 5, 0.01), true);
  });
});
