import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { evaluateEffectivenessGate, type EffectivenessSample } from "../../src/effectiveness/gate.js";
import { processHookEvent } from "../../src/engine/engine.js";
import type { HarnessName } from "../../src/types.js";
import { FakeModelAdapter, type FakeResponse } from "../helpers/fake-model-adapter.js";
import { buildTestConfig, makePostToolUsePayload } from "../helpers/fixtures.js";
import { openTempDb } from "../helpers/tmp-db.js";

const AUDIT_BASELINE = {
  codex: { modelCalls: 47, inputTokens: 63_351, reminders: 0 },
  claude: { modelCalls: 34, inputTokens: 48_711, reminders: 10 },
} as const;

async function runHarness(harness: Exclude<HarnessName, "unknown">, modelCalls: number): Promise<EffectivenessSample> {
  const tmp = openTempDb();
  try {
    const responses: FakeResponse[] = Array.from({ length: modelCalls }, (_, index) => {
      const call = index + 1;
      if (call % 5 !== 0) return "<bank_ops>[]</bank_ops>\n<no_intervention/>";
      const id = `req:${harness}-${call}`;
      const fact = `The ${harness} benchmark recorded constraint ${call}.`;
      return `<bank_ops>[{"op":"save_knowledge","id":"${id}","content":"${fact}"}]</bank_ops>\n<context_for_action grounding="${id}">${fact}</context_for_action>`;
    });
    const model = new FakeModelAdapter(responses);
    const config = buildTestConfig({
      PMS_CADENCE_N: "1",
      PMS_MODE: "live",
      PMS_COOLDOWN_STEPS: "0",
      PMS_SIMILARITY_THRESHOLD: "1",
    });

    for (let index = 0; index < modelCalls; index++) {
      await processHookEvent(
        makePostToolUsePayload({
          session_id: `benchmark-${harness}`,
          harness,
          tool_input: { command: `echo ${harness}-${index}` },
        }),
        { db: tmp.db, modelAdapter: model, config },
      );
    }

    const row = tmp.db.prepare(
      `SELECT count(*) AS model_calls,
              coalesce(sum(tokens_in), 0) AS input_tokens,
              coalesce(sum(emitted_reminder), 0) AS reminders,
              coalesce(avg(latency_ms), 0) AS average_latency_ms,
              coalesce(max(latency_ms), 0) AS max_latency_ms,
              coalesce(sum(CASE WHEN skip_reason LIKE 'egress_%' AND provider_outcome != 'not_called' THEN 1 ELSE 0 END), 0) AS provider_calls_on_privacy_skips
         FROM effectiveness_metric
        WHERE harness = ? AND provider_outcome = 'success'`,
    ).get(harness) as {
      model_calls: number;
      input_tokens: number;
      reminders: number;
      average_latency_ms: number;
      max_latency_ms: number;
      provider_calls_on_privacy_skips: number;
    };
    assert.equal(model.calls.length, modelCalls);
    return {
      harness,
      modelCalls: row.model_calls,
      inputTokens: row.input_tokens,
      reminders: row.reminders,
      averageLatencyMs: row.average_latency_ms,
      maxLatencyMs: row.max_latency_ms,
      privacyViolations: 0,
      providerCallsOnPrivacySkips: row.provider_calls_on_privacy_skips,
    };
  } finally {
    tmp.cleanup();
  }
}

describe("local fake-adapter benchmark against the recorded audit baseline", () => {
  test("exercises both harness pipelines without network calls", async () => {
    const codex = await runHarness("codex", AUDIT_BASELINE.codex.modelCalls);
    const claude = await runHarness("claude", AUDIT_BASELINE.claude.modelCalls);
    const report = {
      baseline: AUDIT_BASELINE,
      fakeAdapter: { codex, claude },
      gates: {
        codex: evaluateEffectivenessGate(codex),
        claude: evaluateEffectivenessGate(claude),
      },
      note: "Fake-adapter results validate pipeline and gate mechanics; they do not authorize provider re-enable.",
    };
    assert.equal(report.gates.codex.passed, true);
    assert.equal(report.gates.claude.passed, true);
    assert.ok(codex.reminders > AUDIT_BASELINE.codex.reminders);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  });
});
