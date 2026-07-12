import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "../lib/type-guards.js";
import type { AppliedOpResult, EntryKind, EntryRow, ParsedOpEntry } from "../types.js";
import { updateSessionStatus } from "./session-store.js";

export function getLiveEntryCount(db: DatabaseSync, sessionId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM entry WHERE session_id = ? AND deleted = 0`)
    .get(sessionId) as { n: number };
  return row.n;
}

export function getEntry(db: DatabaseSync, sessionId: string, id: string): EntryRow | null {
  const row = db
    .prepare(`SELECT * FROM entry WHERE session_id = ? AND id = ?`)
    .get(sessionId, id);
  return (row as unknown as EntryRow | undefined) ?? null;
}

/** All live (non-deleted) entries, oldest-created first — the order used to build model prompts. */
export function listLiveEntries(db: DatabaseSync, sessionId: string): EntryRow[] {
  return db
    .prepare(
      `SELECT * FROM entry WHERE session_id = ? AND deleted = 0 ORDER BY created_step ASC, id ASC`,
    )
    .all(sessionId) as unknown as EntryRow[];
}

/** Ids of all live entries — the prospective-bank existence check the grounding guard validates against. */
export function getLiveEntryIdSet(db: DatabaseSync, sessionId: string): Set<string> {
  const rows = db
    .prepare(`SELECT id FROM entry WHERE session_id = ? AND deleted = 0`)
    .all(sessionId) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Fetch specific entries by id (any deleted state) — used by the grounding/cooldown guards. */
export function getEntriesByIds(
  db: DatabaseSync,
  sessionId: string,
  ids: readonly string[],
): Map<string, EntryRow> {
  const result = new Map<string, EntryRow>();
  for (const id of ids) {
    const row = getEntry(db, sessionId, id);
    if (row) result.set(id, row);
  }
  return result;
}

/**
 * Applies an ordered batch of Phase 1 operations against the bank, enforcing
 * the 60-live-entry cap (configurable) with the following precise, tested
 * semantics:
 *
 *  - `update_status` never touches entry rows or the live count.
 *  - `delete` soft-deletes (sets `deleted = 1`) a currently-live row and
 *    frees one unit of capacity. Deleting an already-deleted or unknown id
 *    is a no-op (rejected, logged, does not change count).
 *  - `save_knowledge` / `save_procedural` targeting an id that is *already
 *    live* is a pure upsert (content/kind updated in place) and never
 *    changes the live count, regardless of how close to the cap the
 *    session is.
 *  - `save_knowledge` / `save_procedural` targeting a *new* id, or an id
 *    that is currently soft-deleted (a "revive"), consumes one unit of
 *    capacity. It is accepted only if the running live count — which
 *    reflects every op already applied earlier in this same ordered batch —
 *    is currently below `cap`. Ops are never reordered or given lookahead:
 *    a save that would only fit after a *later* delete in the same batch is
 *    rejected, because the delete has not been applied yet at the point the
 *    save is evaluated.
 *
 * Every attempted op (valid or structurally invalid) produces exactly one
 * `AppliedOpResult`, in original order, for the caller to persist as an
 * audit trail.
 */
export function applyBankOps(
  db: DatabaseSync,
  sessionId: string,
  step: number,
  opEntries: readonly ParsedOpEntry[],
  cap: number,
  nowMs: number,
): AppliedOpResult[] {
  let liveCount = getLiveEntryCount(db, sessionId);
  const results: AppliedOpResult[] = [];

  opEntries.forEach((entry, index) => {
    const seq = index + 1;

    if (!entry.valid) {
      const raw = entry.raw;
      const opLabel = isRecord(raw) && typeof raw.op === "string" ? raw.op : "unknown";
      const entryId = isRecord(raw) && typeof raw.id === "string" ? raw.id : null;
      results.push({ seq, op: opLabel, entryId, applied: false, reason: entry.reason });
      return;
    }

    const op = entry.op;

    if (op.op === "update_status") {
      updateSessionStatus(db, sessionId, op.status, nowMs);
      results.push({ seq, op: op.op, entryId: null, applied: true, reason: null });
      return;
    }

    if (op.op === "delete") {
      const existing = getEntry(db, sessionId, op.id);
      if (!existing || existing.deleted === 1) {
        results.push({
          seq,
          op: op.op,
          entryId: op.id,
          applied: false,
          reason: "not_found_or_already_deleted",
        });
        return;
      }
      db.prepare(`UPDATE entry SET deleted = 1, updated_step = ? WHERE session_id = ? AND id = ?`).run(
        step,
        sessionId,
        op.id,
      );
      liveCount -= 1;
      results.push({ seq, op: op.op, entryId: op.id, applied: true, reason: null });
      return;
    }

    // save_knowledge / save_procedural
    const kind: EntryKind = op.op === "save_knowledge" ? "knowledge" : "procedural";
    const existing = getEntry(db, sessionId, op.id);

    if (existing && existing.deleted === 0) {
      db.prepare(
        `UPDATE entry SET kind = ?, content = ?, updated_step = ? WHERE session_id = ? AND id = ?`,
      ).run(kind, op.content, step, sessionId, op.id);
      results.push({ seq, op: op.op, entryId: op.id, applied: true, reason: null });
      return;
    }

    // Brand new id, or reviving a soft-deleted id: both consume capacity.
    if (liveCount >= cap) {
      results.push({ seq, op: op.op, entryId: op.id, applied: false, reason: "cap_exceeded" });
      return;
    }

    if (existing && existing.deleted === 1) {
      db.prepare(
        `UPDATE entry SET kind = ?, content = ?, updated_step = ?, deleted = 0 WHERE session_id = ? AND id = ?`,
      ).run(kind, op.content, step, sessionId, op.id);
    } else {
      db.prepare(
        `INSERT INTO entry (id, session_id, kind, content, created_step, updated_step, inject_count, last_injected_step, deleted)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0)`,
      ).run(op.id, sessionId, kind, op.content, step, step);
    }
    liveCount += 1;
    results.push({ seq, op: op.op, entryId: op.id, applied: true, reason: null });
  });

  return results;
}

/** Marks entries as having been cited in an accepted reminder at `step`. */
export function markInjected(
  db: DatabaseSync,
  sessionId: string,
  entryIds: readonly string[],
  step: number,
): void {
  const stmt = db.prepare(
    `UPDATE entry SET inject_count = inject_count + 1, last_injected_step = ? WHERE session_id = ? AND id = ?`,
  );
  for (const id of entryIds) {
    stmt.run(step, sessionId, id);
  }
}
