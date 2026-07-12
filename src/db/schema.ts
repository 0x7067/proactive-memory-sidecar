import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "../constants.js";

/**
 * The three tables below are the exact schema mandated by the design brief
 * — table names, column names, types, defaults, and constraints are
 * reproduced verbatim. Everything after them (`trigger_event`,
 * `bank_op_log`) is additive bookkeeping this project needs for trigger
 * provenance and Phase-1 op auditing; it never changes the shape or
 * semantics of the mandated tables and nothing mandated depends on it.
 */
const MANDATED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session (
  session_id   TEXT PRIMARY KEY,
  cwd          TEXT NOT NULL,
  step_count   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entry (
  id           TEXT NOT NULL,
  session_id   TEXT NOT NULL REFERENCES session(session_id),
  kind         TEXT NOT NULL CHECK (kind IN ('knowledge','procedural')),
  content      TEXT NOT NULL,
  created_step INTEGER NOT NULL,
  updated_step INTEGER NOT NULL,
  inject_count INTEGER NOT NULL DEFAULT 0,
  last_injected_step INTEGER,
  deleted      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, id)
);

CREATE TABLE IF NOT EXISTS intervention_log (
  session_id   TEXT NOT NULL,
  step         INTEGER NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('silence','reminder')),
  reminder     TEXT,
  entry_ids    TEXT,
  latency_ms   INTEGER NOT NULL,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  shadow       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, step)
);
`;

/**
 * Auxiliary tables (not part of the mandated schema). `trigger_event`
 * records, once per engine invocation ("step"), which hook fired and why
 * the trigger policy did or didn't run the model — the audit trail that
 * lets the near-duplicate-call and cadence heuristics look backwards, and
 * lets operators distinguish "silence because not due" from "silence
 * because a guard rejected a candidate reminder" (see README "Metrics and
 * queries"). `bank_op_log` records the accept/reject outcome of every
 * individual Phase 1 BankOp for the same reason.
 */
const AUXILIARY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trigger_event (
  session_id     TEXT NOT NULL,
  step           INTEGER NOT NULL,
  hook_event     TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  forced         INTEGER NOT NULL DEFAULT 0,
  tool_name      TEXT,
  input_sig      TEXT,
  ok             INTEGER,
  phase2_ran     INTEGER NOT NULL DEFAULT 0,
  phase2_outcome TEXT NOT NULL DEFAULT 'not_applicable',
  error          TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, step)
);

CREATE TABLE IF NOT EXISTS bank_op_log (
  session_id  TEXT NOT NULL,
  step        INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  op          TEXT NOT NULL,
  entry_id    TEXT,
  applied     INTEGER NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, step, seq)
);

CREATE INDEX IF NOT EXISTS idx_entry_session_live
  ON entry(session_id, deleted);

CREATE INDEX IF NOT EXISTS idx_trigger_event_session_tool
  ON trigger_event(session_id, tool_name, step DESC);

CREATE INDEX IF NOT EXISTS idx_intervention_log_session_decision
  ON intervention_log(session_id, decision, step DESC);
`;

/**
 * Idempotent schema initialization + forward-only migration runner, gated
 * on `PRAGMA user_version`. Safe to call on every connection open: a
 * database already at `SCHEMA_VERSION` does no writes beyond the pragma
 * reads. `CREATE TABLE/INDEX IF NOT EXISTS` is deliberate belt-and-braces
 * in case a prior process crashed mid-migration before the version pragma
 * was updated.
 */
export function initializeSchema(db: DatabaseSync): void {
  const currentVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;

  if (currentVersion >= SCHEMA_VERSION) {
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Version 1: initial schema (mandated + auxiliary tables). Future
    // schema changes should append `if (currentVersion < N) { ... }`
    // blocks here rather than editing the SQL above in place.
    if (currentVersion < 1) {
      db.exec(MANDATED_SCHEMA_SQL);
      db.exec(AUXILIARY_SCHEMA_SQL);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
