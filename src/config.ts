import * as constants from "./constants.js";

export type ModelProvider = "anthropic" | "openai";
export type SidecarMode = "shadow" | "live";

export interface Config {
  enabled: boolean;
  mode: SidecarMode;
  debug: boolean;

  dbRelativePath: string;
  dbAbsolutePathOverride: string | null;

  model: {
    provider: ModelProvider;
    baseUrl: string;
    apiKey: string | null;
    modelName: string;
    maxOutputTokens: number;
    timeoutMs: number;
  };

  cadenceN: number;
  bankCap: number;
  cooldownSteps: number;
  similarityThreshold: number;
  similarityHistoryWindow: number;
  transcriptTailK: number;
  reminderMaxTokens: number;
  nearDupWindow: number;
  nearDupThreshold: number;
  entryContentMaxChars: number;
  entryIdMaxChars: number;
  statusMaxChars: number;

  busyTimeoutMs: number;
  overallTimeoutMs: number;
  stdinTimeoutMs: number;

  /** Non-fatal problems encountered while reading env vars (bad values fell back to defaults). */
  warnings: string[];
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseIntClamped(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    warnings.push(`${name}="${raw}" is not an integer; using default ${fallback}`);
    return fallback;
  }
  if (n < min || n > max) {
    const clamped = Math.min(Math.max(n, min), max);
    warnings.push(`${name}=${n} out of range [${min},${max}]; clamped to ${clamped}`);
    return clamped;
  }
  return n;
}

function parseFloatClamped(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    warnings.push(`${name}="${raw}" is not a number; using default ${fallback}`);
    return fallback;
  }
  if (n < min || n > max) {
    const clamped = Math.min(Math.max(n, min), max);
    warnings.push(`${name}=${n} out of range [${min},${max}]; clamped to ${clamped}`);
    return clamped;
  }
  return n;
}

function parseProvider(raw: string | undefined, warnings: string[]): ModelProvider {
  if (raw === undefined || raw.trim() === "") return "anthropic";
  const v = raw.trim().toLowerCase();
  if (v === "anthropic" || v === "openai") return v;
  warnings.push(`PMS_MODEL_PROVIDER="${raw}" unrecognized; using "anthropic"`);
  return "anthropic";
}

function parseMode(raw: string | undefined, warnings: string[]): SidecarMode {
  if (raw === undefined || raw.trim() === "") return "shadow";
  const v = raw.trim().toLowerCase();
  if (v === "shadow" || v === "live") return v;
  warnings.push(`PMS_MODE="${raw}" unrecognized; using "shadow"`);
  return "shadow";
}

function defaultBaseUrl(provider: ModelProvider): string {
  return provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
}

function defaultModelName(provider: ModelProvider): string {
  // Documented, overridable placeholders — see README "Model configuration".
  return provider === "anthropic" ? "claude-haiku-4-5" : "gpt-4.1-mini";
}

/**
 * Pure function from environment to validated config. Never throws: any
 * malformed value is recorded in `warnings` and replaced with its default,
 * consistent with the project's fail-open posture.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const warnings: string[] = [];

  const provider = parseProvider(env.PMS_MODEL_PROVIDER, warnings);

  const modelTimeoutMs = parseIntClamped(
    env.PMS_MODEL_TIMEOUT_MS,
    constants.DEFAULT_MODEL_TIMEOUT_MS,
    1_000,
    constants.HARD_MODEL_TIMEOUT_MS,
    warnings,
    "PMS_MODEL_TIMEOUT_MS",
  );

  const apiKey =
    (provider === "anthropic"
      ? (env.PMS_MODEL_API_KEY ?? env.ANTHROPIC_API_KEY)
      : (env.PMS_MODEL_API_KEY ?? env.OPENAI_API_KEY)) ?? null;

  return {
    enabled: parseBool(env.PMS_ENABLED, true),
    mode: parseMode(env.PMS_MODE, warnings),
    debug: parseBool(env.PMS_DEBUG, false),

    dbRelativePath:
      env.PMS_DB_RELATIVE_PATH && env.PMS_DB_RELATIVE_PATH.trim() !== ""
        ? env.PMS_DB_RELATIVE_PATH
        : constants.DEFAULT_DB_RELATIVE_PATH,
    dbAbsolutePathOverride:
      env.PMS_DB_PATH && env.PMS_DB_PATH.trim() !== "" ? env.PMS_DB_PATH : null,

    model: {
      provider,
      baseUrl:
        env.PMS_MODEL_BASE_URL && env.PMS_MODEL_BASE_URL.trim() !== ""
          ? env.PMS_MODEL_BASE_URL.replace(/\/+$/, "")
          : defaultBaseUrl(provider),
      apiKey: apiKey && apiKey.trim() !== "" ? apiKey : null,
      modelName:
        env.PMS_MODEL_NAME && env.PMS_MODEL_NAME.trim() !== ""
          ? env.PMS_MODEL_NAME
          : defaultModelName(provider),
      maxOutputTokens: parseIntClamped(
        env.PMS_MODEL_MAX_OUTPUT_TOKENS,
        constants.DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
        64,
        4_096,
        warnings,
        "PMS_MODEL_MAX_OUTPUT_TOKENS",
      ),
      timeoutMs: modelTimeoutMs,
    },

    cadenceN: parseIntClamped(
      env.PMS_CADENCE_N,
      constants.DEFAULT_CADENCE_N,
      1,
      1000,
      warnings,
      "PMS_CADENCE_N",
    ),
    bankCap: parseIntClamped(
      env.PMS_BANK_CAP,
      constants.DEFAULT_BANK_CAP,
      1,
      100_000,
      warnings,
      "PMS_BANK_CAP",
    ),
    cooldownSteps: parseIntClamped(
      env.PMS_COOLDOWN_STEPS,
      constants.DEFAULT_COOLDOWN_STEPS,
      0,
      100_000,
      warnings,
      "PMS_COOLDOWN_STEPS",
    ),
    similarityThreshold: parseFloatClamped(
      env.PMS_SIMILARITY_THRESHOLD,
      constants.DEFAULT_SIMILARITY_THRESHOLD,
      0,
      1,
      warnings,
      "PMS_SIMILARITY_THRESHOLD",
    ),
    similarityHistoryWindow: parseIntClamped(
      env.PMS_SIMILARITY_HISTORY_WINDOW,
      constants.DEFAULT_SIMILARITY_HISTORY_WINDOW,
      1,
      1000,
      warnings,
      "PMS_SIMILARITY_HISTORY_WINDOW",
    ),
    transcriptTailK: parseIntClamped(
      env.PMS_TRANSCRIPT_TAIL_K,
      constants.DEFAULT_TRANSCRIPT_TAIL_K,
      0,
      1000,
      warnings,
      "PMS_TRANSCRIPT_TAIL_K",
    ),
    reminderMaxTokens: parseIntClamped(
      env.PMS_REMINDER_MAX_TOKENS,
      constants.DEFAULT_REMINDER_MAX_TOKENS,
      1,
      constants.HARD_REMINDER_MAX_TOKENS,
      warnings,
      "PMS_REMINDER_MAX_TOKENS",
    ),
    nearDupWindow: parseIntClamped(
      env.PMS_NEAR_DUP_WINDOW,
      constants.DEFAULT_NEAR_DUP_WINDOW,
      1,
      1000,
      warnings,
      "PMS_NEAR_DUP_WINDOW",
    ),
    nearDupThreshold: parseFloatClamped(
      env.PMS_NEAR_DUP_THRESHOLD,
      constants.DEFAULT_NEAR_DUP_THRESHOLD,
      0,
      1,
      warnings,
      "PMS_NEAR_DUP_THRESHOLD",
    ),
    entryContentMaxChars: parseIntClamped(
      env.PMS_ENTRY_CONTENT_MAX_CHARS,
      constants.DEFAULT_ENTRY_CONTENT_MAX_CHARS,
      1,
      1_000_000,
      warnings,
      "PMS_ENTRY_CONTENT_MAX_CHARS",
    ),
    entryIdMaxChars: parseIntClamped(
      env.PMS_ENTRY_ID_MAX_CHARS,
      constants.DEFAULT_ENTRY_ID_MAX_CHARS,
      1,
      10_000,
      warnings,
      "PMS_ENTRY_ID_MAX_CHARS",
    ),
    statusMaxChars: parseIntClamped(
      env.PMS_STATUS_MAX_CHARS,
      constants.DEFAULT_STATUS_MAX_CHARS,
      0,
      100_000,
      warnings,
      "PMS_STATUS_MAX_CHARS",
    ),

    busyTimeoutMs: parseIntClamped(
      env.PMS_BUSY_TIMEOUT_MS,
      constants.DEFAULT_BUSY_TIMEOUT_MS,
      0,
      60_000,
      warnings,
      "PMS_BUSY_TIMEOUT_MS",
    ),
    overallTimeoutMs: parseIntClamped(
      env.PMS_OVERALL_TIMEOUT_MS,
      constants.DEFAULT_OVERALL_TIMEOUT_MS,
      modelTimeoutMs,
      constants.HARD_OVERALL_TIMEOUT_MS,
      warnings,
      "PMS_OVERALL_TIMEOUT_MS",
    ),
    stdinTimeoutMs: parseIntClamped(
      env.PMS_STDIN_TIMEOUT_MS,
      constants.DEFAULT_STDIN_TIMEOUT_MS,
      100,
      60_000,
      warnings,
      "PMS_STDIN_TIMEOUT_MS",
    ),

    warnings,
  };
}
