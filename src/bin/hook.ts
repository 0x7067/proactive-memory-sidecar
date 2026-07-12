import "../lib/suppress-warnings.js";

import process from "node:process";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { resolveDbPath } from "../db/paths.js";
import { processHookEvent } from "../engine/engine.js";
import { isSubagentEvent, parseHookPayload } from "../hook-io.js";
import { debugLog, describeError } from "../lib/debug-log.js";
import { HttpModelAdapter } from "../model/http-adapter.js";
import type { EngineOutcome } from "../types.js";

function readStdin(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      resolve(value);
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = (): void => finish(null);

    const timer = setTimeout(() => finish(null), timeoutMs);

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}

/** Races `promise` against a hard wall-clock ceiling, resolving to `fallback` if it isn't won in time. */
function withOverallTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  if (!config.enabled) {
    return;
  }
  for (const w of config.warnings) {
    debugLog(config, `config warning: ${w}`);
  }

  const raw = await readStdin(config.stdinTimeoutMs);
  if (raw === null || raw.trim() === "") {
    debugLog(config, "no stdin payload received within timeout");
    return;
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch (err) {
    debugLog(config, "stdin payload was not valid JSON", describeError(err));
    return;
  }

  if (isSubagentEvent(parsedRaw)) {
    debugLog(config, "skipping subagent-scoped hook event");
    return;
  }

  const payload = parseHookPayload(parsedRaw);
  if (!payload) {
    debugLog(config, "payload did not match a handled hook event; ignoring");
    return;
  }

  const dbPath = resolveDbPath(payload.cwd, config);

  let outcome: EngineOutcome = { stdoutJson: null };
  try {
    const db = openDatabase(dbPath, config);
    try {
      const modelAdapter = new HttpModelAdapter({
        provider: config.model.provider,
        baseUrl: config.model.baseUrl,
        apiKey: config.model.apiKey,
        modelName: config.model.modelName,
      });

      outcome = await withOverallTimeout(
        processHookEvent(payload, { db, modelAdapter, config }),
        config.overallTimeoutMs,
        { stdoutJson: null },
      );
    } finally {
      try {
        db.close();
      } catch {
        // Nothing more to do — the process is about to exit anyway.
      }
    }
  } catch (err) {
    debugLog(config, "unhandled error while processing hook event; failing open", describeError(err));
    outcome = { stdoutJson: null };
  }

  if (outcome.stdoutJson) {
    process.stdout.write(`${outcome.stdoutJson}\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Absolute last resort: nothing above should ever throw past `main`,
    // but the fail-open contract is unconditional, so this is not "best
    // effort" — it is the guarantee. This one console.error is deliberately
    // NOT gated behind PMS_DEBUG (unlike every other diagnostic in this
    // project) because it only runs when every other safety net already
    // failed; leaving zero trace of a truly unexpected bug would be worse
    // than the alternative. This is still fail-open-safe: it writes to
    // stderr, never stdout, and Claude Code only parses stdout as the hook
    // decision on exit 0 (see README "Fail-open design"), so this line can
    // never surface as hook output, block a tool call, or change exit code.
    try {
      console.error(`[pms] fatal error, failing open: ${describeError(err)}`);
    } catch {
      // stderr itself may be gone; there is nothing left to do.
    }
    process.exit(0);
  });
