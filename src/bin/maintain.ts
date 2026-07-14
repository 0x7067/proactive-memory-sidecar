import "../lib/suppress-warnings.js";

import process from "node:process";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { resolveDbPath } from "../db/paths.js";

interface CliArgs {
  cwd: string;
  olderThanDays: number;
  dryRun: boolean;
  vacuum: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let cwd = process.cwd();
  let olderThanDays = 30;
  let dryRun = false;
  let vacuum = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd") {
      cwd = argv[++i] ?? cwd;
    } else if (arg === "--older-than-days") {
      const next = Number(argv[++i]);
      if (Number.isFinite(next) && next >= 0) olderThanDays = next;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--vacuum") {
      vacuum = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }
  return { cwd, olderThanDays, dryRun, vacuum, help };
}

const HELP_TEXT = `pms-maintain — prune stale sessions from the project-local memory bank.

This is a manually- or cron-invoked operator tool, not a Claude Code hook:
unlike the hook CLI it reports errors normally (non-zero exit, message on
stderr) instead of failing open.

Usage:
  pms-maintain [--cwd <path>] [--older-than-days 30] [--dry-run] [--vacuum]

Options:
  --cwd <path>            Project directory whose .proactive-memory database to prune (default: cwd)
  --older-than-days <n>   Delete sessions whose last activity is older than n days (default: 30)
  --dry-run               Report what would be deleted without deleting anything
  --vacuum                Run VACUUM after pruning to reclaim disk space
  --help                  Show this help text
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const config = loadConfig(process.env);
  const dbPath = resolveDbPath(args.cwd, config);
  const db = openDatabase(dbPath, config);

  try {
    const cutoff = Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000;
    const staleSessions = db
      .prepare(`SELECT session_id, updated_at FROM session WHERE updated_at < ?`)
      .all(cutoff) as Array<{ session_id: string; updated_at: number }>;

    if (staleSessions.length === 0) {
      process.stdout.write(`No sessions older than ${args.olderThanDays} day(s) at ${dbPath}. Nothing to do.\n`);
      return;
    }

    process.stdout.write(
      `${args.dryRun ? "[dry run] " : ""}${staleSessions.length} session(s) older than ${args.olderThanDays} day(s) at ${dbPath}:\n`,
    );
    for (const s of staleSessions) {
      process.stdout.write(`  - ${s.session_id} (last active ${new Date(s.updated_at).toISOString()})\n`);
    }

    if (args.dryRun) return;

    const deleteBankOpLog = db.prepare(`DELETE FROM bank_op_log WHERE session_id = ?`);
    const deleteEffectiveness = db.prepare(`DELETE FROM effectiveness_metric WHERE session_id = ?`);
    const deleteTrigger = db.prepare(`DELETE FROM trigger_event WHERE session_id = ?`);
    const deleteLog = db.prepare(`DELETE FROM intervention_log WHERE session_id = ?`);
    const deleteEntries = db.prepare(`DELETE FROM entry WHERE session_id = ?`);
    const deleteProgress = db.prepare(`DELETE FROM session_progress WHERE session_id = ?`);
    const deleteSession = db.prepare(`DELETE FROM session WHERE session_id = ?`);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of staleSessions) {
        // Children first: the mandated schema declares entry.session_id as a
        // plain REFERENCES with no ON DELETE clause, and we run with
        // `PRAGMA foreign_keys = ON`, so the parent row must go last.
        deleteBankOpLog.run(s.session_id);
        deleteEffectiveness.run(s.session_id);
        deleteTrigger.run(s.session_id);
        deleteLog.run(s.session_id);
        deleteEntries.run(s.session_id);
        deleteProgress.run(s.session_id);
        deleteSession.run(s.session_id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    process.stdout.write(`Deleted ${staleSessions.length} session(s) and their rows.\n`);

    if (args.vacuum) {
      db.exec("VACUUM");
      process.stdout.write("Ran VACUUM.\n");
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`pms-maintain: ${message}`);
  process.exitCode = 1;
}
