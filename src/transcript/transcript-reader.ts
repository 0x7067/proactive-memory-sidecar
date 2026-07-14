import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isRecord } from "../lib/type-guards.js";

export type TranscriptRole = "user" | "assistant" | "tool" | "other";

export interface TranscriptMessage {
  role: TranscriptRole;
  text: string;
}

const MAX_MESSAGE_CHARS = 800;
/** Successive tail-read window sizes tried until `k` messages are found or the file start is reached. */
const READ_WINDOWS_BYTES = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated]`;
}

/**
 * Condenses one Anthropic-API-shaped `content` value (string, or an array of
 * content blocks) down to a single bounded human-readable string. Unknown
 * block shapes degrade to a short placeholder instead of being dropped
 * silently, so the model prompt still shows "something happened here".
 */
function condenseContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === "string" ? block.type : undefined;
    switch (type) {
      case "text":
      case "input_text":
      case "output_text":
        if (typeof block.text === "string") parts.push(block.text);
        break;
      case "thinking":
        // Deliberately condensed, not omitted: the model should know reasoning happened
        // here without us re-injecting potentially large chain-of-thought text.
        parts.push("[thinking]");
        break;
      case "tool_use": {
        const name = typeof block.name === "string" ? block.name : "unknown_tool";
        // Tool arguments can contain commands, credentials, and provider data.
        // The provider prompt only needs the structural fact that a tool ran.
        parts.push(`[tool_use ${name}]`);
        break;
      }
      case "tool_result": {
        const isError = block.is_error === true;
        parts.push(`[tool_result${isError ? " (error)" : ""}]`);
        break;
      }
      case "image":
        parts.push("[image]");
        break;
      default:
        parts.push(`[${type ?? "unknown_block"}]`);
    }
  }
  return parts.join("\n");
}

function normalizeRole(role: unknown): TranscriptRole {
  if (role === "user" || role === "assistant" || role === "tool") return role;
  return "other";
}

/**
 * Normalizes one parsed JSONL line into a TranscriptMessage, or null if the
 * line does not represent a conversational turn (summaries, snapshots,
 * meta records, or anything unrecognized).
 *
 * Handles the nested Claude Code transcript shape
 * (`{ type: "user"|"assistant", message: { role, content } }`) and a
 * flattened `{ role, content }` shape, plus Codex rollout message records
 * (`{ type: "response_item", payload: { type: "message", role, content } }`).
 * Codex tool-call and tool-output response items are intentionally skipped:
 * their raw arguments/output have already crossed a tool boundary and are not
 * needed in a provider prompt. The exact
 * internal transcript format is not a documented, versioned contract.
 */
function normalizeLine(parsed: unknown): TranscriptMessage | null {
  if (!isRecord(parsed)) return null;

  if (parsed.type === "response_item") {
    if (!isRecord(parsed.payload) || parsed.payload.type !== "message") return null;
    if (parsed.payload.role !== "user" && parsed.payload.role !== "assistant") return null;
    const text = condenseContent(parsed.payload.content).trim();
    if (text === "") return null;
    return { role: parsed.payload.role, text: truncate(text, MAX_MESSAGE_CHARS) };
  }

  // Nested shape: { type: "user" | "assistant", message: { role, content } }
  const outerType = typeof parsed.type === "string" ? parsed.type : undefined;
  if (outerType && !["user", "assistant"].includes(outerType)) {
    // summary / system / file-history-snapshot / meta / anything else: not a turn.
    if (!isRecord(parsed.message)) return null;
  }

  const messageContainer = isRecord(parsed.message) ? parsed.message : parsed;
  const role = normalizeRole(messageContainer.role ?? outerType);
  if (!("content" in messageContainer)) return null;

  const text = condenseContent(messageContainer.content).trim();
  if (text === "") return null;

  return { role, text: truncate(text, MAX_MESSAGE_CHARS) };
}

function parseLinesFromEnd(buf: Buffer, discardFirstPartialLine: boolean): string[] {
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  // The read window may start mid-line; the first fragment is unusable unless
  // we happened to read from byte 0 of the file.
  if (discardFirstPartialLine && lines.length > 0) {
    lines.shift();
  }
  return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Reads the last `k` conversational messages from a Claude Code transcript
 * JSONL file, tail-first (only the trailing window of the file is read,
 * growing the window geometrically until enough valid messages are found or
 * the file start is reached — this stays fast on multi-megabyte
 * transcripts). Fails open: a missing file, unreadable file, empty file, or
 * fully-malformed content all resolve to `[]` rather than throwing.
 */
export function readTranscriptTail(transcriptPath: string | undefined | null, k: number): TranscriptMessage[] {
  if (!transcriptPath || k <= 0) return [];

  try {
    if (!existsSync(transcriptPath)) return [];
    const size = statSync(transcriptPath).size;
    if (size <= 0) return [];

    let fd: number;
    try {
      fd = openSync(transcriptPath, "r");
    } catch {
      return [];
    }

    try {
      let bestEffort: TranscriptMessage[] = [];

      for (const window of READ_WINDOWS_BYTES) {
        const readSize = Math.min(window, size);
        const start = size - readSize;
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, start);

        const lines = parseLinesFromEnd(buf, start > 0);
        const messages: TranscriptMessage[] = [];
        for (let i = lines.length - 1; i >= 0 && messages.length < k; i--) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(lines[i] as string);
          } catch {
            continue;
          }
          const normalized = normalizeLine(parsed);
          if (normalized) messages.push(normalized);
        }

        bestEffort = messages;
        if (messages.length >= k || start === 0) {
          return messages.reverse();
        }
        // Otherwise widen the window and retry.
      }
      // Exhausted every window size (file larger than our largest window)
      // without reaching the file start or filling the quota: return
      // whatever the widest window found rather than discarding it.
      return bestEffort.reverse();
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}
