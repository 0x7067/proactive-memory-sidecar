import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { HARD_MODEL_TIMEOUT_MS } from "../src/constants.js";

describe("loadConfig", () => {
  test("defaults match the documented spec values", () => {
    const config = loadConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.mode, "shadow");
    assert.equal(config.cadenceN, 4);
    assert.equal(config.bankCap, 60);
    assert.equal(config.cooldownSteps, 6);
    assert.equal(config.similarityThreshold, 0.85);
    assert.equal(config.transcriptTailK, 8);
    assert.equal(config.reminderMaxTokens, 100);
    assert.equal(config.model.timeoutMs, 15000);
    assert.equal(config.model.provider, "anthropic");
  });

  test("PMS_ENABLED=false disables the sidecar", () => {
    assert.equal(loadConfig({ PMS_ENABLED: "false" }).enabled, false);
    assert.equal(loadConfig({ PMS_ENABLED: "0" }).enabled, false);
    assert.equal(loadConfig({ PMS_ENABLED: "1" }).enabled, true);
  });

  test("PMS_MODE selects shadow or live, defaulting to shadow on garbage input", () => {
    assert.equal(loadConfig({ PMS_MODE: "live" }).mode, "live");
    assert.equal(loadConfig({ PMS_MODE: "shadow" }).mode, "shadow");
    const withWarning = loadConfig({ PMS_MODE: "bogus" });
    assert.equal(withWarning.mode, "shadow");
    assert.ok(withWarning.warnings.some((w) => w.includes("PMS_MODE")));
  });

  test("model timeout is clamped to the hard 15s ceiling even if a larger value is requested", () => {
    const config = loadConfig({ PMS_MODEL_TIMEOUT_MS: "999999" });
    assert.equal(config.model.timeoutMs, HARD_MODEL_TIMEOUT_MS);
    assert.ok(config.warnings.some((w) => w.includes("PMS_MODEL_TIMEOUT_MS")));
  });

  test("model timeout below 1000ms is clamped up to 1000ms", () => {
    const config = loadConfig({ PMS_MODEL_TIMEOUT_MS: "10" });
    assert.equal(config.model.timeoutMs, 1000);
  });

  test("non-numeric overrides fall back to defaults with a warning, never throw", () => {
    assert.doesNotThrow(() => loadConfig({ PMS_CADENCE_N: "not-a-number" }));
    const config = loadConfig({ PMS_CADENCE_N: "not-a-number" });
    assert.equal(config.cadenceN, 4);
    assert.ok(config.warnings.length > 0);
  });

  test("similarity threshold is clamped to [0,1]", () => {
    assert.equal(loadConfig({ PMS_SIMILARITY_THRESHOLD: "5" }).similarityThreshold, 1);
    assert.equal(loadConfig({ PMS_SIMILARITY_THRESHOLD: "-1" }).similarityThreshold, 0);
    assert.equal(loadConfig({ PMS_SIMILARITY_THRESHOLD: "0.5" }).similarityThreshold, 0.5);
  });

  test("PMS_MODEL_PROVIDER selects anthropic or openai and sets provider-specific defaults", () => {
    const anthropic = loadConfig({ PMS_MODEL_PROVIDER: "anthropic" });
    assert.equal(anthropic.model.provider, "anthropic");
    assert.equal(anthropic.model.baseUrl, "https://api.anthropic.com");

    const openai = loadConfig({ PMS_MODEL_PROVIDER: "openai" });
    assert.equal(openai.model.provider, "openai");
    assert.equal(openai.model.baseUrl, "https://api.openai.com/v1");
  });

  test("PMS_MODEL_BASE_URL overrides the default and strips a trailing slash", () => {
    const config = loadConfig({ PMS_MODEL_BASE_URL: "http://localhost:8080/v1/" });
    assert.equal(config.model.baseUrl, "http://localhost:8080/v1");
  });

  test("api key resolution falls back to provider-specific env vars", () => {
    assert.equal(
      loadConfig({ PMS_MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-123" }).model.apiKey,
      "sk-ant-123",
    );
    assert.equal(
      loadConfig({ PMS_MODEL_PROVIDER: "openai", OPENAI_API_KEY: "sk-oai-123" }).model.apiKey,
      "sk-oai-123",
    );
    assert.equal(
      loadConfig({ PMS_MODEL_PROVIDER: "anthropic", PMS_MODEL_API_KEY: "override", ANTHROPIC_API_KEY: "ignored" })
        .model.apiKey,
      "override",
    );
    assert.equal(loadConfig({}).model.apiKey, null);
  });

  test("PMS_DB_PATH takes precedence over PMS_DB_RELATIVE_PATH", () => {
    const config = loadConfig({ PMS_DB_PATH: "/absolute/override.sqlite3" });
    assert.equal(config.dbAbsolutePathOverride, "/absolute/override.sqlite3");
  });

  test("overallTimeoutMs is never allowed below the (clamped) model timeout", () => {
    const config = loadConfig({ PMS_MODEL_TIMEOUT_MS: "15000", PMS_OVERALL_TIMEOUT_MS: "100" });
    assert.ok(config.overallTimeoutMs >= config.model.timeoutMs);
  });
});
