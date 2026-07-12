export class ModelAdapterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelAdapterError";
  }
}

export class ModelTimeoutError extends ModelAdapterError {
  constructor(timeoutMs: number) {
    super(`model call exceeded ${timeoutMs}ms`);
    this.name = "ModelTimeoutError";
  }
}

export type { ModelAdapter, ModelRequest, ModelResponse, ModelUsage } from "../types.js";
