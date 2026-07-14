import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isSubagentEvent, parseHookPayload } from "../src/hook-io.js";

describe("isSubagentEvent", () => {
  test("true when agent_id is a non-empty string", () => {
    assert.equal(isSubagentEvent({ agent_id: "agent-123" }), true);
  });
  test("false when agent_id is absent", () => {
    assert.equal(isSubagentEvent({ session_id: "s1" }), false);
  });
  test("false when agent_id is an empty/whitespace string", () => {
    assert.equal(isSubagentEvent({ agent_id: "" }), false);
    assert.equal(isSubagentEvent({ agent_id: "   " }), false);
  });
  test("false for non-object input", () => {
    assert.equal(isSubagentEvent(null), false);
    assert.equal(isSubagentEvent("agent_id"), false);
    assert.equal(isSubagentEvent(42), false);
  });
});

describe("parseHookPayload", () => {
  test("null for non-object input", () => {
    assert.equal(parseHookPayload(null), null);
    assert.equal(parseHookPayload("a string"), null);
    assert.equal(parseHookPayload(42), null);
    assert.equal(parseHookPayload(undefined), null);
  });

  test("null when session_id or cwd is missing/empty", () => {
    assert.equal(parseHookPayload({ cwd: "/x", hook_event_name: "PostToolUse", tool_name: "Bash" }), null);
    assert.equal(parseHookPayload({ session_id: "", cwd: "/x", hook_event_name: "PostToolUse", tool_name: "Bash" }), null);
    assert.equal(parseHookPayload({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash" }), null);
  });

  test("null for hook_event_name outside the handled set (e.g. PreToolUse, Stop, SessionStart)", () => {
    for (const name of ["PreToolUse", "Stop", "SessionStart", "Notification", "bogus"]) {
      assert.equal(
        parseHookPayload({ session_id: "s1", cwd: "/x", hook_event_name: name }),
        null,
        `${name} should not be handled`,
      );
    }
  });

  test("valid PostToolUse payload parses with tool fields", () => {
    const payload = parseHookPayload({
      session_id: "s1",
      cwd: "/proj",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { success: true },
      transcript_path: "/proj/.claude/transcript.jsonl",
    });
    assert.ok(payload);
    assert.equal(payload?.hook_event_name, "PostToolUse");
    if (payload?.hook_event_name === "PostToolUse") {
      assert.equal(payload.tool_name, "Bash");
      assert.deepEqual(payload.tool_input, { command: "ls" });
    }
  });

  test("infers Codex and Claude harnesses from their actual wire fields", () => {
    const codex = parseHookPayload({
      session_id: "s1",
      turn_id: "turn-1",
      cwd: "/proj",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: { exit_code: 0 },
    });
    const claude = parseHookPayload({
      session_id: "s2",
      cwd: "/proj",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "false" },
      error: "failed",
    });
    assert.equal(codex?.harness, "codex");
    assert.equal(claude?.harness, "claude");
  });

  test("PostToolUse without tool_name is rejected", () => {
    assert.equal(
      parseHookPayload({ session_id: "s1", cwd: "/proj", hook_event_name: "PostToolUse" }),
      null,
    );
  });

  test("Codex PostToolUse with a non-zero exit_code is normalized as a tool failure", () => {
    const payload = parseHookPayload({
      session_id: "codex-session",
      cwd: "/proj",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "false" },
      tool_response: { exit_code: 1, stderr: "intentional failure" },
      turn_id: "turn-1",
    });
    assert.ok(payload);
    if (payload?.hook_event_name === "PostToolUse") {
      assert.equal(payload.tool_failed, true);
      assert.match(payload.error ?? "", /code 1/i);
    }
  });

  test("valid PostToolUseFailure payload parses with error fields", () => {
    const payload = parseHookPayload({
      session_id: "s1",
      cwd: "/proj",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "false" },
      error: "exit code 1",
      is_interrupt: false,
    });
    assert.ok(payload);
    if (payload?.hook_event_name === "PostToolUseFailure") {
      assert.equal(payload.error, "exit code 1");
      assert.equal(payload.is_interrupt, false);
    }
  });

  test("valid PreCompact payload parses without requiring tool fields", () => {
    const payload = parseHookPayload({
      session_id: "s1",
      cwd: "/proj",
      hook_event_name: "PreCompact",
      trigger: "auto",
    });
    assert.ok(payload);
    assert.equal(payload?.hook_event_name, "PreCompact");
  });

  test("unknown extra fields are ignored rather than causing rejection", () => {
    const payload = parseHookPayload({
      session_id: "s1",
      cwd: "/proj",
      hook_event_name: "PreCompact",
      some_future_field: { nested: true },
    });
    assert.ok(payload);
  });

  test("agent_id/agent_type are carried through when present", () => {
    const payload = parseHookPayload({
      session_id: "s1",
      cwd: "/proj",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      agent_id: "agent-1",
      agent_type: "Explore",
    });
    assert.equal(payload?.agent_id, "agent-1");
    assert.equal(payload?.agent_type, "Explore");
  });
});
