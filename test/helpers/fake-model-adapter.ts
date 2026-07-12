import type { ModelAdapter, ModelRequest, ModelResponse } from "../../src/types.js";

export type FakeResponse = ModelResponse | Error | string;

function normalize(r: FakeResponse): ModelResponse | Error {
  if (typeof r === "string") {
    return { text: r, usage: { tokensIn: 123, tokensOut: 45 } };
  }
  return r;
}

/**
 * Deterministic, in-process fake used by every test that exercises the
 * engine — no real API calls are made anywhere in this test suite. Records
 * every request it receives so tests can assert whether/how many times the
 * model was actually called (e.g. "no model call on fast-path non-triggers").
 */
export class FakeModelAdapter implements ModelAdapter {
  public readonly calls: ModelRequest[] = [];
  private readonly responses: Array<ModelResponse | Error>;
  private index = 0;

  constructor(responses: FakeResponse[] = ["<bank_ops>[]</bank_ops>\n<no_intervention/>"]) {
    this.responses = responses.map(normalize);
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const next = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    if (next instanceof Error) return Promise.reject(next);
    if (!next) return Promise.reject(new Error("FakeModelAdapter: no response configured"));
    return Promise.resolve(next);
  }
}

/**
 * A `ModelAdapter` whose `.complete()` calls resolve only when the test
 * explicitly settles them, in whatever order the test chooses — used to
 * deterministically reproduce two concurrent hook invocations whose model
 * calls *complete* out of order relative to the order they *started* in,
 * without relying on real timers/sleeps (see the "concurrency" suite in
 * test/engine/engine.test.ts).
 */
export class DeferredModelAdapter implements ModelAdapter {
  public readonly calls: ModelRequest[] = [];
  private readonly pending: Array<(r: ModelResponse | Error) => void> = [];

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    return new Promise((resolve, reject) => {
      this.pending.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
    });
  }

  /** Settles the Nth (0-indexed, in call-arrival order) still-pending call. */
  settle(index: number, response: FakeResponse): void {
    const resolver = this.pending[index];
    if (!resolver) {
      throw new Error(`DeferredModelAdapter: no pending call at index ${index}`);
    }
    resolver(normalize(response));
  }
}
