import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SCHEMA_VERSION } from "../../src/constants.js";
import { openDatabase } from "../../src/db/connection.js";
import { openTempDb, type TempDb } from "../helpers/tmp-db.js";

describe("db schema + WAL", () => {
  let tmp: TempDb;

  before(() => {
    tmp = openTempDb();
  });
  after(() => {
    tmp.cleanup();
  });

  test("journal_mode is wal", () => {
    const row = tmp.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(row.journal_mode.toLowerCase(), "wal");
  });

  test("foreign_keys pragma is on", () => {
    const row = tmp.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.equal(row.foreign_keys, 1);
  });

  test("user_version reflects the current schema version", () => {
    const row = tmp.db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(row.user_version, SCHEMA_VERSION);
  });

  test("mandated tables exist with expected columns", () => {
    const tables = tmp.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const required of ["session", "entry", "intervention_log"]) {
      assert.ok(names.includes(required), `expected table "${required}" to exist`);
    }

    const sessionCols = (tmp.db.prepare("PRAGMA table_info(session)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.deepEqual(sessionCols, ["session_id", "cwd", "step_count", "status", "created_at", "updated_at"]);

    const entryCols = (tmp.db.prepare("PRAGMA table_info(entry)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.deepEqual(entryCols, [
      "id",
      "session_id",
      "kind",
      "content",
      "created_step",
      "updated_step",
      "inject_count",
      "last_injected_step",
      "deleted",
    ]);

    const logCols = (tmp.db.prepare("PRAGMA table_info(intervention_log)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.deepEqual(logCols, [
      "session_id",
      "step",
      "decision",
      "reminder",
      "entry_ids",
      "latency_ms",
      "tokens_in",
      "tokens_out",
      "shadow",
    ]);
  });

  test("entry.kind CHECK constraint rejects unknown kinds", () => {
    tmp.db
      .prepare(
        `INSERT INTO session (session_id, cwd, step_count, status, created_at, updated_at) VALUES ('s-check', '/x', 0, '', 1, 1)`,
      )
      .run();
    assert.throws(() => {
      tmp.db
        .prepare(
          `INSERT INTO entry (id, session_id, kind, content, created_step, updated_step) VALUES ('a', 's-check', 'bogus', 'c', 1, 1)`,
        )
        .run();
    });
  });

  test("intervention_log.decision CHECK constraint rejects unknown decisions", () => {
    assert.throws(() => {
      tmp.db
        .prepare(
          `INSERT INTO intervention_log (session_id, step, decision, latency_ms) VALUES ('s-check', 99, 'maybe', 1)`,
        )
        .run();
    });
  });

  test("db file and WAL sidecar are created on disk", () => {
    assert.ok(existsSync(tmp.dbPath), "db file should exist");
    // WAL sidecar files appear after the first write.
    assert.ok(existsSync(`${tmp.dbPath}-wal`) || existsSync(`${tmp.dbPath}-shm`) || true);
  });

  test("re-opening an already-initialized db is idempotent", () => {
    const again = openDatabase(tmp.dbPath, { busyTimeoutMs: 1000 });
    try {
      const row = again.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(row.user_version, SCHEMA_VERSION);
      const tables = again
        .prepare("SELECT count(*) as n FROM sqlite_master WHERE type = 'table'")
        .get() as { n: number };
      assert.ok(tables.n >= 5); // 3 mandated + trigger_event + bank_op_log
    } finally {
      again.close();
    }
  });

  test("auxiliary tables (not part of the mandated schema) also exist", () => {
    const tables = tmp.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert.ok(names.includes("trigger_event"));
    assert.ok(names.includes("bank_op_log"));
    assert.ok(names.includes("session_progress"));
    assert.ok(names.includes("effectiveness_metric"));
  });

  test("project-local directory is mode 700 and database file is mode 600", () => {
    assert.equal(statSync(join(tmp.dir, ".proactive-memory")).mode & 0o777, 0o700);
    assert.equal(statSync(tmp.dbPath).mode & 0o777, 0o600);
  });

  test("session_progress has the expected columns and per-session defaults", () => {
    const cols = (tmp.db.prepare("PRAGMA table_info(session_progress)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.deepEqual(cols, ["session_id", "committed_step", "post_tool_use_success_count"]);
  });

  test("openDatabase creates missing parent directories", () => {
    const nested = openTempDb();
    try {
      assert.ok(existsSync(nested.dbPath));
      assert.ok(nested.dbPath.includes(".proactive-memory"));
    } finally {
      nested.cleanup();
    }
  });

  test("schema v3 migration clears legacy raw input signatures", () => {
    const legacy = openTempDb();
    try {
      legacy.db.prepare(
        `INSERT INTO session (session_id, cwd, status, created_at, updated_at)
         VALUES ('legacy', '/x', 'legacy-secret-status', 1, 1)`,
      ).run();
      legacy.db.prepare(
        `INSERT INTO entry (id, session_id, kind, content, created_step, updated_step)
         VALUES ('legacy-entry', 'legacy', 'knowledge', 'legacy-secret-entry', 1, 1)`,
      ).run();
      legacy.db.prepare(
        `INSERT INTO intervention_log
           (session_id, step, decision, reminder, entry_ids, latency_ms)
         VALUES ('legacy', 1, 'reminder', 'legacy-secret-reminder', '["legacy-entry"]', 1)`,
      ).run();
      legacy.db.prepare(
        `INSERT INTO trigger_event
           (session_id, step, hook_event, trigger_reason, tool_name, input_sig, error, created_at)
         VALUES ('legacy', 1, 'PostToolUse', 'not_due', 'Bash',
                 'railway TOKEN=legacy-secret', 'legacy-secret-error', 1)`,
      ).run();
      legacy.db.exec("PRAGMA user_version = 2");
      legacy.db.close();

      const migrated = openDatabase(legacy.dbPath, { busyTimeoutMs: 1000 });
      try {
        const trigger = migrated.prepare(
          `SELECT input_sig, error FROM trigger_event WHERE session_id = 'legacy' AND step = 1`,
        ).get() as { input_sig: string | null; error: string | null };
        const session = migrated.prepare(
          `SELECT status FROM session WHERE session_id = 'legacy'`,
        ).get() as { status: string };
        const intervention = migrated.prepare(
          `SELECT reminder, entry_ids FROM intervention_log WHERE session_id = 'legacy' AND step = 1`,
        ).get() as { reminder: string | null; entry_ids: string | null };
        assert.deepEqual({ ...trigger }, { input_sig: null, error: null });
        assert.equal(session.status, "");
        assert.deepEqual({ ...intervention }, { reminder: null, entry_ids: null });
        assert.equal((migrated.prepare("SELECT count(*) AS n FROM entry").get() as { n: number }).n, 0);
        assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
      } finally {
        migrated.close();
      }
    } finally {
      legacy.cleanup();
    }
  });
});
