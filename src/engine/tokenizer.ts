/**
 * Conservative token estimator. This project ships with zero runtime
 * dependencies, so rather than pull in a model-specific tokenizer package
 * for a single bounds check, the reminder length cap uses a documented
 * heuristic: the larger of a whitespace word count and
 * `ceil(characters / 4)` (the commonly cited rough English-text ratio for
 * GPT/Claude-family tokenizers). Taking the max, not the average, is the
 * "conservative" part — dense or unusually long tokens (URLs, identifiers,
 * non-English text, punctuation-heavy text) tend to tokenize to *more*
 * pieces per character or per word than plain English prose, so biasing
 * the estimate upward makes the cap harder, not easier, to satisfy. See
 * README "Token accounting" for the rationale and its known imprecision.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const charEstimate = Math.ceil(trimmed.length / 4);
  return Math.max(wordCount, charEstimate);
}
