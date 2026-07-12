import { isAbsolute, resolve } from "node:path";
import type { Config } from "../config.js";

/**
 * Resolves the project-local SQLite file path for a hook event.
 *
 * Default: `<payloadCwd>/.claude/pms/bank.sqlite3` — one file per project,
 * holding every session's rows (isolated by `session_id`), never a global
 * or user-home path. `PMS_DB_PATH` overrides with an absolute path (or one
 * resolved against `payloadCwd` if relative) for operators who want the
 * database somewhere else entirely (e.g. a tmpfs during CI).
 */
export function resolveDbPath(payloadCwd: string, config: Pick<Config, "dbAbsolutePathOverride" | "dbRelativePath">): string {
  if (config.dbAbsolutePathOverride) {
    return isAbsolute(config.dbAbsolutePathOverride)
      ? config.dbAbsolutePathOverride
      : resolve(payloadCwd, config.dbAbsolutePathOverride);
  }
  return resolve(payloadCwd, config.dbRelativePath);
}
