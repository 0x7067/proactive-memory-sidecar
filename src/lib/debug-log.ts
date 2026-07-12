import type { Config } from "../config.js";

/**
 * stderr-only, PMS_DEBUG-gated diagnostic logger. Never writes to stdout —
 * stdout is reserved for the single JSON hook decision (or nothing at all).
 * Safe to call unconditionally; it is a no-op unless the operator opted in.
 */
export function debugLog(config: Pick<Config, "debug">, message: string, extra?: unknown): void {
  if (!config.debug) return;
  if (extra === undefined) {
    console.error(`[pms] ${message}`);
  } else {
    console.error(`[pms] ${message}`, extra);
  }
}

/** Best-effort, bounded stringification for error logging — never throws. */
export function describeError(err: unknown): string {
  try {
    if (err instanceof Error) {
      return `${err.name}: ${err.message}`;
    }
    return String(err);
  } catch {
    return "unknown error";
  }
}
