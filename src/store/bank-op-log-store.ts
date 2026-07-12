import type { DatabaseSync } from "node:sqlite";
import type { AppliedOpResult } from "../types.js";

/** Bulk-persists the audit trail for one step's Phase 1 batch, in original sequence order. */
export function recordBankOpLog(
  db: DatabaseSync,
  sessionId: string,
  step: number,
  results: readonly AppliedOpResult[],
  nowMs: number,
): void {
  const stmt = db.prepare(
    `INSERT INTO bank_op_log (session_id, step, seq, op, entry_id, applied, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of results) {
    stmt.run(sessionId, step, r.seq, r.op, r.entryId, r.applied ? 1 : 0, r.reason, nowMs);
  }
}
