import type { DatabaseSync } from "node:sqlite";

export interface SessionProgress {
  /** Highest step whose Phase B has actually committed for this session — the concurrency watermark. */
  committedStep: number;
  /** Durable count of successful PostToolUse events only — the true cadence counter. */
  postToolUseSuccessCount: number;
}

const DEFAULTS: SessionProgress = { committedStep: 0, postToolUseSuccessCount: 0 };

function ensureRow(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    `INSERT INTO session_progress (session_id, committed_step, post_tool_use_success_count)
     VALUES (?, 0, 0)
     ON CONFLICT(session_id) DO NOTHING`,
  ).run(sessionId);
}

/** Reads the current progress row, defaulting to zeros for a session that hasn't reached Phase B/a PostToolUse yet. */
export function getSessionProgress(db: DatabaseSync, sessionId: string): SessionProgress {
  const row = db
    .prepare(`SELECT committed_step, post_tool_use_success_count FROM session_progress WHERE session_id = ?`)
    .get(sessionId) as { committed_step: number; post_tool_use_success_count: number } | undefined;
  if (!row) return { ...DEFAULTS };
  return { committedStep: row.committed_step, postToolUseSuccessCount: row.post_tool_use_success_count };
}

/**
 * Monotonically advances the durable Phase-B commit watermark for a
 * session — never regresses it, even if called with a smaller `step` than
 * what's already recorded (callers are expected to check
 * `getSessionProgress` first and skip applying a stale step entirely, but
 * this is belt-and-braces: the watermark itself can only ever move
 * forward).
 */
export function advanceCommittedStep(db: DatabaseSync, sessionId: string, step: number): void {
  ensureRow(db, sessionId);
  db.prepare(`UPDATE session_progress SET committed_step = MAX(committed_step, ?) WHERE session_id = ?`).run(
    step,
    sessionId,
  );
}

/**
 * Increments and returns the durable count of successful PostToolUse
 * events for a session. Callers must invoke this ONLY for
 * `hook_event_name === "PostToolUse"` — PostToolUseFailure and PreCompact
 * must never advance it (that is the entire point: keeping the
 * cadence-Nth calculation immune to non-PostToolUse event types).
 */
export function incrementPostToolUseSuccessCount(db: DatabaseSync, sessionId: string): number {
  ensureRow(db, sessionId);
  db.prepare(
    `UPDATE session_progress SET post_tool_use_success_count = post_tool_use_success_count + 1 WHERE session_id = ?`,
  ).run(sessionId);
  const row = db
    .prepare(`SELECT post_tool_use_success_count FROM session_progress WHERE session_id = ?`)
    .get(sessionId) as { post_tool_use_success_count: number };
  return row.post_tool_use_success_count;
}
