import type { TranscriptMessage } from "../transcript/transcript-reader.js";
import type { EntryRow, HandledHookEventName, TriggerReason } from "../types.js";

export interface PromptToolEvent {
  toolName: string | null;
  toolInput: unknown;
  toolResponse: unknown;
  error: string | null;
}

export interface PromptContext {
  hookEvent: HandledHookEventName;
  step: number;
  cadenceN: number;
  triggerReason: TriggerReason;
  forced: boolean;
  phase2Eligible: boolean;
  sessionStatus: string;
  bankCap: number;
  liveEntries: readonly EntryRow[];
  transcriptTail: readonly TranscriptMessage[];
  toolEvent: PromptToolEvent;
  reminderMaxTokens: number;
  cooldownSteps: number;
  similarityThreshold: number;
}

function safeJson(value: unknown, max = 1200): string {
  try {
    const s = JSON.stringify(value, null, 0) ?? "null";
    return s.length > max ? `${s.slice(0, max)}…(truncated)` : s;
  } catch {
    return "«unserializable»";
  }
}

function renderBank(entries: readonly EntryRow[], cap: number): string {
  if (entries.length === 0) {
    return `(bank is empty — 0/${cap} live entries)`;
  }
  const lines = entries.map((e) => {
    const cooldownInfo =
      e.last_injected_step === null
        ? "never injected"
        : `last injected at step ${e.last_injected_step} (injected ${e.inject_count}x total)`;
    return `- id="${e.id}" kind=${e.kind} created_step=${e.created_step} updated_step=${e.updated_step} (${cooldownInfo})\n  content: ${e.content}`;
  });
  return `(${entries.length}/${cap} live entries)\n${lines.join("\n")}`;
}

function renderTranscript(messages: readonly TranscriptMessage[]): string {
  if (messages.length === 0) return "(no transcript messages available)";
  return messages.map((m) => `[${m.role}] ${m.text}`).join("\n---\n");
}

function renderToolEvent(hookEvent: HandledHookEventName, toolEvent: PromptToolEvent): string {
  if (hookEvent === "PreCompact") {
    return "(no single tool call — this is a pre-compaction maintenance sweep over the whole recent trajectory)";
  }
  const lines = [
    `tool_name: ${toolEvent.toolName ?? "(unknown)"}`,
    `tool_input: ${safeJson(toolEvent.toolInput)}`,
  ];
  if (hookEvent === "PostToolUseFailure") {
    lines.push(`error: ${toolEvent.error ?? "(no error message provided)"}`);
  } else {
    lines.push(`tool_response: ${safeJson(toolEvent.toolResponse)}`);
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are the memory-maintenance and selective-intervention module for a coding agent, running as a sidecar alongside an unmodified action agent (you never talk to the user directly, and the action agent does not know you exist as a separate process). Your job has exactly two phases, both answered in a single response:

PHASE 1 — Bank maintenance. Decide whether the session's structured memory bank needs to change given what just happened. The bank holds short, durable facts ("knowledge") and short procedural observations ("procedural", e.g. prior attempts and their outcomes) that will keep being useful later in this same session, plus a short free-text session status. Only record things worth remembering past this step: stable requirements, constraints, prior failures/successes, environment facts. Do not record routine, self-evident, or already-redundant information.

Emit zero or more operations, in the exact order you want them applied, as a JSON array inside a <bank_ops> block:
<bank_ops>
[{"op":"save_knowledge","id":"short-slug","content":"..."},
 {"op":"save_procedural","id":"short-slug","content":"..."},
 {"op":"delete","id":"short-slug"},
 {"op":"update_status","status":"..."}]
</bank_ops>

Rules for PHASE 1:
- Accepted "op" values are exactly: update_status, save_knowledge, save_procedural, delete. Anything else is dropped.
- "id" is a short, stable, kebab-ish slug you choose and MAY reuse later to update or delete the same entry (e.g. "req:ipv4-octets", "proc:regex-fail-14"). Reusing an existing id updates that entry in place; it does not create a duplicate and does not cost bank capacity.
- The bank has a hard cap of live (non-deleted) entries. If it is near or at capacity, delete something stale/superseded before (or as part of) adding something new — operations are applied strictly in the order you list them, so a delete must appear *before* the save it is meant to make room for.
- Use "delete" for anything superseded, resolved, or no longer relevant.
- If nothing needs to change, emit <bank_ops>[]</bank_ops>.
- Keep each entry's content short (a sentence or two).

PHASE 2 — Selective intervention. Decide whether the action agent needs a reminder right now, or whether you should stay silent. Most of the time, silence is correct — only intervene when the action agent is at real risk of repeating a mistake, ignoring a known constraint, or losing track of something already established. A good reminder restates a fact or prior observation the action agent has access to but appears to be at risk of missing; it is never advice, a suggestion, a plan, or an instruction.

Emit exactly one of:
<context_for_action grounding="id1,id2">
Reminder: <a single short, factual statement, grounded only in bank entries you cite by id>
</context_for_action>

or, when no intervention is warranted:
<no_intervention/>

Hard rules for PHASE 2 (violations are mechanically detected and discarded, degrading to silence, so follow them exactly):
- The reminder text must be <= ${100} tokens (roughly ${75} words) — keep it to one or two short sentences.
- "grounding" must be a comma-separated list of one or more bank entry ids that exist after your PHASE 1 edits are applied (including ones you just saved in this same response) — every id must be real and non-empty.
- State facts or prior observations only ("the regex was already observed failing on step 14", "the task requires single-digit octets"). Never phrase it as advice, a suggestion, or a command ("you should", "make sure to", "try", "fix", or any sentence that starts with a bare imperative verb) — those are mechanically rejected.
- Never include a wall-clock date or time, or phrases like "right now"/"just now" — only reference the bank's own step numbers, which are stable across session replay. Wall-clock references are mechanically rejected.
- If you already reminded the agent of essentially the same thing recently, prefer <no_intervention/> — near-duplicate reminders are mechanically suppressed anyway.

Respond with the <bank_ops> block followed immediately by either the <context_for_action> block or <no_intervention/>, and nothing else — no other prose, no markdown fences.`;

export function buildPrompt(ctx: PromptContext): { system: string; user: string } {
  const phase2Instruction = ctx.phase2Eligible
    ? "This step is eligible for Phase 2. Decide normally between <context_for_action> and <no_intervention/>."
    : "This step is a PreCompact maintenance sweep: Phase 2 will be ignored no matter what you write, but still end your response with <no_intervention/> for a well-formed reply.";

  const user = `## Trigger
hook_event: ${ctx.hookEvent}
step: ${ctx.step} (cadence: every ${ctx.cadenceN} PostToolUse-family calls)
trigger_reason: ${ctx.triggerReason}${ctx.forced ? " (forced: bypasses the per-entry cooldown, but not the other guards)" : ""}
${phase2Instruction}

## Current tool event
${renderToolEvent(ctx.hookEvent, ctx.toolEvent)}

## Session status (free text you maintain via update_status)
${ctx.sessionStatus === "" ? "(empty)" : ctx.sessionStatus}

## Current memory bank
${renderBank(ctx.liveEntries, ctx.bankCap)}

## Recent transcript (oldest first, condensed)
${renderTranscript(ctx.transcriptTail)}

## Reminder constraints for this call
max tokens: ${ctx.reminderMaxTokens}, per-entry cooldown: ${ctx.cooldownSteps} steps (bypassed only because this trigger is forced: ${ctx.forced})

Respond now with PHASE 1 then PHASE 2, following the format exactly.`;

  return { system: SYSTEM_PROMPT, user };
}
