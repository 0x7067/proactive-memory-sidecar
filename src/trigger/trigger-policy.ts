import type { HandledHookEventName, TriggerDecision } from "../types.js";

export interface TriggerPolicyInput {
  hookEvent: HandledHookEventName;
  /**
   * The durable count of successful `PostToolUse` events for this session,
   * after incrementing for this event — i.e. NOT the all-event
   * chronological step (`session.step_count`), which also advances for
   * `PostToolUseFailure` and `PreCompact` and would shift *which*
   * `PostToolUse` call lands on the cadence-Nth tick (see README "Trigger
   * policy" and `src/store/session-progress-store.ts`). Only meaningful,
   * and only read, when `hookEvent === "PostToolUse"`.
   */
  postToolUseSuccessCount: number;
  cadenceN: number;
  /** Precomputed by the caller via `isNearDuplicateToolCall` — only meaningful for PostToolUse. */
  isNearDuplicate: boolean;
}

/**
 * Pure decision function implementing the four trigger conditions from the
 * design brief:
 *
 *  1. `PreCompact` always fires, Phase 1 (bank maintenance) only.
 *  2. `PostToolUseFailure` always fires, forced (bypasses cooldown).
 *  3. A near-identical repeated `PostToolUse` call always fires, forced.
 *  4. Otherwise, `PostToolUse` fires every `cadenceN`th call ("cadence"),
 *     and is a fast-path no-op (no model call) the rest of the time.
 *
 * Order matters only in that PreCompact and forced-failure are structural
 * facts about the hook event itself and are checked first; near-duplicate
 * and cadence are both properties of a plain PostToolUse call and are
 * mutually exclusive by construction (near-duplicate is checked first, so
 * a call that is both a cadence multiple *and* a near-duplicate is still
 * correctly reported as forced).
 */
export function decideTrigger(input: TriggerPolicyInput): TriggerDecision {
  if (input.hookEvent === "PreCompact") {
    return { triggered: true, forced: true, reason: "precompact_sweep", phase2Eligible: false };
  }

  if (input.hookEvent === "PostToolUseFailure") {
    return { triggered: true, forced: true, reason: "forced_failure", phase2Eligible: true };
  }

  // PostToolUse
  if (input.isNearDuplicate) {
    return { triggered: true, forced: true, reason: "forced_near_duplicate", phase2Eligible: true };
  }

  if (input.cadenceN > 0 && input.postToolUseSuccessCount % input.cadenceN === 0) {
    return { triggered: true, forced: false, reason: "cadence", phase2Eligible: true };
  }

  return { triggered: false, forced: false, reason: "not_due", phase2Eligible: true };
}
