import type { DatabaseSync } from "node:sqlite";
import type { EffectivenessMetricRow, HarnessName, TriggerReason } from "../types.js";

export interface RecordEffectivenessMetricInput {
  sessionId: string;
  step: number;
  harness: HarnessName;
  triggerReason: TriggerReason;
  skipReason: string;
  providerOutcome: string;
  parserOutcome: string;
  guardOutcome: string;
  bankOperation: string;
  bankOpsTotal: number;
  bankOpsApplied: number;
  bankOpsRejected: number;
  emittedReminder: boolean;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: number;
}

export function recordEffectivenessMetric(db: DatabaseSync, input: RecordEffectivenessMetricInput): void {
  db.prepare(
    `INSERT INTO effectiveness_metric
       (session_id, step, harness, trigger_reason, skip_reason, provider_outcome,
        parser_outcome, guard_outcome, bank_operation, bank_ops_total,
        bank_ops_applied, bank_ops_rejected, emitted_reminder, latency_ms,
        tokens_in, tokens_out, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    input.step,
    input.harness,
    input.triggerReason,
    input.skipReason,
    input.providerOutcome,
    input.parserOutcome,
    input.guardOutcome,
    input.bankOperation,
    input.bankOpsTotal,
    input.bankOpsApplied,
    input.bankOpsRejected,
    input.emittedReminder ? 1 : 0,
    input.latencyMs,
    input.tokensIn,
    input.tokensOut,
    input.createdAt,
  );
}

export function getEffectivenessMetric(
  db: DatabaseSync,
  sessionId: string,
  step: number,
): EffectivenessMetricRow | null {
  return (db.prepare(
    `SELECT * FROM effectiveness_metric WHERE session_id = ? AND step = ?`,
  ).get(sessionId, step) as EffectivenessMetricRow | undefined) ?? null;
}
