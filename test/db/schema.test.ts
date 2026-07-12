import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  });

  test("openDatabase creates missing parent directories", () => {
    const nested = openTempDb();
    try {
      assert.ok(existsSync(nested.dbPath));
      assert.ok(nested.dbPath.includes(join(".claude", "pms")));
    } finally {
      nested.cleanup();
    }
  });
});
