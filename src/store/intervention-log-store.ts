import type { DatabaseSync } from "node:sqlite";
import type { InterventionDecision, InterventionLogRow } from "../types.js";

export interface RecordInterventionLogInput {
  sessionId: string;
  step: number;
  decision: InterventionDecision;
  reminder: string | null;
  entryIds: readonly string[] | null;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  shadow: boolean;
}

/** Persists exactly one decision per (session, step) — the full audit trail the brief requires. */
export function recordInterventionLog(db: DatabaseSync, input: RecordInterventionLogInput): void {
  db.prepare(
    `INSERT INTO intervention_log
       (session_id, step, decision, reminder, entry_ids, latency_ms, tokens_in, tokens_out, shadow)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    input.step,
    input.decision,
    input.reminder,
    input.entryIds ? JSON.stringify(input.entryIds) : null,
    input.latencyMs,
    input.tokensIn,
    input.tokensOut,
    input.shadow ? 1 : 0,
  );
}

/**
 * Last `limit` reminders logged for a session (any shadow state), most
 * recent first — the comparison set for trigram similarity suppression.
 * Shadow reminders are included deliberately: shadow mode is meant to
 * preview live behavior faithfully, including what would have been
 * suppressed as redundant.
 */
export function getRecentReminders(
  db: DatabaseSync,
  sessionId: string,
  limit: number,
): InterventionLogRow[] {
  return db
    .prepare(
      `SELECT * FROM intervention_log
       WHERE session_id = ? AND decision = 'reminder'
       ORDER BY step DESC
       LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as InterventionLogRow[];
}
