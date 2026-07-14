import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import { initializeSchema } from "./schema.js";

/**
 * Opens (creating if necessary) the project-local SQLite database at
 * `dbPath`, applies pragmas, and ensures the schema is initialized/migrated.
 *
 * Pragmas:
 *  - `journal_mode = WAL`: readers never block the writer and vice versa;
 *    required by the brief and the right default for a sidecar that must
 *    never add latency to the action agent's own tool calls.
 *  - `synchronous = NORMAL`: the standard WAL pairing — durable across
 *    application crashes, relies on the OS for crash-durability of the most
 *    recent commit in the (rare, catastrophic) case of an OS-level crash.
 *    A sidecar with an ephemeral bank does not need `FULL`'s extra fsync.
 *  - `busy_timeout`: makes SQLite retry internally (instead of raising
 *    SQLITE_BUSY immediately) when another process/hook invocation holds
 *    the write lock — Claude Code can fire PostToolUse for several tools in
 *    one parallel batch concurrently, so this is a real, expected scenario,
 *    not just a hedge.
 *  - `foreign_keys = ON`: SQLite disables FK enforcement per-connection by
 *    default; the mandated schema declares `entry.session_id REFERENCES
 *    session(session_id)`, so we turn enforcement on to honor it.
 */
export function openDatabase(dbPath: string, config: Pick<Config, "busyTimeoutMs">): DatabaseSync {
  const dbDirectory = dirname(dbPath);
  mkdirSync(dbDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dbDirectory, 0o700);

  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${config.busyTimeoutMs}`);
  db.exec("PRAGMA foreign_keys = ON");

  initializeSchema(db);
  chmodSync(dbPath, 0o600);

  return db;
}
