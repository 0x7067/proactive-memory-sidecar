import type { DatabaseSync } from "node:sqlite";
import { trigramSimilarity } from "../lib/trigram-similarity.js";
import { getRecentToolCalls } from "../store/trigger-event-store.js";

/**
 * True when the current call's canonicalized input is a near-identical
 * match (trigram similarity strictly above `threshold`) to any of the last
 * `window` prior calls to the same tool in this session. Compares against
 * `trigger_event` (our own synchronously-written log), not the transcript
 * file, because the transcript is written asynchronously and may lag the
 * event that is currently firing (see the Claude Code hooks reference).
 */
export function isNearDuplicateToolCall(
  db: DatabaseSync,
  sessionId: string,
  toolName: string,
  inputSig: string,
  window: number,
  threshold: number,
): boolean {
  const recent = getRecentToolCalls(db, sessionId, toolName, window);
  for (const call of recent) {
    if (!call.input_sig) continue;
    if (trigramSimilarity(inputSig, call.input_sig) > threshold) return true;
  }
  return false;
}
