/** Deep, key-sorted clone used to produce a stable JSON string for arbitrary values. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Produces a bounded, stable-key-order string signature for an arbitrary
 * tool_input value, used both as the near-duplicate-detection comparison
 * text and as the audit value stored in `trigger_event.input_sig`.
 * Key order in JSON.stringify output is otherwise insertion-order and would
 * make two semantically-identical inputs compare as dissimilar if the model
 * (or tool) ever emits keys in a different order.
 */
export function canonicalizeToolInput(input: unknown, maxChars = 2000): string {
  let text: string;
  try {
    text = JSON.stringify(sortKeysDeep(input)) ?? "null";
  } catch {
    try {
      text = String(input);
    } catch {
      text = "";
    }
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
