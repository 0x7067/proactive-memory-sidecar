import { HARD_REMINDER_MAX_TOKENS } from "../constants.js";
import type { EntryRow, GuardEvaluation, GuardFailure } from "../types.js";
import { trigramSimilarity } from "../lib/trigram-similarity.js";
import { estimateTokens } from "./tokenizer.js";

export interface ReminderCandidate {
  text: string;
  groundingIds: string[];
}

export interface GuardContext {
  step: number;
  /** False only for genuinely forced triggers (tool failure / near-duplicate) — bypasses cooldown only. */
  forced: boolean;
  maxTokens: number;
  cooldownSteps: number;
  similarityThreshold: number;
  /** The *prospective* bank — after this step's Phase 1 ops have already been applied. */
  liveEntryIds: ReadonlySet<string>;
  entriesById: ReadonlyMap<string, EntryRow>;
  /** Most recent logged reminders for this session (any shadow state), most recent first. */
  recentReminderTexts: readonly string[];
}

type GuardFn = (candidate: ReminderCandidate, ctx: GuardContext) => GuardFailure | null;

/** Guard 1/6 — grounding ids must be present and every one must exist in the (prospective) bank. */
export function checkGrounding(candidate: ReminderCandidate, ctx: GuardContext): GuardFailure | null {
  if (candidate.groundingIds.length === 0) {
    return { guard: "grounding", reason: "no grounding ids provided" };
  }
  for (const id of candidate.groundingIds) {
    if (!ctx.liveEntryIds.has(id)) {
      return { guard: "grounding", reason: `grounding id "${id}" does not exist in the bank` };
    }
  }
  return null;
}

/**
 * Guard 2/6 — <=100 (configurable, but never more than
 * `HARD_REMINDER_MAX_TOKENS`) estimated tokens. The hard ceiling is
 * enforced here directly, not just at config-load time
 * (`src/config.ts`), so this guard is itself a real product invariant
 * regardless of what `ctx.maxTokens` claims — mirroring the dual
 * enforcement `HARD_MODEL_TIMEOUT_MS` gets in `src/model/http-adapter.ts`.
 */
export function checkTokenCap(candidate: ReminderCandidate, ctx: GuardContext): GuardFailure | null {
  const effectiveMax = Math.min(ctx.maxTokens, HARD_REMINDER_MAX_TOKENS);
  const n = estimateTokens(candidate.text);
  if (n > effectiveMax) {
    return { guard: "token_cap", reason: `estimated ${n} tokens exceeds cap of ${effectiveMax}` };
  }
  return null;
}

// Deliberately conservative: real clock/calendar patterns only. "step 14" and similar
// bank-relative references (encouraged by the prompt) must never trip this guard.
const WALLCLOCK_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?\b/i, // ISO datetime, e.g. 2026-07-12T14:30
  /\b\d{4}-\d{2}-\d{2}\b/, // ISO date, e.g. 2026-07-12
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, // slash date, e.g. 7/12/2026
  /\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)\b/i, // clock time, e.g. 3:45pm
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{4}\b/i, // "July 12, 2026"
  /\bjust now\b/i,
  /\ba moment ago\b/i,
  /\bright now\b/i,
  /\bcurrently \d{1,2}:\d{2}\b/i,
  /\btoday'?s date\b/i,
  /\bat the current time\b/i,
];

/** Guard 3/6 — session resume/replay safety: no wall-clock timestamps or "current time" phrasing. */
export function checkNoWallClockTime(candidate: ReminderCandidate): GuardFailure | null {
  for (const pattern of WALLCLOCK_PATTERNS) {
    if (pattern.test(candidate.text)) {
      return {
        guard: "no_wallclock_time",
        reason: `text matches a wall-clock/timestamp pattern (${pattern.source})`,
      };
    }
  }
  return null;
}

// Modal/advisory markers checked regardless of subject/pronoun: "the regex should be
// updated" is advice about what to do just as much as "you should update the regex".
const MODAL_ADVICE_MARKERS = [
  "should",
  "must",
  "need to",
  "needs to",
  "ought to",
  "have to",
  "has to",
  "make sure",
  "be sure to",
  "try to",
  "please",
  "let's",
  "let us",
  "remember to",
  "don't forget to",
  "do not forget to",
  "recommended to",
  "you should",
  "you must",
];

// Sentence-initial bare imperative verbs — catches command-form sentences
// ("Fix the regex...") that don't happen to use a modal marker.
const IMPERATIVE_VERBS = new Set([
  "run", "use", "try", "fix", "add", "remove", "delete", "check", "ensure",
  "verify", "avoid", "stop", "start", "make", "call", "invoke", "write",
  "implement", "refactor", "update", "change", "rewrite", "install",
  "configure", "set", "enable", "disable", "restart", "revert", "undo",
  "retry", "rerun", "re-run", "open", "close", "execute", "apply",
  "replace", "rename", "move", "create", "build", "compile", "deploy",
  "consider", "don't", "do",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Guard 4/6 — factual/prior-observation phrasing only; no imperative planning or advice. */
export function checkFactualProse(candidate: ReminderCandidate): GuardFailure | null {
  for (const marker of MODAL_ADVICE_MARKERS) {
    const pattern = new RegExp(`\\b${escapeRegExp(marker)}\\b`, "i");
    if (pattern.test(candidate.text)) {
      return { guard: "factual_prose", reason: `contains advisory marker "${marker}"` };
    }
  }

  const withoutLabel = candidate.text.replace(/^\s*reminder:\s*/i, "");
  const sentences = withoutLabel.split(/(?<=[.!?;])\s+/);
  for (const sentence of sentences) {
    const firstWordRaw = sentence.trim().split(/\s+/)[0] ?? "";
    const firstWord = firstWordRaw.toLowerCase().replace(/[^a-z'-]/g, "");
    if (firstWord && IMPERATIVE_VERBS.has(firstWord)) {
      return { guard: "factual_prose", reason: `sentence starts with imperative verb "${firstWord}"` };
    }
  }

  return null;
}

/** Guard 5/6 — per-cited-entry cooldown of `cooldownSteps`, bypassed only for forced triggers. */
export function checkCooldown(candidate: ReminderCandidate, ctx: GuardContext): GuardFailure | null {
  if (ctx.forced) return null;

  for (const id of candidate.groundingIds) {
    const entry = ctx.entriesById.get(id);
    const lastInjected = entry?.last_injected_step;
    if (lastInjected !== null && lastInjected !== undefined) {
      const stepsSince = ctx.step - lastInjected;
      if (stepsSince < ctx.cooldownSteps) {
        return {
          guard: "cooldown",
          reason: `entry "${id}" was injected ${stepsSince} step(s) ago; cooldown is ${ctx.cooldownSteps}`,
        };
      }
    }
  }
  return null;
}

/** Guard 6/6 — suppress if >threshold trigram-similar to any recently-injected reminder (forced or not). */
export function checkSimilarity(candidate: ReminderCandidate, ctx: GuardContext): GuardFailure | null {
  for (const prior of ctx.recentReminderTexts) {
    const similarity = trigramSimilarity(candidate.text, prior);
    if (similarity > ctx.similarityThreshold) {
      return {
        guard: "similarity",
        reason: `similarity ${similarity.toFixed(3)} to a recent reminder exceeds threshold ${ctx.similarityThreshold}`,
      };
    }
  }
  return null;
}

const GUARD_PIPELINE: GuardFn[] = [
  checkGrounding,
  checkTokenCap,
  checkNoWallClockTime,
  checkFactualProse,
  checkCooldown,
  checkSimilarity,
];

/**
 * Runs every mechanical guard in a fixed order, short-circuiting on the
 * first failure. This is the sole gate between a parsed model candidate and
 * an accepted reminder — nothing bypasses it except PreCompact, which never
 * reaches Phase 2 evaluation at all (see `src/trigger/trigger-policy.ts`).
 */
export function evaluateReminderGuards(candidate: ReminderCandidate, ctx: GuardContext): GuardEvaluation {
  for (const guard of GUARD_PIPELINE) {
    const failure = guard(candidate, ctx);
    if (failure) return { accepted: false, failure };
  }
  return { accepted: true, groundingIds: candidate.groundingIds, text: candidate.text };
}
