import { HANDLED_HOOK_EVENTS } from "./constants.js";
import { isRecord } from "./lib/type-guards.js";
import type { CommonHookFields, HandledHookEventName, HookPayload } from "./types.js";

export function isHandledHookEvent(name: unknown): name is HandledHookEventName {
  return typeof name === "string" && (HANDLED_HOOK_EVENTS as readonly string[]).includes(name);
}

/** True when the hook payload indicates this event fired inside a subagent — such events are always skipped. */
export function isSubagentEvent(raw: unknown): boolean {
  return isRecord(raw) && typeof raw.agent_id === "string" && raw.agent_id.trim() !== "";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Codex emits a PostToolUse event for both successful and failed tool calls.
 * Normalize documented/common response failure signals without changing the
 * original hook event name, which must stay PostToolUse in hook stdout.
 */
function codexToolFailure(response: unknown): { failed: boolean; error: string | undefined } {
  if (!isRecord(response)) return { failed: false, error: undefined };

  const exitCode = typeof response.exit_code === "number"
    ? response.exit_code
    : typeof response.exitCode === "number"
      ? response.exitCode
      : undefined;
  const failed = response.success === false || response.is_error === true || (exitCode !== undefined && exitCode !== 0);
  if (!failed) return { failed: false, error: undefined };

  const detail = str(response.error) ?? str(response.stderr);
  const prefix = exitCode !== undefined ? `tool exited with code ${exitCode}` : "tool reported failure";
  return { failed: true, error: detail ? `${prefix}: ${detail}` : prefix };
}

/**
 * Validates and normalizes an arbitrary parsed-JSON value into a
 * `HookPayload`, or returns `null` if it isn't shaped like one of the three
 * events this sidecar handles (missing required fields, or an
 * `hook_event_name` we don't attach to). Never throws.
 */
export function parseHookPayload(raw: unknown): HookPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.session_id !== "string" || raw.session_id.trim() === "") return null;
  if (typeof raw.cwd !== "string" || raw.cwd.trim() === "") return null;
  if (!isHandledHookEvent(raw.hook_event_name)) return null;

  const common: Omit<CommonHookFields, "hook_event_name"> = {
    session_id: raw.session_id,
    cwd: raw.cwd,
    transcript_path: str(raw.transcript_path),
    agent_id: str(raw.agent_id),
    agent_type: str(raw.agent_type),
    permission_mode: str(raw.permission_mode),
    prompt_id: str(raw.prompt_id),
  };

  if (raw.hook_event_name === "PostToolUse") {
    if (typeof raw.tool_name !== "string") return null;
    const failure = codexToolFailure(raw.tool_response);
    return {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: raw.tool_name,
      tool_input: raw.tool_input,
      tool_response: raw.tool_response,
      tool_failed: failure.failed,
      error: failure.error,
      tool_use_id: str(raw.tool_use_id),
      duration_ms: num(raw.duration_ms),
    };
  }

  if (raw.hook_event_name === "PostToolUseFailure") {
    if (typeof raw.tool_name !== "string") return null;
    return {
      ...common,
      hook_event_name: "PostToolUseFailure",
      tool_name: raw.tool_name,
      tool_input: raw.tool_input,
      tool_use_id: str(raw.tool_use_id),
      error: str(raw.error),
      is_interrupt: bool(raw.is_interrupt),
      duration_ms: num(raw.duration_ms),
    };
  }

  // PreCompact
  return {
    ...common,
    hook_event_name: "PreCompact",
    trigger: str(raw.trigger),
    custom_instructions: str(raw.custom_instructions),
  };
}
