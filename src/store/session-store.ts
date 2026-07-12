import type { DatabaseSync } from "node:sqlite";
import type { SessionRow } from "../types.js";

export function getSession(db: DatabaseSync, sessionId: string): SessionRow | null {
  const row = db.prepare("SELECT * FROM session WHERE session_id = ?").get(sessionId);
  return (row as unknown as SessionRow | undefined) ?? null;
}

/** Get-or-create the session row. Does not touch step_count on an existing row. */
export function getOrCreateSession(
  db: DatabaseSync,
  sessionId: string,
  cwd: string,
  nowMs: number,
): SessionRow {
  const existing = getSession(db, sessionId);
  if (existing) return existing;

  db.prepare(
    `INSERT INTO session (session_id, cwd, step_count, status, created_at, updated_at)
     VALUES (?, ?, 0, '', ?, ?)
     ON CONFLICT(session_id) DO NOTHING`,
  ).run(sessionId, cwd, nowMs, nowMs);

  const row = getSession(db, sessionId);
  if (!row) {
    throw new Error(`session ${sessionId} missing immediately after insert`);
  }
  return row;
}

/** Increments step_count by 1 and returns the new value. */
export function incrementStep(db: DatabaseSync, sessionId: string, nowMs: number): number {
  db.prepare(`UPDATE session SET step_count = step_count + 1, updated_at = ? WHERE session_id = ?`).run(
    nowMs,
    sessionId,
  );
  const row = getSession(db, sessionId);
  if (!row) {
    throw new Error(`session ${sessionId} missing after incrementStep`);
  }
  return row.step_count;
}

export function updateSessionStatus(
  db: DatabaseSync,
  sessionId: string,
  status: string,
  nowMs: number,
): void {
  db.prepare(`UPDATE session SET status = ?, updated_at = ? WHERE session_id = ?`).run(
    status,
    nowMs,
    sessionId,
  );
}
