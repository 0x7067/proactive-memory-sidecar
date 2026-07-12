import { HARD_MODEL_TIMEOUT_MS } from "../constants.js";
import { isRecord } from "../lib/type-guards.js";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../types.js";
import { ModelAdapterError, ModelTimeoutError } from "./adapter.js";

export interface HttpModelAdapterConfig {
  provider: "anthropic" | "openai";
  baseUrl: string;
  apiKey: string | null;
  modelName: string;
}

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Default `ModelAdapter`: a single non-streaming HTTP call to either the
 * Anthropic Messages API or an OpenAI-compatible chat-completions endpoint
 * (OpenAI itself, Azure OpenAI, or any local/self-hosted server that speaks
 * the same wire format), selected by `PMS_MODEL_PROVIDER`. Uses the global
 * `fetch` (stable in Node since v18) — no HTTP client dependency.
 *
 * Enforces the hard 15s timeout unconditionally via `AbortController`,
 * regardless of what `request.timeoutMs` asks for — this is defense in
 * depth on top of the clamp already applied when config is loaded
 * (`src/config.ts`), so a bug anywhere upstream can never make a single
 * hook invocation hang past the documented ceiling.
 */
export class HttpModelAdapter implements ModelAdapter {
  constructor(private readonly config: HttpModelAdapterConfig) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!this.config.apiKey) {
      throw new ModelAdapterError(
        "no model API key configured (set PMS_MODEL_API_KEY, or ANTHROPIC_API_KEY / OPENAI_API_KEY)",
      );
    }

    const timeoutMs = Math.min(request.timeoutMs, HARD_MODEL_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return this.config.provider === "anthropic"
        ? await this.callAnthropic(request, controller.signal)
        : await this.callOpenAiCompatible(request, controller.signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new ModelTimeoutError(timeoutMs);
      }
      if (err instanceof ModelAdapterError) throw err;
      throw new ModelAdapterError("model call failed", { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  private async callAnthropic(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const res = await fetch(`${this.config.baseUrl}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey ?? "",
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.config.modelName,
        max_tokens: request.maxOutputTokens,
        temperature: 0,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
      }),
    });

    if (!res.ok) {
      const body = await safeReadText(res);
      throw new ModelAdapterError(`anthropic api returned ${res.status}: ${truncate(body, 500)}`);
    }

    const json: unknown = await res.json();
    if (!isRecord(json) || !Array.isArray(json.content)) {
      throw new ModelAdapterError("anthropic api response missing content[]");
    }

    const text = json.content
      .filter((block): block is { type: string; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");

    const usage = isRecord(json.usage) ? json.usage : {};
    return {
      text,
      usage: {
        tokensIn: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
        tokensOut: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
      },
    };
  }

  private async callOpenAiCompatible(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: this.config.modelName,
        temperature: 0,
        max_tokens: request.maxOutputTokens,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await safeReadText(res);
      throw new ModelAdapterError(`openai-compatible api returned ${res.status}: ${truncate(body, 500)}`);
    }

    const json: unknown = await res.json();
    if (!isRecord(json) || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new ModelAdapterError("openai-compatible api response missing choices[]");
    }

    const choices = json.choices as unknown[];
    const first: unknown = choices[0];
    const message = isRecord(first) ? first.message : undefined;
    const text = isRecord(message) && typeof message.content === "string" ? message.content : "";

    const usage = isRecord(json.usage) ? json.usage : {};
    return {
      text,
      usage: {
        tokensIn: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
        tokensOut: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
      },
    };
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
