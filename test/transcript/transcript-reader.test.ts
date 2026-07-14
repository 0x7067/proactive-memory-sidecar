import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { readTranscriptTail } from "../../src/transcript/transcript-reader.js";

describe("transcript-reader", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pms-transcript-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(name: string, lines: unknown[]): string {
    const path = join(dir, name);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return path;
  }

  test("missing file returns []", () => {
    assert.deepEqual(readTranscriptTail(join(dir, "does-not-exist.jsonl"), 8), []);
  });

  test("undefined/null path returns []", () => {
    assert.deepEqual(readTranscriptTail(undefined, 8), []);
    assert.deepEqual(readTranscriptTail(null, 8), []);
  });

  test("k=0 returns [] without touching the filesystem", () => {
    assert.deepEqual(readTranscriptTail(join(dir, "does-not-exist.jsonl"), 0), []);
  });

  test("empty file returns []", () => {
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "", "utf8");
    assert.deepEqual(readTranscriptTail(path, 8), []);
  });

  test("nested Claude-Code shape: { type, message: { role, content: string } }", () => {
    const path = writeFixture("nested-string.jsonl", [
      { type: "user", message: { role: "user", content: "please fix the bug" } },
      { type: "assistant", message: { role: "assistant", content: "looking into it" } },
    ]);
    const messages = readTranscriptTail(path, 8);
    assert.deepEqual(messages, [
      { role: "user", text: "please fix the bug" },
      { role: "assistant", text: "looking into it" },
    ]);
  });

  test("flattened shape: { role, content } with no outer type/message wrapper", () => {
    const path = writeFixture("flat.jsonl", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    const messages = readTranscriptTail(path, 8);
    assert.deepEqual(messages, [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
  });

  test("content blocks are condensed: text, tool_use, tool_result, thinking, image", () => {
    const path = writeFixture("blocks.jsonl", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think..." },
            { type: "text", text: "I'll run a command." },
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "total 0\ndrwxr-xr-x", is_error: false }],
        },
      },
    ]);
    const messages = readTranscriptTail(path, 8);
    assert.equal(messages.length, 2);
    assert.match(messages[0]?.text ?? "", /\[thinking\]/);
    assert.match(messages[0]?.text ?? "", /I'll run a command\./);
    assert.match(messages[0]?.text ?? "", /\[tool_use Bash\]/);
    assert.match(messages[1]?.text ?? "", /\[tool_result\]/);
    assert.doesNotMatch(messages.map((message) => message.text).join("\n"), /ls -la|total 0/);
  });

  test("Codex response_item messages populate the recent trajectory without tool arguments", () => {
    const path = writeFixture("codex-rollout.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "keep the hooks disabled" }],
        },
      },
      {
        type: "response_item",
        payload: { type: "custom_tool_call", name: "Bash", input: "railway TOKEN=do-not-leak" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "the hook remains disabled" }],
        },
      },
    ]);
    assert.deepEqual(readTranscriptTail(path, 8), [
      { role: "user", text: "keep the hooks disabled" },
      { role: "assistant", text: "the hook remains disabled" },
    ]);
  });

  test("non-turn lines (summary/system/file-history-snapshot) are skipped", () => {
    const path = writeFixture("mixed-meta.jsonl", [
      { type: "summary", summary: "earlier conversation about auth" },
      { type: "file-history-snapshot", snapshot: {} },
      { type: "user", message: { role: "user", content: "real message" } },
    ]);
    const messages = readTranscriptTail(path, 8);
    assert.deepEqual(messages, [{ role: "user", text: "real message" }]);
  });

  test("malformed JSON lines are skipped without throwing", () => {
    const path = join(dir, "malformed.jsonl");
    const content = [
      '{"type":"user","message":{"role":"user","content":"ok before"}}',
      "{not valid json!!",
      '{"type":"assistant","message":{"role":"assistant","content":"ok after"}}',
    ].join("\n");
    writeFileSync(path, content, "utf8");
    const messages = readTranscriptTail(path, 8);
    assert.deepEqual(messages, [
      { role: "user", text: "ok before" },
      { role: "assistant", text: "ok after" },
    ]);
  });

  test("blank lines between records are ignored", () => {
    const path = join(dir, "blank-lines.jsonl");
    const content = [
      '{"type":"user","message":{"role":"user","content":"a"}}',
      "",
      "   ",
      '{"type":"assistant","message":{"role":"assistant","content":"b"}}',
    ].join("\n");
    writeFileSync(path, content, "utf8");
    assert.deepEqual(readTranscriptTail(path, 8), [
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
    ]);
  });

  test("returns only the last k messages, most-recent-last, when more than k exist", () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({
      type: i % 2 === 0 ? "user" : "assistant",
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `message-${i}` },
    }));
    const path = writeFixture("many.jsonl", lines);
    const messages = readTranscriptTail(path, 5);
    assert.equal(messages.length, 5);
    assert.deepEqual(
      messages.map((m) => m.text),
      ["message-15", "message-16", "message-17", "message-18", "message-19"],
    );
  });

  test("returns fewer than k messages when the file has fewer valid turns, without throwing", () => {
    const path = writeFixture("few.jsonl", [{ type: "user", message: { role: "user", content: "only one" } }]);
    const messages = readTranscriptTail(path, 8);
    assert.equal(messages.length, 1);
  });

  test("very large file: tail reading finds the last k messages without reading from the start", () => {
    const lines: string[] = [];
    // Pad the file well past the smallest read window (64KB) with large, irrelevant early lines.
    const filler = "x".repeat(2000);
    for (let i = 0; i < 400; i++) {
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: `filler-${i}-${filler}` } }));
    }
    for (let i = 0; i < 3; i++) {
      lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: `tail-${i}` } }));
    }
    const path = join(dir, "huge.jsonl");
    writeFileSync(path, lines.join("\n") + "\n", "utf8");

    const messages = readTranscriptTail(path, 3);
    assert.deepEqual(
      messages.map((m) => m.text),
      ["tail-0", "tail-1", "tail-2"],
    );
  });

  test("very long message content is truncated with a marker", () => {
    const longText = "a".repeat(5000);
    const path = writeFixture("long.jsonl", [{ type: "user", message: { role: "user", content: longText } }]);
    const messages = readTranscriptTail(path, 8);
    assert.ok((messages[0]?.text.length ?? 0) < longText.length);
    assert.match(messages[0]?.text ?? "", /truncated/);
  });

  test("unknown role values normalize to 'other' rather than throwing", () => {
    const path = writeFixture("weird-role.jsonl", [{ role: "tool_server", content: "side note" }]);
    const messages = readTranscriptTail(path, 8);
    assert.equal(messages[0]?.role, "other");
  });
});
