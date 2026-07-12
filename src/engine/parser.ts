import { isRecord } from "../lib/type-guards.js";
import type { ParsedModelResponse, ParsedOpEntry, Phase2Raw } from "../types.js";

export interface ParseLimits {
  entryIdMaxChars: number;
  entryContentMaxChars: number;
  statusMaxChars: number;
}

/**
 * Phase 1 wire format (this project's own design — the brief specifies
 * Phase 2's tags exactly but leaves Phase 1's syntax to the implementation):
 *
 *   <bank_ops>
 *   [{"op":"save_knowledge","id":"req:ipv4-octets","content":"..."},
 *    {"op":"delete","id":"proc:old-approach"}]
 *   </bank_ops>
 *
 * An empty or absent block means "no bank edits this step", which is a
 * normal, non-error outcome.
 */
const BANK_OPS_BLOCK_RE = /<bank_ops>([\s\S]*?)<\/bank_ops>/i;

/** Phase 2 wire format — reproduced exactly as mandated by the design brief. */
const NO_INTERVENTION_RE = /<no_intervention\s*\/>/i;
const CONTEXT_FOR_ACTION_RE =
  /<context_for_action(?:\s+grounding="([^"]*)")?\s*>([\s\S]*?)<\/context_for_action>/i;

function truncateForAudit(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function validateOp(item: unknown, limits: ParseLimits): ParsedOpEntry {
  if (!isRecord(item)) {
    return { valid: false, raw: item, reason: "op entry is not an object" };
  }

  const op = item.op;

  if (op === "update_status") {
    const status = item.status;
    if (typeof status !== "string") {
      return { valid: false, raw: item, reason: "update_status.status must be a string" };
    }
    if (status.length > limits.statusMaxChars) {
      return { valid: false, raw: item, reason: `status exceeds ${limits.statusMaxChars} chars` };
    }
    return { valid: true, op: { op: "update_status", status } };
  }

  if (op === "save_knowledge" || op === "save_procedural") {
    const id = item.id;
    const content = item.content;
    if (typeof id !== "string" || id.trim() === "") {
      return { valid: false, raw: item, reason: `${op}.id must be a non-empty string` };
    }
    if (id.trim().length > limits.entryIdMaxChars) {
      return { valid: false, raw: item, reason: `id exceeds ${limits.entryIdMaxChars} chars` };
    }
    if (typeof content !== "string" || content.trim() === "") {
      return { valid: false, raw: item, reason: `${op}.content must be a non-empty string` };
    }
    if (content.trim().length > limits.entryContentMaxChars) {
      return { valid: false, raw: item, reason: `content exceeds ${limits.entryContentMaxChars} chars` };
    }
    return { valid: true, op: { op, id: id.trim(), content: content.trim() } };
  }

  if (op === "delete") {
    const id = item.id;
    if (typeof id !== "string" || id.trim() === "") {
      return { valid: false, raw: item, reason: "delete.id must be a non-empty string" };
    }
    return { valid: true, op: { op: "delete", id: id.trim() } };
  }

  return { valid: false, raw: item, reason: `unrecognized op type ${JSON.stringify(op)}` };
}

function parseBankOps(raw: string, limits: ParseLimits): ParsedOpEntry[] {
  const match = BANK_OPS_BLOCK_RE.exec(raw);
  if (!match) return [];

  const inner = (match[1] ?? "").trim();
  if (inner === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return [{ valid: false, raw: truncateForAudit(inner), reason: "bank_ops block is not valid JSON" }];
  }

  if (!Array.isArray(parsed)) {
    return [{ valid: false, raw: truncateForAudit(inner), reason: "bank_ops block is not a JSON array" }];
  }

  return parsed.map((item) => validateOp(item, limits));
}

function parsePhase2(raw: string): Phase2Raw {
  const noIntervention = NO_INTERVENTION_RE.test(raw);
  const contextMatch = CONTEXT_FOR_ACTION_RE.exec(raw);

  if (noIntervention && contextMatch) {
    return { kind: "unparseable", reason: "both <no_intervention/> and <context_for_action> present" };
  }
  if (noIntervention) {
    return { kind: "no_intervention" };
  }
  if (contextMatch) {
    return {
      kind: "context_for_action",
      groundingRaw: contextMatch[1] ?? "",
      text: (contextMatch[2] ?? "").trim(),
    };
  }
  return { kind: "unparseable", reason: "no <no_intervention/> or <context_for_action> tag found" };
}

/**
 * Parses one raw model completion into a structured Phase 1 op list and
 * Phase 2 decision. Never throws — any structural problem is represented
 * in the return value (`opEntries[].valid === false`, or
 * `phase2.kind === "unparseable"`) for the caller to degrade gracefully.
 */
export function parseModelResponse(raw: string, limits: ParseLimits): ParsedModelResponse {
  const opEntries = parseBankOps(raw, limits);
  const phase2 = parsePhase2(raw);
  return {
    opEntries,
    phase2,
    parseError: phase2.kind === "unparseable" ? phase2.reason : null,
  };
}
