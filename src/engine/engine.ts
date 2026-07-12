import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import { withTransaction } from "../db/transaction.js";
import { canonicalizeToolInput } from "../lib/canonicalize.js";
import { debugLog, describeError } from "../lib/debug-log.js";
import type { Deadline } from "../lib/deadline.js";
import { isRecord } from "../lib/type-guards.js";
import {
  applyBankOps,
  getEntriesByIds,
  getLiveEntryIdSet,
  listLiveEntries,
  markInjected,
} from "../store/entry-store.js";
import { getRecentReminders, recordInterventionLog } from "../store/intervention-log-store.js";
import {
  advanceCommittedStep,
  getSessionProgress,
  incrementPostToolUseSuccessCount,
} from "../store/session-progress-store.js";
import { getOrCreateSession, getSession, incrementStep } from "../store/session-store.js";
import { recordBankOpLog } from "../store/bank-op-log-store.js";
import { finalizeTriggerEvent, recordTriggerEvent } from "../store/trigger-event-store.js";
import { isNearDuplicateToolCall } from "../trigger/near-duplicate.js";
import { decideTrigger } from "../trigger/trigger-policy.js";
import { readTranscriptTail } from "../transcript/transcript-reader.js";
import type {
  AppliedOpResult,
  EngineOutcome,
  HookPayload,
  InterventionDecision,
  ModelAdapter,
  ParsedOpEntry,
  Phase2Outcome,
} from "../types.js";
import { evaluateReminderGuards, type GuardContext, type ReminderCandidate } from "./guards.js";
import { parseModelResponse } from "./parser.js";
import { buildPrompt, type PromptToolEvent } from "./prompt.js";

export interface EngineDeps {
  db: DatabaseSync;
  modelAdapter: ModelAdapter;
  config: Config;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Single per-invocation wall-clock deadline (see `src/lib/deadline.ts`),
   * threaded down from `src/bin/hook.ts`. Optional and unbounded when
   * absent (e.g. in tests that don't care about the time budget) so this
   * stays backward compatible: the model call simply uses
   * `config.model.timeoutMs` unclamped.
   */
  deadline?: Deadline;
}

function extractToolEvent(payload: HookPayload): PromptToolEvent {
  if (payload.hook_event_name === "PostToolUse") {
    return {
      toolName: payload.tool_name,
      toolInput: payload.tool_input ?? null,
      toolResponse: payload.tool_response ?? null,
      error: null,
    };
  }
  if (payload.hook_event_name === "PostToolUseFailure") {
    return {
      toolName: payload.tool_name,
      toolInput: payload.tool_input ?? null,
      toolResponse: null,
      error: payload.error ?? null,
    };
  }
  return { toolName: null, toolInput: null, toolResponse: null, error: null };
}

/**
 * Records the benign "not triggered" fast path: a real intervention_log
 * silence row, and a trigger_event finalized with no error. Never throws.
 */
function recordFastPathSilence(
  db: DatabaseSync,
  sessionId: string,
  step: number,
  latencyMs: number,
  shadow: boolean,
): void {
  try {
    withTransaction(db, () => {
      finalizeTriggerEvent(db, sessionId, step, {
        phase2Ran: false,
        phase2Outcome: "not_applicable",
        error: null,
      });
      recordInterventionLog(db, {
        sessionId,
        step,
        decision: "silence",
        reminder: null,
        entryIds: null,
        latencyMs,
        tokensIn: null,
        tokensOut: null,
        shadow,
      });
    });
  } catch {
    // Truly degrading to no-op: even the fast-path log couldn't be written.
  }
}

/**
 * Builds a truthful "attempted but suppressed" audit trail for a stale
 * step's Phase 1 batch, mirroring the shape `applyBankOps` would have
 * logged had it actually run — without mutating anything. Used only when
 * `processHookEvent` determines this step's Phase B is stale (see
 * `staleOpResults` callers below).
 */
function staleOpResults(opEntries: readonly ParsedOpEntry[]): AppliedOpResult[] {
  return opEntries.map((entry, index) => {
    const seq = index + 1;
    if (!entry.valid) {
      const raw = entry.raw;
      const opLabel = isRecord(raw) && typeof raw.op === "string" ? raw.op : "unknown";
      const entryId = isRecord(raw) && typeof raw.id === "string" ? raw.id : null;
      return { seq, op: opLabel, entryId, applied: false, reason: "stale_superseded" };
    }
    const op = entry.op;
    const entryId = op.op === "update_status" ? null : op.id;
    return { seq, op: op.op, entryId, applied: false, reason: "stale_superseded" };
  });
}

/** Best-effort fallback logging when something actually failed after the step number already exists. Never throws. */
function safeFallbackSilence(
  db: DatabaseSync,
  sessionId: string,
  step: number,
  latencyMs: number,
  shadow: boolean,
  errorMessage: string,
  tokensIn: number | null,
  tokensOut: number | null,
): void {
  try {
    withTransaction(db, () => {
      finalizeTriggerEvent(db, sessionId, step, {
        phase2Ran: false,
        phase2Outcome: "not_applicable",
        error: errorMessage.slice(0, 500),
      });
      recordInterventionLog(db, {
        sessionId,
        step,
        decision: "silence",
        reminder: null,
        entryIds: null,
        latencyMs,
        tokensIn,
        tokensOut,
        shadow,
      });
    });
  } catch {
    // Truly degrading to no-op: even the fallback log couldn't be written.
  }
}

/**
 * Processes one hook event end-to-end: bank maintenance (Phase 1) plus, when
 * eligible and triggered, selective intervention (Phase 2). Never throws —
 * every failure path degrades to `{ stdoutJson: null }` ("no hook output"),
 * consistent with the project's fail-open requirement. Callers (the CLI
 * entry point) should still wrap this in their own try/catch as
 * defense-in-depth, but should never need to rely on it.
 */
export async function processHookEvent(payload: HookPayload, deps: EngineDeps): Promise<EngineOutcome> {
  const { db, config, modelAdapter } = deps;
  const now = deps.now ?? Date.now;
  const hookEvent = payload.hook_event_name;
  const sessionId = payload.session_id;
  const startMs = now();

  const toolEvent = extractToolEvent(payload);
  const toolInputSig = toolEvent.toolName ? canonicalizeToolInput(toolEvent.toolInput) : null;

  let newStep: number;
  let triggerDecision: ReturnType<typeof decideTrigger>;

  try {
    const result = withTransaction(db, () => {
      getOrCreateSession(db, sessionId, payload.cwd, startMs);
      const step = incrementStep(db, sessionId, startMs);

      let isNearDup = false;
      if (hookEvent === "PostToolUse" && toolEvent.toolName) {
        isNearDup = isNearDuplicateToolCall(
          db,
          sessionId,
          toolEvent.toolName,
          toolInputSig ?? "",
          config.nearDupWindow,
          config.nearDupThreshold,
        );
      }

      // Durable, PostToolUse-only counter: PostToolUseFailure and PreCompact
      // must never shift *which* PostToolUse call lands on the cadence-Nth
      // tick (README "Trigger policy" promises "every Nth successful
      // PostToolUse"). session.step_count (used as `step` below) remains the
      // all-event chronological ordering key for entry/trigger_event/
      // intervention_log — only the cadence *decision* uses this counter.
      const postToolUseSuccessCount =
        hookEvent === "PostToolUse" ? incrementPostToolUseSuccessCount(db, sessionId) : 0;

      const decision = decideTrigger({
        hookEvent,
        postToolUseSuccessCount,
        cadenceN: config.cadenceN,
        isNearDuplicate: isNearDup,
      });

      recordTriggerEvent(db, {
        sessionId,
        step,
        hookEvent,
        triggerReason: decision.reason,
        forced: decision.forced,
        toolName: toolEvent.toolName,
        inputSig: toolInputSig,
        ok: hookEvent === "PostToolUseFailure" ? false : hookEvent === "PostToolUse" ? true : null,
        createdAt: startMs,
      });

      return { step, decision };
    });
    newStep = result.step;
    triggerDecision = result.decision;
  } catch (err) {
    // We don't even have a committed step number to log against — this is
    // the one genuine "not practical" case; total silent no-op is correct.
    debugLog(config, "phase A (trigger bookkeeping) failed; degrading to no-op", describeError(err));
    return { stdoutJson: null };
  }

  const shadow = config.mode === "shadow";

  if (!triggerDecision.triggered) {
    recordFastPathSilence(db, sessionId, newStep, Math.max(0, now() - startMs), shadow);
    return { stdoutJson: null };
  }

  // --- Triggered: build prompt from committed state and call the model. ---
  // No write transaction is held across this async call: Claude Code may
  // fire PostToolUse for several tools in one parallel batch concurrently,
  // and a sidecar that blocks sibling hook invocations on the SQLite writer
  // lock for the duration of a (possibly 15s) network call would add real
  // latency to the action agent. See README "Concurrency model".
  let modelText = "";
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let modelError: string | null = null;

  // Single per-invocation deadline (see src/lib/deadline.ts / src/bin/hook.ts):
  // the model call's own timeout must never exceed whatever remains of the
  // overall hook budget, and if that budget is already gone (stdin read
  // and/or DB open/contention already consumed it), skip the call entirely
  // rather than start a request we already know cannot finish in time.
  // Absent an injected deadline (e.g. most unit tests), this is unbounded
  // and behavior is unchanged from `config.model.timeoutMs`.
  const remainingForModel = deps.deadline ? deps.deadline.remainingMs() : Number.POSITIVE_INFINITY;

  if (remainingForModel <= 0) {
    modelError = "overall hook time budget was already exhausted before the model call";
    debugLog(config, "deadline exhausted before model call; degrading to silence", modelError);
  } else {
    try {
      const session = getSession(db, sessionId);
      const liveEntries = listLiveEntries(db, sessionId);
      const transcriptTail = readTranscriptTail(payload.transcript_path, config.transcriptTailK);

      const { system, user } = buildPrompt({
        hookEvent,
        step: newStep,
        cadenceN: config.cadenceN,
        triggerReason: triggerDecision.reason,
        forced: triggerDecision.forced,
        phase2Eligible: triggerDecision.phase2Eligible,
        sessionStatus: session?.status ?? "",
        bankCap: config.bankCap,
        liveEntries,
        transcriptTail,
        toolEvent,
        reminderMaxTokens: config.reminderMaxTokens,
        cooldownSteps: config.cooldownSteps,
        similarityThreshold: config.similarityThreshold,
      });

      const response = await modelAdapter.complete({
        systemPrompt: system,
        userPrompt: user,
        maxOutputTokens: config.model.maxOutputTokens,
        timeoutMs: Math.min(config.model.timeoutMs, remainingForModel),
      });
      modelText = response.text;
      tokensIn = response.usage.tokensIn;
      tokensOut = response.usage.tokensOut;
    } catch (err) {
      modelError = describeError(err);
      debugLog(config, "model call failed; degrading to silence", modelError);
    }
  }

  if (modelError !== null) {
    safeFallbackSilence(
      db,
      sessionId,
      newStep,
      Math.max(0, now() - startMs),
      shadow,
      modelError,
      tokensIn,
      tokensOut,
    );
    return { stdoutJson: null };
  }

  const parsed = parseModelResponse(modelText, {
    entryIdMaxChars: config.entryIdMaxChars,
    entryContentMaxChars: config.entryContentMaxChars,
    statusMaxChars: config.statusMaxChars,
  });

  try {
    const committed = withTransaction(db, () => {
      const appliedAt = now();

      // --- Concurrency ordering gate -----------------------------------
      // Claude Code can run several hook subprocesses for the same session
      // concurrently (see README "Concurrency model"); their model calls
      // (the async gap above, held with no write lock) can settle in any
      // order. `committedStep` is the durable, per-session watermark of the
      // highest step whose Phase B has already committed. Because SQLite
      // write transactions are fully serialized (BEGIN IMMEDIATE), reading
      // it and, below, either applying-and-advancing it or leaving it alone
      // is atomic with respect to every other concurrent Phase B for this
      // session — so this check is race-free without any extra locking.
      //
      // If a step with a HIGHER number has already committed, this
      // response is stale/out-of-order: applying it now would risk
      // overwriting bank content, session status, or injection/cooldown
      // bookkeeping that a newer step already established. Suppress every
      // mutation this step would have made — but still write a truthful
      // audit trail: bank ops are logged as attempted-but-superseded (not
      // silently dropped), the trigger event records *why* Phase 2 didn't
      // run, and the intervention log still records the real latency/token
      // spend, since the model call genuinely happened.
      const progress = getSessionProgress(db, sessionId);
      if (newStep < progress.committedStep) {
        recordBankOpLog(db, sessionId, newStep, staleOpResults(parsed.opEntries), appliedAt);

        finalizeTriggerEvent(db, sessionId, newStep, {
          phase2Ran: false,
          phase2Outcome: "stale_superseded",
          error: `stale: step ${newStep}'s response arrived after session already committed step ${progress.committedStep}`,
        });

        recordInterventionLog(db, {
          sessionId,
          step: newStep,
          decision: "silence",
          reminder: null,
          entryIds: null,
          latencyMs: Math.max(0, now() - startMs),
          tokensIn,
          tokensOut,
          shadow,
        });

        const staleDecision: InterventionDecision = "silence";
        const staleReminder: string | null = null;
        return { finalDecision: staleDecision, finalReminder: staleReminder };
      }
      advanceCommittedStep(db, sessionId, newStep);
      // ------------------------------------------------------------------

      const appliedResults = applyBankOps(db, sessionId, newStep, parsed.opEntries, config.bankCap, appliedAt);
      recordBankOpLog(db, sessionId, newStep, appliedResults, appliedAt);

      let phase2Outcome: Phase2Outcome;
      let finalReminder: string | null = null;
      let finalEntryIds: string[] | null = null;

      if (!triggerDecision.phase2Eligible) {
        // PreCompact: mechanically forced to silence regardless of what the
        // model produced, independent of whatever the parser found.
        phase2Outcome = "not_applicable";
      } else if (parsed.phase2.kind === "no_intervention") {
        phase2Outcome = "no_intervention";
      } else if (parsed.phase2.kind === "unparseable") {
        phase2Outcome = "parse_error";
      } else {
        const groundingIds = parsed.phase2.groundingRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const candidate: ReminderCandidate = { text: parsed.phase2.text, groundingIds };

        // The *prospective* bank: read after this step's own Phase 1 ops
        // were just applied, inside this same transaction.
        const liveEntryIds = getLiveEntryIdSet(db, sessionId);
        const entriesById = getEntriesByIds(db, sessionId, groundingIds);
        const recentReminderTexts = getRecentReminders(db, sessionId, config.similarityHistoryWindow)
          .map((r) => r.reminder)
          .filter((t): t is string => typeof t === "string");

        const guardCtx: GuardContext = {
          step: newStep,
          forced: triggerDecision.forced,
          maxTokens: config.reminderMaxTokens,
          cooldownSteps: config.cooldownSteps,
          similarityThreshold: config.similarityThreshold,
          liveEntryIds,
          entriesById,
          recentReminderTexts,
        };

        const evaluation = evaluateReminderGuards(candidate, guardCtx);
        if (evaluation.accepted) {
          phase2Outcome = "accepted";
          finalReminder = evaluation.text;
          finalEntryIds = evaluation.groundingIds;
        } else {
          phase2Outcome = `rejected:${evaluation.failure.guard}`;
          debugLog(config, "reminder rejected by guard", evaluation.failure);
        }
      }

      const finalDecision: InterventionDecision = finalReminder !== null ? "reminder" : "silence";

      if (finalDecision === "reminder" && finalEntryIds) {
        markInjected(db, sessionId, finalEntryIds, newStep);
      }

      finalizeTriggerEvent(db, sessionId, newStep, {
        phase2Ran: triggerDecision.phase2Eligible,
        phase2Outcome,
        error: null,
      });

      recordInterventionLog(db, {
        sessionId,
        step: newStep,
        decision: finalDecision,
        reminder: finalReminder,
        entryIds: finalEntryIds,
        latencyMs: Math.max(0, now() - startMs),
        tokensIn,
        tokensOut,
        shadow,
      });

      return { finalDecision, finalReminder };
    });

    if (committed.finalDecision === "reminder" && !shadow && committed.finalReminder !== null) {
      const stdoutJson = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: hookEvent,
          additionalContext: committed.finalReminder,
        },
      });
      return { stdoutJson };
    }
    return { stdoutJson: null };
  } catch (err) {
    debugLog(config, "phase B (apply + log) failed; attempting fallback silence log", describeError(err));
    safeFallbackSilence(
      db,
      sessionId,
      newStep,
      Math.max(0, now() - startMs),
      shadow,
      describeError(err),
      tokensIn,
      tokensOut,
    );
    return { stdoutJson: null };
  }
}
