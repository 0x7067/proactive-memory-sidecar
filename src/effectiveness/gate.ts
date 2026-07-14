import type { HarnessName } from "../types.js";

export interface EffectivenessSample {
  harness: HarnessName;
  modelCalls: number;
  inputTokens: number;
  reminders: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  privacyViolations: number;
  providerCallsOnPrivacySkips: number;
}

export interface EffectivenessGateResult {
  harness: HarnessName;
  passed: boolean;
  failures: string[];
  reminderRate: number;
  callsPerReminder: number | null;
  inputTokensPerReminder: number | null;
}

export const EFFECTIVENESS_THRESHOLDS = {
  minimumModelCalls: 20,
  minimumReminders: 3,
  minimumReminderRate: 0.1,
  maximumCallsPerReminder: 10,
  maximumInputTokensPerReminder: 15_000,
  maximumAverageLatencyMs: 3_000,
  maximumLatencyMs: 5_000,
} as const;

/**
 * A harness is eligible for a re-enable recommendation only when its own
 * measured sample clears every privacy, yield, token, and latency threshold.
 * A fake-adapter sample can validate this calculation but cannot authorize a
 * real-provider re-enable; operators need a consented shadow canary for that.
 */
export function evaluateEffectivenessGate(sample: EffectivenessSample): EffectivenessGateResult {
  const failures: string[] = [];
  const reminderRate = sample.modelCalls === 0 ? 0 : sample.reminders / sample.modelCalls;
  const callsPerReminder = sample.reminders === 0 ? null : sample.modelCalls / sample.reminders;
  const inputTokensPerReminder = sample.reminders === 0 ? null : sample.inputTokens / sample.reminders;

  if (sample.privacyViolations !== 0) failures.push("privacy_violations");
  if (sample.providerCallsOnPrivacySkips !== 0) failures.push("provider_calls_on_privacy_skips");
  if (sample.modelCalls < EFFECTIVENESS_THRESHOLDS.minimumModelCalls) failures.push("insufficient_sample");
  if (sample.reminders < EFFECTIVENESS_THRESHOLDS.minimumReminders) failures.push("insufficient_reminders");
  if (reminderRate < EFFECTIVENESS_THRESHOLDS.minimumReminderRate) failures.push("low_reminder_rate");
  if (callsPerReminder === null || callsPerReminder > EFFECTIVENESS_THRESHOLDS.maximumCallsPerReminder) {
    failures.push("high_calls_per_reminder");
  }
  if (inputTokensPerReminder === null || inputTokensPerReminder > EFFECTIVENESS_THRESHOLDS.maximumInputTokensPerReminder) {
    failures.push("high_input_tokens_per_reminder");
  }
  if (sample.averageLatencyMs > EFFECTIVENESS_THRESHOLDS.maximumAverageLatencyMs) failures.push("high_average_latency");
  if (sample.maxLatencyMs > EFFECTIVENESS_THRESHOLDS.maximumLatencyMs) failures.push("high_max_latency");

  return {
    harness: sample.harness,
    passed: failures.length === 0,
    failures,
    reminderRate,
    callsPerReminder,
    inputTokensPerReminder,
  };
}
