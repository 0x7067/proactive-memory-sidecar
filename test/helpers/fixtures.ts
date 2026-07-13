import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import type {
  PostToolUseFailurePayload,
  PostToolUsePayload,
  PreCompactPayload,
} from "../../src/types.js";

export function buildTestConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ PMS_MODEL_API_KEY: "test-key", PMS_DEBUG: "0", ...env });
}

export function makePostToolUsePayload(overrides: Partial<PostToolUsePayload> = {}): PostToolUsePayload {
  return {
    session_id: "sess-1",
    cwd: "/tmp/pms-fixture-project",
    hook_event_name: "PostToolUse",
    transcript_path: undefined,
    agent_id: undefined,
    agent_type: undefined,
    permission_mode: undefined,
    prompt_id: undefined,
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    tool_response: { success: true },
    tool_failed: false,
    error: undefined,
    tool_use_id: undefined,
    duration_ms: 12,
    ...overrides,
  };
}

export function makePostToolUseFailurePayload(
  overrides: Partial<PostToolUseFailurePayload> = {},
): PostToolUseFailurePayload {
  return {
    session_id: "sess-1",
    cwd: "/tmp/pms-fixture-project",
    hook_event_name: "PostToolUseFailure",
    transcript_path: undefined,
    agent_id: undefined,
    agent_type: undefined,
    permission_mode: undefined,
    prompt_id: undefined,
    tool_name: "Bash",
    tool_input: { command: "false" },
    tool_use_id: undefined,
    error: "Command exited with non-zero status code 1",
    is_interrupt: false,
    duration_ms: 8,
    ...overrides,
  };
}

export function makePreCompactPayload(overrides: Partial<PreCompactPayload> = {}): PreCompactPayload {
  return {
    session_id: "sess-1",
    cwd: "/tmp/pms-fixture-project",
    hook_event_name: "PreCompact",
    transcript_path: undefined,
    agent_id: undefined,
    agent_type: undefined,
    permission_mode: undefined,
    prompt_id: undefined,
    trigger: "auto",
    custom_instructions: undefined,
    ...overrides,
  };
}
