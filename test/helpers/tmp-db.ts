import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../../src/config.js";
import { openDatabase } from "../../src/db/connection.js";

export interface TempDb {
  db: DatabaseSync;
  dir: string;
  dbPath: string;
  cleanup: () => void;
}

export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pms-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function openTempDb(config: Pick<Config, "busyTimeoutMs"> = { busyTimeoutMs: 2000 }): TempDb {
  const { dir, cleanup } = makeTempDir();
  const dbPath = join(dir, ".proactive-memory", "bank.sqlite3");
  const db = openDatabase(dbPath, config);
  return {
    db,
    dir,
    dbPath,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // ignore
      }
      cleanup();
    },
  };
}
