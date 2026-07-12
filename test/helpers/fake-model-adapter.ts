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
