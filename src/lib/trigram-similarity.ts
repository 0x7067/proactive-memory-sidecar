/**
 * Character-trigram Jaccard similarity — the same algorithm PostgreSQL's
 * `pg_trgm` extension uses for fuzzy text matching. Deterministic, requires
 * no model call and no dependency, and is used for two independent
 * purposes in this project: near-identical-repeated-tool-call detection
 * (`src/trigger/near-duplicate.ts`) and reminder-redundancy suppression
 * (`src/engine/guards.ts`).
 */

function trigramSet(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return new Set();
  if (normalized.length < 3) return new Set([normalized]);

  const grams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

/**
 * Jaccard similarity (|intersection| / |union|) over the character-trigram
 * sets of `a` and `b`. Returns a value in [0, 1]. Two empty/degenerate
 * (< 3 char) equal-after-normalization strings are treated as identical
 * (similarity 1); one empty and one non-empty are treated as maximally
 * dissimilar (similarity 0).
 */
export function trigramSimilarity(a: string, b: string): number {
  const setA = trigramSet(a);
  const setB = trigramSet(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
