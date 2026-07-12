import type { DatabaseSync } from "node:sqlite";
import type { HandledHookEventName, Phase2Outcome, TriggerEventRow, TriggerReason } from "../types.js";

export interface RecordTriggerEventInput {
  sessionId: string;
  step: number;
  hookEvent: HandledHookEventName;
  triggerReason: TriggerReason;
  forced: boolean;
  toolName: string | null;
  inputSig: string | null;
  ok: boolean | null;
  createdAt: number;
}

/** Inserts the provenance row for a step. Call once, before Phase 2 is known; update afterwards. */
export function recordTriggerEvent(db: DatabaseSync, input: RecordTriggerEventInput): void {
  db.prepare(
    `INSERT INTO trigger_event
       (session_id, step, hook_event, trigger_reason, forced, tool_name, input_sig, ok, phase2_ran, phase2_outcome, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'not_applicable', NULL, ?)`,
  ).run(
    input.sessionId,
    input.step,
    input.hookEvent,
    input.triggerReason,
    input.forced ? 1 : 0,
    input.toolName,
    input.inputSig,
    input.ok === null ? null : input.ok ? 1 : 0,
    input.createdAt,
  );
}

export function finalizeTriggerEvent(
  db: DatabaseSync,
  sessionId: string,
  step: number,
  fields: { phase2Ran: boolean; phase2Outcome: Phase2Outcome; error: string | null },
): void {
  db.prepare(
    `UPDATE trigger_event SET phase2_ran = ?, phase2_outcome = ?, error = ? WHERE session_id = ? AND step = ?`,
  ).run(fields.phase2Ran ? 1 : 0, fields.phase2Outcome, fields.error, sessionId, step);
}

/**
 * Most recent prior calls to `toolName` in this session, most recent first
 * — the comparison set for near-identical-repeated-call detection.
 *
 * Callers MUST query this before calling `recordTriggerEvent` for the
 * current step: the current step's row does not exist yet at query time,
 * so "most recent N rows" is naturally "the N calls before this one" with
 * no explicit step filter required. Calling it after `recordTriggerEvent`
 * for the same step would include the current (not-yet-decided) call in
 * its own comparison set.
 */
export function getRecentToolCalls(
  db: DatabaseSync,
  sessionId: string,
  toolName: string,
  limit: number,
): TriggerEventRow[] {
  return db
    .prepare(
      `SELECT * FROM trigger_event
       WHERE session_id = ? AND tool_name = ?
       ORDER BY step DESC
       LIMIT ?`,
    )
    .all(sessionId, toolName, limit) as unknown as TriggerEventRow[];
}
