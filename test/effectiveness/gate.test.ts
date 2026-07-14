import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { evaluateEffectivenessGate } from "../../src/effectiveness/gate.js";

describe("per-harness effectiveness gates", () => {
  test("Claude audit yield/token/latency clears those thresholds when privacy invariants are separately satisfied", () => {
    const result = evaluateEffectivenessGate({
      harness: "claude",
      modelCalls: 34,
      inputTokens: 48_711,
      reminders: 10,
      averageLatencyMs: 1_620.7,
      maxLatencyMs: 3_839,
      privacyViolations: 0,
      providerCallsOnPrivacySkips: 0,
    });
    assert.equal(result.passed, true);
  });

  test("recorded Codex yield fails and cannot support a re-enable recommendation", () => {
    const result = evaluateEffectivenessGate({
      harness: "codex",
      modelCalls: 47,
      inputTokens: 63_351,
      reminders: 0,
      averageLatencyMs: 1_455.2,
      maxLatencyMs: 3_865,
      privacyViolations: 0,
      providerCallsOnPrivacySkips: 0,
    });
    assert.equal(result.passed, false);
    assert.ok(result.failures.includes("insufficient_reminders"));
    assert.ok(result.failures.includes("low_reminder_rate"));
  });

  test("any privacy violation independently blocks either harness", () => {
    const result = evaluateEffectivenessGate({
      harness: "claude",
      modelCalls: 34,
      inputTokens: 48_711,
      reminders: 10,
      averageLatencyMs: 1_620.7,
      maxLatencyMs: 3_839,
      privacyViolations: 1,
      providerCallsOnPrivacySkips: 1,
    });
    assert.equal(result.passed, false);
    assert.ok(result.failures.includes("privacy_violations"));
    assert.ok(result.failures.includes("provider_calls_on_privacy_skips"));
  });
});
