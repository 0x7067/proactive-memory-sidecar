import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

const HOOK_BIN = fileURLToPath(new URL("../../src/bin/hook.js", import.meta.url));

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runHook(input: string | null, env: Record<string, string>, cwd: string, timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_BIN], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hook process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: code });
    });

    if (input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

type ServerHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

describe("hook CLI (end-to-end subprocess)", () => {
  let server: Server;
  let baseUrl: string;
  let handler: ServerHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ content: [{ type: "text", text: "<bank_ops>[]</bank_ops>\n<no_intervention/>" }] }),
    );
  };

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address && typeof address === "object") {
      baseUrl = `http://127.0.0.1:${address.port}`;
    } else {
      throw new Error("failed to bind test model server");
    }
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(() => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ content: [{ type: "text", text: "<bank_ops>[]</bank_ops>\n<no_intervention/>" }] }),
      );
    };
  });

  let projectDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pms-cli-"));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PMS_MODEL_PROVIDER: "anthropic",
      PMS_MODEL_BASE_URL: baseUrl,
      PMS_MODEL_API_KEY: "test-key",
      PMS_CADENCE_N: "1",
      ...extra,
    };
  }

  function postToolUsePayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: "s1",
      cwd: projectDir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: { success: true },
      ...overrides,
    });
  }

  function dbPath(): string {
    return join(projectDir, ".claude", "pms", "bank.sqlite3");
  }

  test("exits 0 with empty stdout for a fast-path (non-triggering) call, and creates the db", async () => {
    const result = await runHook(postToolUsePayload(), baseEnv({ PMS_CADENCE_N: "4" }), projectDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.ok(existsSync(dbPath()));
  });

  test("kill switch (PMS_ENABLED=0): exits 0 immediately, no db created, even with a triggering payload", async () => {
    const result = await runHook(postToolUsePayload(), baseEnv({ PMS_ENABLED: "0" }), projectDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(dbPath()), false);
  });

  test("malformed JSON on stdin fails open: exit 0, empty stdout", async () => {
    const result = await runHook("{not valid json", baseEnv(), projectDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });

  test("empty stdin fails open: exit 0, empty stdout", async () => {
    const result = await runHook("", baseEnv(), projectDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });

  test("an unhandled hook_event_name is a silent no-op: exit 0, empty stdout, no db created", async () => {
    const result = await runHook(
      postToolUsePayload({ hook_event_name: "PreToolUse" }),
      baseEnv(),
      projectDir,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(dbPath()), false);
  });

  test("a subagent-scoped event (agent_id present) is skipped entirely: exit 0, empty stdout, no db created", async () => {
    const result = await runHook(postToolUsePayload({ agent_id: "agent-123" }), baseEnv(), projectDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(dbPath()), false);
  });

  test("shadow mode (default): a triggered, accepted reminder is persisted but never printed", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"fact"}]</bank_ops>
<context_for_action grounding="req:a">
Reminder: the task requires X, as established earlier.
</context_for_action>`,
            },
          ],
        }),
      );
    };
    const result = await runHook(postToolUsePayload(), baseEnv({ PMS_MODE: "shadow" }), projectDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");

    const db = new DatabaseSync(dbPath());
    try {
      const row = db.prepare("SELECT decision, shadow, reminder FROM intervention_log WHERE session_id = 's1' AND step = 1").get() as
        | { decision: string; shadow: number; reminder: string }
        | undefined;
      assert.equal(row?.decision, "reminder");
      assert.equal(row?.shadow, 1);
      assert.match(row?.reminder ?? "", /Reminder: the task requires X/);
    } finally {
      db.close();
    }
  });

  test("live mode: a triggered, accepted reminder is printed in the exact required wire shape", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: `<bank_ops>[{"op":"save_knowledge","id":"req:a","content":"fact"}]</bank_ops>
<context_for_action grounding="req:a">
Reminder: the task requires X, as established earlier.
</context_for_action>`,
            },
          ],
        }),
      );
    };
    const result = await runHook(postToolUsePayload(), baseEnv({ PMS_MODE: "live" }), projectDir);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout.trim()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.equal(parsed.hookSpecificOutput.additionalContext, "Reminder: the task requires X, as established earlier.");
  });

  test("PreCompact never emits additionalContext even in live mode", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: `<bank_ops>[]</bank_ops>\n<context_for_action grounding="x">Reminder: should not appear.</context_for_action>`,
            },
          ],
        }),
      );
    };
    const result = await runHook(
      JSON.stringify({ session_id: "s1", cwd: projectDir, hook_event_name: "PreCompact", trigger: "auto" }),
      baseEnv({ PMS_MODE: "live" }),
      projectDir,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });

  test("a model server error fails open: exit 0, empty stdout", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" }).end("boom");
    };
    const result = await runHook(postToolUsePayload(), baseEnv({ PMS_MODE: "live" }), projectDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
  });

  test("a model server that hangs still fails open quickly, bounded by the configured timeouts", async () => {
    handler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ content: [{ type: "text", text: "<no_intervention/>" }] }),
        );
      }, 8000);
    };
    const start = Date.now();
    const result = await runHook(
      postToolUsePayload(),
      baseEnv({ PMS_MODE: "live", PMS_MODEL_TIMEOUT_MS: "300", PMS_OVERALL_TIMEOUT_MS: "1000" }),
      projectDir,
      5000,
    );
    const elapsed = Date.now() - start;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.ok(elapsed < 3000, `expected the hook to fail open well under 3s, took ${elapsed}ms`);
  });

  test("PMS_DEBUG writes diagnostics to stderr, never to stdout", async () => {
    const result = await runHook(postToolUsePayload({ agent_id: "agent-1" }), baseEnv({ PMS_DEBUG: "1" }), projectDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /subagent/i);
  });
});
