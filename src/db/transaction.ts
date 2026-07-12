import type { DatabaseSync } from "node:sqlite";

/**
 * Runs `fn` inside a synchronous `BEGIN IMMEDIATE` / `COMMIT` transaction,
 * rolling back on any thrown error and re-throwing it to the caller. `fn`
 * must be synchronous — `node:sqlite`'s `DatabaseSync` has no notion of a
 * connection borrowed across an `await`, so holding a transaction open
 * across an async boundary (e.g. the model call) is a programming error
 * this signature makes structurally impossible.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Connection may already be broken; nothing more we can do here.
    }
    throw err;
  }
}
