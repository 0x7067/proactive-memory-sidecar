/**
 * Central home for every tunable numeric/string contract in the system.
 *
 * These are the defaults described in the design brief and (per the brief's
 * reading of "Remember When It Matters: Proactive Memory Agent for
 * Long-Horizon Agents", https://huggingface.co/papers/2607.08716). Every
 * value here is independently overridable via environment variables (see
 * `src/config.ts`) so operators can tune without a code change, but the
 * defaults below are the ones the test suite and README exercise/quote.
 */

/** Hard ceiling on live (non-deleted) entries per session bank. */
export const DEFAULT_BANK_CAP = 60;

/** Run the full engine (Phase 1 + Phase 2) every Nth PostToolUse-family call. */
export const DEFAULT_CADENCE_N = 4;

/** Steps a bank entry must "rest" after being cited before it can be cited again (absent a forced trigger). */
export const DEFAULT_COOLDOWN_STEPS = 6;

/** Trigram-Jaccard similarity strictly above this suppresses a reminder as near-duplicate of recent history. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

/** Number of trailing transcript messages read to build model context. */
export const DEFAULT_TRANSCRIPT_TAIL_K = 8;

/** Mechanically enforced reminder length ceiling, in conservatively-estimated tokens. */
export const DEFAULT_REMINDER_MAX_TOKENS = 100;

/** How many previously-logged reminders (any shadow state) to compare a new candidate against. */
export const DEFAULT_SIMILARITY_HISTORY_WINDOW = 10;

/** How many prior same-tool calls to scan when detecting "near-identical repeated calls". */
export const DEFAULT_NEAR_DUP_WINDOW = 5;

/** Trigram-Jaccard similarity strictly above this on canonicalized tool input marks a call a forced-trigger repeat. */
export const DEFAULT_NEAR_DUP_THRESHOLD = 0.85;

/** Absolute, non-overridable ceiling on a single model call, per spec ("15s hard timeout"). */
export const HARD_MODEL_TIMEOUT_MS = 15_000;

/** Default (overridable, but clamped to HARD_MODEL_TIMEOUT_MS) model call timeout. */
export const DEFAULT_MODEL_TIMEOUT_MS = 15_000;

/** Outer safety-net wall-clock ceiling for one whole hook invocation (model call + DB work). */
export const DEFAULT_OVERALL_TIMEOUT_MS = 18_000;

/** How long we will wait to read the hook JSON payload from stdin before giving up. */
export const DEFAULT_STDIN_TIMEOUT_MS = 5_000;

/** SQLite busy_timeout (ms) applied to every connection to ride out brief writer contention. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Max characters accepted for a single bank entry's content field. */
export const DEFAULT_ENTRY_CONTENT_MAX_CHARS = 2000;

/** Max characters accepted for a bank entry id. */
export const DEFAULT_ENTRY_ID_MAX_CHARS = 128;

/** Max characters accepted for session.status via update_status. */
export const DEFAULT_STATUS_MAX_CHARS = 300;

/** Default max output tokens requested from the model adapter. */
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 900;

/** Relative path (joined onto the hook payload's `cwd`) of the project-local SQLite file. */
export const DEFAULT_DB_RELATIVE_PATH = ".claude/pms/bank.sqlite3";

/** Current SQLite schema version, tracked via `PRAGMA user_version`. */
export const SCHEMA_VERSION = 1;

/** The three hook events this sidecar attaches to. Anything else is a silent no-op. */
export const HANDLED_HOOK_EVENTS = [
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
] as const;

export const PHASE2_NO_INTERVENTION_TAG = "<no_intervention/>";
