/**
 * Shared domain types for the proactive memory sidecar. Kept dependency-free
 * (no zod/io-ts) — validation lives in `src/hook-io.ts` and
 * `src/engine/parser.ts` as small hand-written type guards, which is enough
 * for the bounded set of shapes this project deals with.
 */

// ---------------------------------------------------------------------------
// Hook payloads (Claude Code -> our CLI, via stdin JSON)
// ---------------------------------------------------------------------------

export type HandledHookEventName = "PostToolUse" | "PostToolUseFailure" | "PreCompact";

// NB: optional hook fields are modeled as required-but-nullable
// (`T | undefined`) rather than `?:` throughout this section. The project
// builds with `exactOptionalPropertyTypes: true`, under which a true
// optional (`?:`) property may never be *assigned* `undefined` — only
// omitted entirely. The payload parser (`src/hook-io.ts`) always assigns a
// value (possibly `undefined`) for every field it recognizes, which is
// simpler and more explicit than conditionally omitting keys.
export interface CommonHookFields {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path: string | undefined;
  /** Present only when the hook fired inside a subagent call — such events are always skipped. */
  agent_id: string | undefined;
  agent_type: string | undefined;
  permission_mode: string | undefined;
  prompt_id: string | undefined;
}

export interface PostToolUsePayload extends CommonHookFields {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  /**
   * Codex reports failed tools through PostToolUse (rather than a separate
   * PostToolUseFailure event). This normalized flag preserves the harness
   * event name for stdout while giving trigger policy failure semantics.
   */
  tool_failed: boolean;
  /** Best-effort description derived from a Codex failed tool response. */
  error: string | undefined;
  tool_use_id: string | undefined;
  duration_ms: number | undefined;
}

export interface PostToolUseFailurePayload extends CommonHookFields {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string | undefined;
  error: string | undefined;
  is_interrupt: boolean | undefined;
  duration_ms: number | undefined;
}

export interface PreCompactPayload extends CommonHookFields {
  hook_event_name: "PreCompact";
  trigger: string | undefined;
  custom_instructions: string | undefined;
}

export type HookPayload = PostToolUsePayload | PostToolUseFailurePayload | PreCompactPayload;

// ---------------------------------------------------------------------------
// Persisted rows (mirrors src/db/schema.ts)
// ---------------------------------------------------------------------------

export interface SessionRow {
  session_id: string;
  cwd: string;
  step_count: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export type EntryKind = "knowledge" | "procedural";

export interface EntryRow {
  id: string;
  session_id: string;
  kind: EntryKind;
  content: string;
  created_step: number;
  updated_step: number;
  inject_count: number;
  last_injected_step: number | null;
  deleted: 0 | 1;
}

export type InterventionDecision = "silence" | "reminder";

export interface InterventionLogRow {
  session_id: string;
  step: number;
  decision: InterventionDecision;
  reminder: string | null;
  entry_ids: string | null;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  shadow: 0 | 1;
}

export type TriggerReason =
  | "cadence"
  | "forced_failure"
  | "forced_near_duplicate"
  | "not_due"
  | "precompact_sweep";

export type Phase2Outcome =
  | "not_applicable"
  | "no_intervention"
  | "accepted"
  | "parse_error"
  /** A stale, out-of-order response for a step a newer step has already superseded — see src/store/session-progress-store.ts. */
  | "stale_superseded"
  | `rejected:${string}`;

export interface TriggerEventRow {
  session_id: string;
  step: number;
  hook_event: HandledHookEventName;
  trigger_reason: TriggerReason;
  forced: 0 | 1;
  tool_name: string | null;
  input_sig: string | null;
  ok: 0 | 1 | null;
  phase2_ran: 0 | 1;
  phase2_outcome: Phase2Outcome;
  error: string | null;
  created_at: number;
}

export interface BankOpLogRow {
  session_id: string;
  step: number;
  seq: number;
  op: string;
  entry_id: string | null;
  applied: 0 | 1;
  reason: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Bank operations (Phase 1 wire format)
// ---------------------------------------------------------------------------

export type BankOpType = "update_status" | "save_knowledge" | "save_procedural" | "delete";

export interface UpdateStatusOp {
  op: "update_status";
  status: string;
}

export interface SaveKnowledgeOp {
  op: "save_knowledge";
  id: string;
  content: string;
}

export interface SaveProceduralOp {
  op: "save_procedural";
  id: string;
  content: string;
}

export interface DeleteOp {
  op: "delete";
  id: string;
}

export type BankOp = UpdateStatusOp | SaveKnowledgeOp | SaveProceduralOp | DeleteOp;

/**
 * One element of the model's `bank_ops` array after structural parsing,
 * preserving original order (order is semantically load-bearing for cap
 * enforcement — see `src/store/entry-store.ts`). Invalid entries are kept
 * in place, not dropped, so the audit trail in `bank_op_log` reflects
 * exactly what the model emitted and in what sequence.
 */
export type ParsedOpEntry =
  | { valid: true; op: BankOp }
  | { valid: false; raw: unknown; reason: string };

export interface AppliedOpResult {
  seq: number;
  op: string;
  entryId: string | null;
  applied: boolean;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Phase 2 (selective intervention) wire format
// ---------------------------------------------------------------------------

export type Phase2Raw =
  | { kind: "no_intervention" }
  | { kind: "context_for_action"; groundingRaw: string; text: string }
  | { kind: "unparseable"; reason: string };

export interface ParsedModelResponse {
  opEntries: ParsedOpEntry[];
  phase2: Phase2Raw;
  /** Set when the response could not be located/parsed as our wire format at all. */
  parseError: string | null;
}

export interface GuardFailure {
  guard: string;
  reason: string;
}

export type GuardEvaluation =
  | { accepted: true; groundingIds: string[]; text: string }
  | { accepted: false; failure: GuardFailure };

// ---------------------------------------------------------------------------
// Model adapter
// ---------------------------------------------------------------------------

export interface ModelRequest {
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  /** Caller-requested timeout; adapters must additionally clamp to HARD_MODEL_TIMEOUT_MS. */
  timeoutMs: number;
}

export interface ModelUsage {
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface ModelResponse {
  text: string;
  usage: ModelUsage;
}

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

// ---------------------------------------------------------------------------
// Trigger policy
// ---------------------------------------------------------------------------

export interface TriggerDecision {
  triggered: boolean;
  forced: boolean;
  reason: TriggerReason;
  /** false for PreCompact: Phase 2 never runs even if the model emits a context_for_action tag. */
  phase2Eligible: boolean;
}

// ---------------------------------------------------------------------------
// Engine result — what the CLI actually writes to stdout
// ---------------------------------------------------------------------------

export interface EngineOutcome {
  /** Fully-formed hook JSON to print to stdout verbatim, or null for "no hook output". */
  stdoutJson: string | null;
}
