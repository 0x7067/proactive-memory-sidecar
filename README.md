# proactive-memory-sidecar

A standalone **proactive memory sidecar** for Claude Code and Codex CLI
hooks. It maintains a per-session, project-local SQLite
memory bank and selectively injects short, fact-only, bank-grounded reminders
into the action agent after tool events — or stays silent, which is the common
case. The action agent remains unmodified; the sidecar only adds optional
context through the harness's documented `additionalContext` hook mechanism.

It **fails open**: every error, timeout, or misconfiguration results in
exit code `0` and no hook output. Nothing here can block a tool call, deny
a permission, or crash a session.

Architectural reference: *["Remember When It Matters: Proactive Memory
Agent for Long-Horizon Agents"](https://huggingface.co/papers/2607.08716)*
(Wu et al., Meta AI, 2026), which reports pass@1 gains of **+8.3 pp on
Terminal-Bench 2.0** and **+6.8 pp on τ²-Bench** from this two-phase
architecture. See ["Alignment with the paper"](#alignment-with-the-paper-vs-deviations)
below for exactly what this implementation reproduces and where it
deliberately diverges.

## Contents

- [How it works](#how-it-works)
- [Install](#install)
- [Model configuration](#model-configuration)
- [Privacy and data lifecycle](#privacy-and-data-lifecycle)
- [Shadow rollout](#shadow-rollout)
- [Metrics and queries](#metrics-and-queries)
- [Per-harness effectiveness gates](#per-harness-effectiveness-gates)
- [Wire formats](#wire-formats)
- [Trigger policy](#trigger-policy)
- [Mechanical guards](#mechanical-guards-the-reminder-contract)
- [Model-prompt data boundaries](#model-prompt-data-boundaries)
- [Fail-open design](#fail-open-design)
  - [Time budget](#time-budget)
- [Concurrency model](#concurrency-model)
- [Kill switch](#kill-switch)
- [Limitations](#limitations)
- [Alignment with the paper vs deviations](#alignment-with-the-paper-vs-deviations)
- [Development](#development)

## How it works

Claude Code fires a **PostToolUse**, **PostToolUseFailure**, or
**PreCompact** hook. Each invocation runs the same compiled CLI
(`dist/src/bin/hook.js`) as a fresh subprocess: it reads the hook's JSON
payload from stdin, does its work against a project-local SQLite database,
and prints either nothing or one line of JSON to stdout before exiting 0.

Per invocation, in order:

1. **Kill switch check.** If `PMS_ENABLED=0`, exit immediately — no stdin
   read past this point, no database touched.
2. **Subagent check.** If the payload carries an `agent_id` (i.e. this
   event fired inside a subagent call, not the main thread), skip
   entirely — no bookkeeping, no logging.
3. **Provider-egress preflight.** Classify the current tool event before
   prompt construction. Known external/networked operations and ambiguous
   shell syntax force sidecar silence and zero provider requests while the
   action agent continues normally. Eligible events become a minimal
   structured summary; raw command, arguments, output, and errors are not
   forwarded or persisted.
4. **Trigger policy.** Decide whether this event is *forced* (tool
   failure, or a near-identical repeat of a recent tool call), a *cadence*
   hit (every `PMS_CADENCE_N`th **successful `PostToolUse`** call, default
   4 — `PostToolUseFailure` and `PreCompact` never count towards this and
   never shift which call lands on the Nth tick), a *PreCompact sweep*
   (always runs, Phase 1 only), or none of the above (the common "fast
   path" — no model call at all).
5. **Phase 1 — bank maintenance** (only on a trigger). One model call
   returns an ordered list of bank operations
   (`update_status` / `save_knowledge` / `save_procedural` / `delete`),
   applied transactionally with a 60-live-entry cap (configurable).
6. **Phase 2 — selective intervention** (only on a trigger with Phase 2
   eligibility — PreCompact never has it). The *same* model response also
   contains either a grounded reminder or an explicit "no intervention"
   decision. The reminder is mechanically validated against six guards
   (below) before it is ever trusted; any violation degrades to silence.
7. **Log and emit.** Every decision — triggered or not, reminder or
   silence — is written to `intervention_log`. In **live** mode, an
   accepted reminder is printed as
   `{"hookSpecificOutput":{"hookEventName":...,"additionalContext":...}}`.
   In **shadow** mode (the default), it is logged but never printed.

```
stdin (hook JSON)  ──▶ egress preflight ──▶ [denied/ambiguous] ──▶ silence, zero provider calls
                              │ [eligible: structured summary only]
                              ▼
                       trigger policy ──▶ [not triggered] ──▶ log "silence", exit 0
                              │
                              ▼ [triggered]
                    build prompt from: current bank state (SQLite)
                                     + last k=8 transcript messages
                                     + a content-minimized event summary
                              │
                              ▼
                    one model call ──▶ parse Phase 1 ops + Phase 2 decision
                              │
                              ▼
              apply Phase 1 ops (transactional, cap-enforced)
                              │
                              ▼
         validate Phase 2 candidate against the now-current bank
         through 6 mechanical guards ──▶ [reject] ──▶ log "silence"
                              │
                              ▼ [accept]
                    log "reminder" ──▶ shadow? stay silent on stdout
                                    : live?   print additionalContext JSON
```

## Install

See **[`hooks/README.md`](hooks/README.md)** for the standalone walkthrough,
exact project-scoped hook blocks, retention, and the reversible rollout gates.
Short version:

```bash
npm install && npm run build              # produces dist/src/bin/hook.js
```

Then merge [`hooks/settings.example.json`](hooks/settings.example.json) into a
target project and replace its absolute-path placeholder. The hook command
points directly at this checkout. No agentctl installation, wrapper,
configuration, or deployment layer belongs in this path.

### Codex CLI

Codex uses the same stdin JSON and `additionalContext` output contract, but
registers command hooks in `<project>/.codex/hooks.json`. Copy
[`hooks/codex.hooks.example.json`](hooks/codex.hooks.example.json), replace
`/absolute/path/to/proactive-memory-sidecar` with this checkout's absolute
path. Both harnesses use the same project-local default database:

```bash
mkdir -p /path/to/your/project/.codex
cp /path/to/proactive-memory-sidecar/hooks/codex.hooks.example.json \
  /path/to/your/project/.codex/hooks.json
# Edit .codex/hooks.json and replace the placeholder absolute path.
# Default storage: /path/to/your/project/.proactive-memory/bank.sqlite3
```

The template attaches to Codex `PostToolUse` and `PreCompact`. Codex reports
both successful and unsuccessful supported tool calls through `PostToolUse`;
the sidecar recognizes `exit_code` / `exitCode`, `success: false`, and
`is_error: true` response signals as a forced failure trigger while preserving
`PostToolUse` in its output. This keeps Codex's hook wire format valid and
ensures failures do not advance the successful-call cadence counter.

The zero-reminder audit did not fail in the trigger, provider parser, bank-op
application, guards, or stdout contract. All 47 Codex provider responses
parsed as `no_intervention`. The defect was prompt construction:
`transcript-reader.ts` recognized Claude message records but ignored Codex
rollout `response_item` messages, leaving Codex without its recent trajectory.
The reader now accepts Codex user/assistant message items while omitting tool
call arguments and outputs. Cadence remains unchanged.

Codex requires project-local command hooks to be reviewed and trusted. Open
`/hooks` in Codex to review and trust the copied hook definition before use.
See the [Codex hooks documentation](https://developers.openai.com/codex/hooks)
for config-layer and trust behavior.

## Model configuration

The sidecar calls a model at most once per triggered step, and not at all
on the fast path. There is no bundled/hosted default — you must configure
a provider and, for a real provider, an API key. Until an API key is
configured every triggered step fails open (harmless, but inert).

| Variable | Default | Notes |
|---|---|---|
| `PMS_MODEL_PROVIDER` | `anthropic` | `anthropic` (native Messages API) or `openai` (OpenAI-compatible chat completions — OpenAI itself, Azure OpenAI, or a local/self-hosted server speaking the same wire format) |
| `PMS_MODEL_API_KEY` | *(unset)* | Falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` depending on provider |
| `PMS_MODEL_BASE_URL` | provider default | Override for a proxy, Azure, or a local server |
| `PMS_MODEL_NAME` | `claude-haiku-4-5` (anthropic) / `gpt-4.1-mini` (openai) | See below |
| `PMS_MODEL_MAX_OUTPUT_TOKENS` | `900` | Output budget for one Phase 1 + Phase 2 response |
| `PMS_MODEL_TIMEOUT_MS` | `15000` | Clamped to `[1000, 15000]` — **15000 is a hard, non-overridable ceiling** enforced in config loading, again inside the HTTP adapter's `AbortController`, and a third time dynamically against whatever remains of the single overall deadline below (so it is effectively often *less* than 15000 in practice) |

**Time budget.** The sidecar's contract is a **15-second-or-less whole
invocation**, not just a 15-second model call — see ["Time
budget"](#time-budget) for exactly how one deadline is threaded through
stdin, SQLite, and the model call, and its one honestly-documented limit.

| Variable | Default | Notes |
|---|---|---|
| `PMS_OVERALL_TIMEOUT_MS` | `15000` | Clamped to `[PMS_MODEL_TIMEOUT_MS, 15000]` — **15000 is a hard, non-overridable ceiling** on the entire hook invocation (stdin + DB + model), enforced once in config loading and again dynamically via `src/lib/deadline.ts` |
| `PMS_STDIN_TIMEOUT_MS` | `5000` | Clamped to `[100, 60000]`, but further capped at runtime to whatever remains of `PMS_OVERALL_TIMEOUT_MS` |
| `PMS_BUSY_TIMEOUT_MS` | `5000` | Clamped to `[0, 60000]`, but the `busy_timeout` PRAGMA actually applied to each connection is further capped at runtime to whatever remains of `PMS_OVERALL_TIMEOUT_MS` — see ["Concurrency model"](#concurrency-model) |

**On the default model.** The reference paper uses an Opus-tier model as
the memory agent against Sonnet/Opus-tier action agents, and its own
ablation (fine-tuning a 27B open-weight policy, §4.5) shows that
calibration quality scales with memory-agent capability. This sidecar
defaults to a small, fast, cheap model instead, because it runs
synchronously inside the action agent's own tool-call loop — every
triggered step is latency the user waits through. If you want closer
parity with the paper's reported gains and can accept the added latency
and cost, set `PMS_MODEL_NAME` to a stronger model (e.g. a Sonnet-tier or
Opus-tier one). This is a deliberate default-tuning choice, not a
correctness constraint.

**No external hosted service is required or contacted by this project
itself.** You must supply your own model endpoint and credentials — the
sidecar makes outbound HTTPS calls only to the provider you configure, and
makes none at all until you do.

## Privacy and data lifecycle

- **Project-local, not global.** The database lives at
  `<project>/.proactive-memory/bank.sqlite3` by default (override with
  `PMS_DB_PATH` or `PMS_DB_RELATIVE_PATH`) — one SQLite file per project,
  never a machine-wide or home-directory store. The sidecar enforces mode
  `700` on the containing directory and mode `600` on the database whenever
  it opens it. Add `.proactive-memory/` to the project's `.gitignore`.
- **Per-session isolation, single shared file.** All sessions for a
  project live in the same database file, isolated by `session_id`
  (composite primary keys throughout). A session's bank is never read by,
  or written into, another session's rows.
- **Ephemeral by design, not by mechanism.** "Ephemeral" here means
  *scoped to the session's working relevance*, not "in-memory only" — it
  is durable SQLite so it survives a `--resume`/`--continue`. There is no
  cross-session sharing: nothing here becomes a persistent user-memory
  product. Old sessions accumulate until pruned.
- **Retention tooling is real, not aspirational.** `pms-maintain` (built
  alongside the hook CLI, at `dist/src/bin/maintain.js`) deletes sessions
  — and every row referencing them, across all tables — older than a
  configurable age:

  ```bash
  node dist/src/bin/maintain.js --cwd /path/to/project --older-than-days 30 --dry-run
  node dist/src/bin/maintain.js --cwd /path/to/project --older-than-days 30
  node dist/src/bin/maintain.js --cwd /path/to/project --older-than-days 30 --vacuum
  ```

  Wire it to a cron/scheduled task if you want automatic pruning; nothing
  in this repository schedules it for you.
- **Provider-egress preflight.** `src/privacy/provider-egress.ts` runs before
  prompt construction. It follows environment assignments; `env`, `sudo`,
  `command`, and absolute-path wrappers; nested `bash`/`sh`/`zsh -c`;
  pipelines and compound commands; command substitutions; and executable
  subcommands. It denies external-service, network, credential, database,
  infrastructure, browser, and messaging operations. The deny set includes
  Railway, GitHub CLI, curl/wget/SSH, Notion, Slack, Linear, PostgreSQL/MySQL,
  Docker/Kubernetes, AWS/GCP/Azure, and their direct tool equivalents.
  Ambiguous syntax receives the same privacy result: action-agent execution
  remains fail-open, the sidecar emits nothing, and no provider request occurs.
- **Git is classified by operation.** Local operations such as `status`,
  `diff`, `log`, `add`, and `commit` may reach the trigger policy. `push`,
  `fetch`, `pull`, `clone`, `ls-remote`, remote operations, credential
  operations, and submodule network access do not.
- **Raw tool payloads do not leave or persist.** The prompt receives only
  `toolName`, `eventKind`, `outcome`, `commandCount`, the executable names,
  local Git operation names, and four booleans for pipeline, compound-command,
  nested-shell, and command-substitution presence. Arguments, environment
  names and values, paths, command text, tool output, and error text are absent.
  `trigger_event.input_sig` stores only a SHA-256 fingerprint for repeat
  detection. The schema-v3 migration clears legacy raw signatures, errors,
  session status, bank entries, and stored reminder text once so an upgraded
  database cannot resend content captured before this boundary existed.
- **Every field that may leave the machine.** A provider request contains the
  selected model name, output-token/timeout settings, the fixed system prompt,
  and a user prompt containing: hook event, step, cadence, trigger reason,
  forced/eligibility flags; the structured event fields listed above; session
  status; bank entry id/kind/content and step/injection metadata; up to
  `PMS_TRANSCRIPT_TAIL_K` user/assistant message roles and text, each capped at
  800 characters; bank cap, reminder cap, and cooldown. Provider credentials
  leave only as the HTTP authentication header. Claude tool arguments/results
  and Codex tool-call/output rollout records are reduced to structural markers
  or omitted before prompt construction.
- **No other egress.** The sidecar sends no telemetry or analytics and calls no
  endpoint other than the configured model provider. That provider call is
  external processing even in shadow mode.
- **No timestamps in what gets remembered.** Bank entries and reminders
  are written to reference the session's own step counter ("at step 14"),
  never wall-clock time — see ["Wire formats"](#wire-formats) and
  ["Mechanical guards"](#mechanical-guards-the-reminder-contract). This
  matters for resume/replay: a reminder that said "3 minutes ago" would be
  actively misleading if replayed hours later; "at step 14" stays true.

## Shadow rollout

`PMS_MODE` defaults to `shadow`. Shadow mode is not a privacy mode: the entire pipeline
runs for real — trigger policy, the model call, Phase 1 bank writes, all
six Phase 2 guards — and every decision is logged to `intervention_log`
exactly as it would be live, including the `shadow` flag on each row. The
only difference is the last step: a `shadow=1` `reminder` decision is
never printed to stdout, so the action agent's behavior is completely
unaffected.

Use it only as a consented effectiveness canary before the sidecar can
influence the action agent:

```sql
-- Reminder rate and shadow/live split for a project's most recent session
SELECT shadow, decision, count(*) FROM intervention_log GROUP BY shadow, decision;
```

Flip `PMS_MODE=live` once you're satisfied with what you see in shadow
logs. There is no separate "promote to live" step beyond changing that one
environment variable — the historical shadow log stays as an audit trail.

## Metrics and queries

All of the following run against `<project>/.proactive-memory/bank.sqlite3`
with any SQLite client (`sqlite3 bank.sqlite3`, DB Browser for SQLite,
`node -e "require('node:sqlite')..."`, etc.). The database ships with the
JSON1 extension available (confirmed against the bundled `node:sqlite`
SQLite build), used below via `json_each`.

```sql
-- Overall decision breakdown for one session
SELECT decision, shadow, count(*) AS n
FROM intervention_log
WHERE session_id = 'YOUR_SESSION_ID'
GROUP BY decision, shadow;

-- Why did steps end in silence? (trigger reason x phase2 outcome)
SELECT trigger_reason, phase2_outcome, count(*) AS n
FROM trigger_event
WHERE session_id = 'YOUR_SESSION_ID'
GROUP BY trigger_reason, phase2_outcome
ORDER BY n DESC;

-- Which guard rejects reminders most often, across all sessions?
SELECT phase2_outcome, count(*) AS n
FROM trigger_event
WHERE phase2_outcome LIKE 'rejected:%'
GROUP BY phase2_outcome
ORDER BY n DESC;

-- Average/worst-case latency by trigger reason (ms)
SELECT te.trigger_reason, count(*) AS n,
       avg(il.latency_ms) AS avg_ms, max(il.latency_ms) AS max_ms
FROM intervention_log il
JOIN trigger_event te USING (session_id, step)
GROUP BY te.trigger_reason;

-- Model token spend (only non-null on triggered steps)
SELECT sum(tokens_in) AS total_in, sum(tokens_out) AS total_out
FROM intervention_log
WHERE session_id = 'YOUR_SESSION_ID';

-- Most-cited bank entries (grounding ids are stored as a JSON array)
SELECT je.value AS entry_id, count(*) AS times_cited
FROM intervention_log il, json_each(il.entry_ids) je
WHERE il.decision = 'reminder'
GROUP BY je.value
ORDER BY times_cited DESC;

-- Bank cap pressure: how often does a save get rejected for being at capacity?
SELECT count(*) FROM bank_op_log WHERE applied = 0 AND reason = 'cap_exceeded';

-- Live entry count per session right now
SELECT session_id, count(*) AS live_entries
FROM entry
WHERE deleted = 0
GROUP BY session_id
ORDER BY live_entries DESC;

-- Content-free effectiveness funnel, split by harness
SELECT harness, trigger_reason, skip_reason, provider_outcome,
       parser_outcome, guard_outcome, bank_operation,
       count(*) AS steps, sum(emitted_reminder) AS emitted_reminders,
       sum(tokens_in) AS input_tokens, avg(latency_ms) AS average_latency_ms
FROM effectiveness_metric
GROUP BY harness, trigger_reason, skip_reason, provider_outcome,
         parser_outcome, guard_outcome, bank_operation;

-- Privacy invariant: this result must be zero for each harness
SELECT harness, count(*) AS violations
FROM effectiveness_metric
WHERE skip_reason LIKE 'egress_%' AND provider_outcome != 'not_called'
GROUP BY harness;
```

`trigger_event`, `bank_op_log`, `session_progress`, and
`effectiveness_metric` are additive tables
beyond the three the design brief mandates verbatim (`session`, `entry`,
`intervention_log`) — see [`src/db/schema.ts`](src/db/schema.ts) for the
full DDL and the rationale in its header comment. `session_progress`
(schema v2) holds the durable cadence counter and concurrency watermark —
see ["Trigger policy"](#trigger-policy) and ["Concurrency
model"](#concurrency-model).

`effectiveness_metric` contains categories and numbers only: trigger/skip
reason, provider/parser/guard outcome, aggregate bank-operation outcome,
emission flag, token counts, and latency. It has no command, prompt, provider
response, reminder, path, bank content, or secret column.

For a shadow canary, count accepted reminders by joining the content-bearing
decision log to the content-free harness metric; `emitted_reminder` correctly
stays zero in shadow because the hook did not emit context:

```sql
SELECT em.harness, count(*) AS accepted_shadow_reminders
FROM effectiveness_metric em
JOIN intervention_log il USING (session_id, step)
WHERE il.shadow = 1 AND il.decision = 'reminder'
GROUP BY em.harness;
```

## Per-harness effectiveness gates

[`src/effectiveness/gate.ts`](src/effectiveness/gate.ts) evaluates Claude and
Codex independently. A sample must have zero privacy violations and zero
provider calls on privacy skips, at least 20 model calls and 3 reminders, a
reminder rate of at least 10%, no more than 10 calls or 15,000 input tokens per
reminder, average latency at most 3 seconds, and maximum latency at most 5
seconds.

The recorded audit gives different results:

| Harness | Model calls | Input tokens | Reminders | Gate result |
|---|---:|---:|---:|---|
| Claude | 34 | 48,711 | 10 | Yield/token/latency thresholds pass; repeat a privacy-safe canary before re-enable |
| Codex | 47 | 63,351 | 0 | Fails; do not recommend re-enable |

`npm run benchmark:fake` exercises both pipelines and gate calculations with a
local fake adapter. It makes no provider calls and cannot authorize a real
provider rollout. Codex needs a new, explicitly approved shadow sample with the
fixed transcript reader before its real-provider gate can pass.

## Wire formats

**Phase 2 (selective intervention)** is specified exactly by the design
brief and implemented verbatim in [`src/engine/parser.ts`](src/engine/parser.ts):

```xml
<context_for_action grounding="req:ipv4-octets,proc:regex-fail-14">
Reminder: the task requires single-digit IPv4 octets to match; the current regex was already observed failing on "1.2.3.4" at step 14.
</context_for_action>
```

or, when no intervention is warranted:

```xml
<no_intervention/>
```

(This exact example traces back to the paper's own qualitative analysis
of a Terminal-Bench "regex-log" task — see
["Alignment with the paper"](#alignment-with-the-paper-vs-deviations).)

**Phase 1 (bank maintenance)** has no brief-mandated syntax, so this
project defines one: an ordered JSON array inside a `<bank_ops>` block,
using exactly the four accepted operation names, emitted in the same
model response immediately before the Phase 2 tag:

```xml
<bank_ops>
[{"op":"save_knowledge","id":"req:ipv4-octets","content":"The task requires single-digit IPv4 octets only."},
 {"op":"delete","id":"proc:old-approach"}]
</bank_ops>
<no_intervention/>
```

`op` is one of `update_status` (`{op, status}`), `save_knowledge` /
`save_procedural` (`{op, id, content}` — an upsert by `id`), or `delete`
(`{op, id}` — soft delete). Anything else is dropped (and logged in
`bank_op_log`), never applied.

**`id` is a bounded-length slug, not free text**: lowercase ASCII
letters, digits, `:`, `_`, and `-` only (`^[a-z0-9:_-]+$`), never blank,
at most `PMS_ENTRY_ID_MAX_CHARS` (default 128) characters, enforced
identically for `save_knowledge`/`save_procedural`/`delete`. An id
outside that grammar is dropped (logged in `bank_op_log` with a reason),
never sanitized or truncated into something valid — see ["Model-prompt
data boundaries"](#model-prompt-data-boundaries) for why.

**Live-mode stdout** is exactly the shape Claude Code's hook JSON output
schema expects for `additionalContext` (see the ["Add context for
Claude"](https://code.claude.com/docs/en/hooks) section of the Claude
Code hooks reference), with `hookEventName` set to whichever event fired:

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Reminder: ..."}}
```

Shadow mode and every non-reminder decision print **nothing at all** — an
empty stdout is a valid, common, correct outcome, not a degenerate case.

## Trigger policy

Implemented in [`src/trigger/trigger-policy.ts`](src/trigger/trigger-policy.ts)
(pure, unit-tested in isolation from any I/O):

| Condition | Hook event | Forced? | Phase 2 eligible? |
|---|---|---|---|
| Cadence: `successful_post_tool_use_count % PMS_CADENCE_N == 0` | `PostToolUse` | no | yes |
| Tool failure | `PostToolUseFailure` | **yes** | yes |
| Near-identical repeated call (see below) | `PostToolUse` | **yes** | yes |
| Compaction about to happen | `PreCompact` | yes | **no — mechanically forced to silence regardless of model output** |
| None of the above | `PostToolUse` | — | *(not triggered — fast path, zero model calls)* |

**Cadence counts only successful `PostToolUse` events.** The counter
behind `successful_post_tool_use_count` above
(`session_progress.post_tool_use_success_count`, a durable per-session
counter distinct from `session.step_count`) increments *only* for
`PostToolUse`; `PostToolUseFailure` and `PreCompact` never advance it. A
session that sees `PostToolUse, PostToolUse, PostToolUse, PreCompact,
PostToolUse` still fires cadence exactly on that 4th `PostToolUse` call at
`PMS_CADENCE_N=4`, not the 5th all-event step. `session.step_count` (the
mandated schema's own column) is unaffected by this and remains the
all-event chronological step used for every other ordering/audit purpose
(`entry`, `trigger_event`, `intervention_log` primary keys).

**Near-identical repeated calls** are detected against this project's own
`trigger_event` log (not the transcript file, which Claude Code documents
as written asynchronously and possibly lagging the event currently firing).
New rows store only a `sha256:` fingerprint. Shell fingerprints collapse
whitespace before hashing, so exact and whitespace-only retries match without
persisting command text. Older non-hash signatures are cleared by schema v3;
the legacy trigram comparison remains only for compatibility with an in-memory
caller that supplies a non-hash signature.

"Forced" means the trigger fires regardless of cadence, and additionally
**bypasses the per-entry cooldown guard** (but no other guard) — see next
section.

## Mechanical guards (the reminder contract)

A Phase 2 candidate is only ever emitted if it survives all six, checked
in this order (first failure short-circuits and degrades to silence,
logged as `rejected:<guard>` in `trigger_event.phase2_outcome`):

1. **Grounding** (`src/engine/guards.ts#checkGrounding`) — `grounding`
   must be non-empty, and every id in it must exist in the bank *as of
   right after this step's own Phase 1 edits were applied* (the
   "prospective bank"). A reminder may cite an entry it just created in
   the same response.
2. **Token cap** (`checkTokenCap`) — ≤100 tokens by a documented
   conservative estimator (no tokenizer package is a dependency of this
   project): `max(whitespace word count, ceil(chars / 4))`. Taking the
   larger of the two errs toward *rejecting* borderline-long text rather
   than under-counting — but it is still a heuristic, not a real
   model-specific tokenizer, and can under-count dense non-whitespace-
   delimited scripts (e.g. CJK text) or unusually long single tokens
   (URLs, hashes); the conservative bias narrows, but does not eliminate,
   that gap. `PMS_REMINDER_MAX_TOKENS` may *lower* this cap (down to 1);
   **100 is a hard, non-overridable ceiling** — configuration cannot raise
   it, enforced both when config is loaded (`src/config.ts`) and again
   inside the guard itself (`HARD_REMINDER_MAX_TOKENS`), so the cap holds
   even if some future caller ever constructs a looser `GuardContext`.
3. **No wall-clock time** (`checkNoWallClockTime`) — regex-based rejection
   of ISO dates/datetimes, slash dates, clock times, month-day-year
   phrasing, and phrases like "right now"/"just now". Step-relative
   references ("at step 14") are explicitly fine and encouraged.
4. **Factual prose, not advice** (`checkFactualProse`) — rejects modal
   advisory markers (`should`, `must`, `need to`, `make sure`, `please`,
   `try to`, …) anywhere in the text, and rejects any sentence that opens
   with a bare imperative verb (`Fix`, `Run`, `Update`, …). The paper's
   own example reminder text passes this guard; a rewritten "Fix the
   regex..." version of the same fact does not.
5. **Cooldown** (`checkCooldown`) — a cited entry that was itself cited in
   a reminder fewer than `PMS_COOLDOWN_STEPS` (default 6) steps ago
   suppresses the whole reminder, **unless this trigger is forced**
   (tool failure / near-duplicate), in which case cooldown alone is
   waived — the other five guards still apply in full.
6. **Similarity** (`checkSimilarity`) — trigram-Jaccard similarity
   strictly above `PMS_SIMILARITY_THRESHOLD` (default 0.85) against any of
   the last `PMS_SIMILARITY_HISTORY_WINDOW` (default 10) reminders logged
   for this session (shadow or live — shadow is meant to preview live
   behavior faithfully) suppresses the candidate. This one is **never**
   bypassed by a forced trigger: repeating the same reminder verbatim
   isn't more useful just because the trigger was urgent.

None of these guards make a model call — they are plain, deterministic
code, independently unit-tested (`test/engine/guards.test.ts`) against
both the paper's own example text and deliberately-adversarial inputs.

## Model-prompt data boundaries

Every prompt sent to the memory-maintenance model (`src/engine/prompt.ts`)
mixes trusted template text with untrusted bank entry content, session status,
and user/assistant transcript text. The current tool event has already passed
the provider-egress preflight and arrives as the content-minimized structure
listed in ["Privacy and data lifecycle"](#privacy-and-data-lifecycle).

- **Bank entry ids are a constrained slug, not free text.** `id` is
  validated against `^[a-z0-9:_-]+$` at parse time (see ["Wire
  formats"](#wire-formats)); an id outside that grammar is rejected, never
  stored. Ids are rendered back into a *future* prompt verbatim
  (`id="req:a"` in the bank listing), so constraining the character set
  structurally means an id can never itself carry a quote or newline that
  could reshape that future prompt's structure.
- **Free-text values are rendered as escaped, quoted JSON string
  literals, not spliced in raw.** Bank `content`, `session.status`, and
  transcript message text are passed
  through `JSON.stringify` before being placed in the prompt
  (`quoteUntrusted()` in `src/engine/prompt.ts`). A value containing a
  newline and a line that looks like `## Current tool event` cannot
  manifest as an actual new prompt section — it stays inside one quoted,
  escaped line. Every relevant prompt section header also says plainly
  that its contents are untrusted reported data. Raw tool input, response, and
  error fields never reach this renderer.

**What this is and isn't.** This is a *structural* boundary: it guarantees
untrusted text cannot forge fake prompt sections, tags, or delimiters by
exploiting raw newlines/quotes. It is not, and cannot be, a guarantee that
the model will never be *semantically* misled by something it reads
inside a quoted string — no mechanical measure at the prompt-construction
layer can fully prevent that for an LLM. The mechanical guards
(["Mechanical guards"](#mechanical-guards-the-reminder-contract)) are the
actual enforcement backstop regardless of what the model decides to do
with untrusted content: a reminder is only ever trusted after it
independently passes all six, checked against the database's own
now-current state, not the model's claims about it.

## Fail-open design

`src/bin/hook.ts`'s `main()` is structured so that no code path can print
anything other than JSON to stdout, and no code path can exit non-zero:

- The Node `ExperimentalWarning` `node:sqlite` normally emits is
  suppressed at the process level before anything else runs
  (`src/lib/suppress-warnings.ts`, imported first) — stderr stays clean
  too, unless `PMS_DEBUG=1`.
- The whole invocation is bounded by a single time budget — see ["Time
  budget"](#time-budget) immediately below for exactly how.
- Every database write happens inside an explicit transaction
  (`src/db/transaction.ts`); a failure rolls back and a best-effort
  fallback write (`recordFastPathSilence` / `safeFallbackSilence` in
  `src/engine/engine.ts`) tries to at least log `silence` with the error
  message, itself wrapped in a `try/catch` that swallows any further
  failure. If literally nothing can be written, the result is a true
  no-op — no throw ever reaches `main()`.
- `main()` itself is additionally wrapped end-to-end: even a bug that
  defeats every guard above still resolves to `process.exit(0)`.
- Verified end-to-end, not just by code inspection: `test/bin/hook-cli.test.ts`
  spawns the real compiled CLI as a subprocess against malformed stdin, an
  erroring model server, a model server that hangs past the configured
  timeout, stdin that never arrives, and a SQLite write lock held open by
  another connection — and asserts exit code 0, empty stdout, and (for the
  last two) that the deadline — not the larger independently-configured
  per-phase timeout — is what actually bounded the wait.
- **"No hook output" scopes to stdout**, the channel Claude Code parses as
  the hook's JSON decision. One diagnostic is intentionally exempt from the
  `PMS_DEBUG` gate that governs every other log line: the absolute
  last-resort handler at the bottom of `src/bin/hook.ts` writes one
  `console.error` line unconditionally if literally everything else already
  failed, on the reasoning that leaving zero trace of a truly unexpected bug
  is worse than a harmless stderr line. It is still fully fail-open-safe —
  stderr on exit 0 is not parsed as hook output, cannot block a tool call,
  and cannot change the (always-0) exit code.

### Time budget

**One deadline for the whole invocation, not one per phase.**
`src/bin/hook.ts` creates a single `Deadline` (`src/lib/deadline.ts`,
budget = `PMS_OVERALL_TIMEOUT_MS`, default/hard-capped at 15s — see
["Model configuration"](#model-configuration)) immediately after config
loads, and every phase below draws down the *same* remaining budget
instead of getting its own independent allowance:

- Stdin is read with a timeout of `min(PMS_STDIN_TIMEOUT_MS,
  deadline.remainingMs())`.
- The `busy_timeout` PRAGMA passed to `openDatabase()` is
  `min(PMS_BUSY_TIMEOUT_MS, deadline.remainingMs())` — a SQLite lock wait
  can only ever consume what's left of the budget, never its own
  separately-configured ceiling on top of everything else.
- The model request's `timeoutMs` (`src/engine/engine.ts`) is
  `min(PMS_MODEL_TIMEOUT_MS, deadline.remainingMs())`; if the budget is
  already exhausted by the time Phase A finishes, the model is never
  called at all (zero network attempt, immediate fail-open with a logged
  reason).
- The whole engine call is additionally raced against
  `deadline.remainingMs()` (not a static config value) as a final
  backstop (`withOverallTimeout`).

Net effect: the documented ~15-second sidecar budget is an invariant of
the *entire* invocation (stdin + DB + model), not just of the model call
in isolation — configuring a larger `PMS_STDIN_TIMEOUT_MS` or
`PMS_BUSY_TIMEOUT_MS` can no longer make the process outlive it.

**Caveat, stated precisely, not hidden.** This is enforced by cooperative
checks between phases and by `AbortController` for the async model call —
it cannot preempt a *synchronous* syscall already in flight (e.g.
`mkdirSync`/`DatabaseSync` open against a hung or pathologically slow
filesystem). `node:sqlite`'s `DatabaseSync` is fully synchronous, and Node
is single-threaded: a truly stuck synchronous call blocks the entire
process and cannot be interrupted by any in-process JS timer. That
specific, narrow failure mode is a structural limit of this architecture
(a synchronous DB driver in a single-threaded runtime), not a bug in the
deadline logic — see limitation D8 below. In other words: this is a
strong, tested guarantee for the overwhelmingly common case (a healthy
local filesystem), not an absolute one for every pathological environment.

## Concurrency model

Claude Code can fire `PostToolUse` for several tools in one parallel
batch concurrently — each becomes a separate hook subprocess against the
*same* project database. `processHookEvent` deliberately does **not**
hold a SQLite write transaction open across the (up to 15s) model call: it
commits a small "Phase A" transaction (step increment, trigger-policy
bookkeeping) first, makes the model call with no lock held, then opens a
fresh "Phase B" transaction to apply Phase 1 edits and the Phase 2
decision together. WAL mode plus a `busy_timeout` lets concurrent writers
queue briefly instead of failing immediately (see ["Model
configuration"](#model-configuration) — this is itself capped to the
remaining overall deadline, not its own independent ceiling); under
sustained contention beyond that, a step can legitimately degrade to
silence rather than block the tool call — safe, logged, and rare.

**Out-of-order Phase B commits are handled explicitly, not just avoided
by holding a lock.** Because no lock is held across the model call, two
concurrent steps' (up to 15s) model calls can settle in either order —
the *later* step (higher `session.step_count`) can finish first, and the
*earlier* step's response can arrive after it. Applying a stale response
at that point would risk silently overwriting bank content, session
status, or injection/cooldown bookkeeping the newer step already
committed. `session_progress.committed_step` (an additive table, schema
v2 — see `src/db/schema.ts`) is a durable per-session watermark: the
highest step whose Phase B has actually committed. Every Phase B checks
it, atomically with applying its own edits (SQLite write transactions are
fully serialized via `BEGIN IMMEDIATE`, so the check-then-commit is
race-free with no extra locking):

- If a **higher** step has already committed, this response is
  stale/out-of-order. Every mutation it would have made is suppressed —
  no bank/status write, no injection bookkeeping, no stdout, even in live
  mode — but the audit trail stays truthful: `bank_op_log` records each
  op as attempted-but-superseded (`reason = 'stale_superseded'`),
  `trigger_event.phase2_outcome = 'stale_superseded'` with an explanatory
  `error`, and `intervention_log` still logs a real `silence` row with
  the actual latency/token spend (the model call genuinely happened, it
  just can't be trusted to land now).
- Otherwise, the watermark advances to this step and Phase B applies
  normally.

This is a session-level, not per-entry, policy: a stale step's *entire*
Phase B is suppressed as one unit, favoring simplicity and provable
correctness (a single well-tested gate) over finer-grained per-entry
merging. See `test/engine/engine.test.ts`'s "concurrency ordering" suite,
which reproduces the out-of-order race deterministically with two
deferred fake model calls settled in reverse-of-arrival order.

## Kill switch

Set `PMS_ENABLED=0` (or `false`) in the hook process's environment. Every
invocation becomes an immediate no-op before stdin is even read past the
check — nothing is written anywhere. Claude Code's own
`"disableAllHooks": true` setting is a coarser alternative that also
disables any other hooks you have configured.

## Limitations

Numbered for reference, not in priority order.

- **D1 — Persistent hook context.** Each hook invocation is a fresh,
  stateless subprocess with no persistent, in-process view of the action
  agent's actual live context window. Everything the sidecar reasons about
  is re-derived per call from three sources: the SQLite bank, a bounded
  re-read of the last `k=8` user/assistant transcript messages, and the
  triggering event's content-minimized summary. It cannot see the real system prompt, context injected by
  *other* hooks, mid-turn state not yet flushed to the transcript file, or
  confirm that a previously-emitted reminder was actually attended to by
  the model — only that it was logged and (if live) printed. Claude Code's
  own hooks reference documents the transcript file as written
  asynchronously and possibly lagging the in-memory conversation; this
  project accounts for that by never trusting the transcript for anything
  synchronously important (trigger/near-duplicate detection uses the
  sidecar's own `trigger_event` log instead — see ["Trigger
  policy"](#trigger-policy)) but the underlying limitation — no persistent
  window into the agent's true context — is structural to the hook
  architecture itself, not something a sidecar process can fix.
- **D2 — Trigger policy is structural, not semantic.** Cadence, forced
  failure, and repeat detection are syntactic signals (counts, event types,
  and privacy-safe fingerprint equality), not an understanding of whether a
  given moment is actually decision-relevant. This can under-trigger
  (something important happens between cadence ticks) or, in principle,
  over-trigger relative to what the paper's own more expensive
  model-judged schedule might choose.
- **D3 — Single-call Phase 1 + Phase 2 coupling.** To satisfy "single
  model call" and to work uniformly against completion-style endpoints
  that may not support native tool-calling, both phases are packed into
  one text response, rather than the paper's Phase 1 as a sequence of
  native tool calls followed by a separately-conditioned Phase 2 read of
  the *actually-applied* result. This project narrows that gap by
  mechanically re-validating Phase 2's grounding against the bank state
  that Phase 1's edits actually produced (not merely the model's
  simultaneous claim about it) before ever committing to a reminder — but
  the model's own internal reasoning for Phase 2 is still conditioned on
  its own draft of Phase 1, not a fully-settled second read.
- **D4 — No learned/calibrated intervention policy.** This implementation
  only supports prompted models via the adapter interface. The paper's
  own SFT+GRPO-trained open-weight policy (§4.5) measurably improves
  calibration over a purely prompted model. The mechanical guards here
  (cooldown, similarity, token cap, factual-prose heuristics) are a
  training-free substitute for *some* of that calibration, directly
  informed by the paper's own qualitative failure analysis (§4.4: "the
  memory agent surfaces a speculative inference with too much confidence,
  repeats information the action agent already knows... these cases
  motivate training the memory agent to better decide when to remain
  silent") — but they are heuristics enforced in code, not a learned
  policy.
- **D5 — Guard heuristics can misfire.** The imperative-phrasing and
  wall-clock guards are regex/keyword-based. They can reject a legitimate
  factual sentence that happens to contain a curated marker (e.g. "the
  config file must be valid JSON" reads as advice-shaped to the guard even
  though it's describing a requirement) and could in principle miss
  advisory phrasing outside the curated list. The failure direction is
  always suppression (safe) never leakage (unsafe), consistent with the
  fail-open philosophy, but it does mean occasional false-positive
  silence.
- **D6 — No cross-session or cross-project memory.** Banks are strictly
  per-session and per-project by design — a fact learned in one session
  is never visible from a different session, even in the same project.
  This is a deliberate scope boundary matching "ephemeral, per-session"
  from the design brief, not an oversight, and not a substitute for a
  long-term user-memory product.
- **D7 — Contention can degrade to silence.** See ["Concurrency
  model"](#concurrency-model): under sustained parallel-tool-call
  contention beyond `PMS_BUSY_TIMEOUT_MS` (itself further capped by
  whatever remains of the overall deadline — see ["Fail-open
  design"](#fail-open-design)), a step can fail open into silence purely
  due to a SQLite write-lock wait, independent of anything about that
  step's actual content. The same section also documents an explicit,
  *non*-lock-contention case: a slower step's response arriving after a
  faster, later step already committed is detected and suppressed too,
  not just genuine lock timeouts.
- **D8 — The time budget cannot preempt a stuck synchronous syscall.**
  The single-deadline design (["Fail-open design"](#fail-open-design))
  bounds every phase this project controls cooperatively, and bounds the
  async model call with a real `AbortController`. It cannot bound a
  synchronous filesystem call already in flight — `mkdirSync` or
  `node:sqlite`'s `DatabaseSync` open against a hung or pathologically
  slow disk/network mount blocks the single-threaded Node process outright
  until that call returns, deadline or not. This is named here explicitly
  rather than left implicit: the 15-second budget is a strong, tested
  guarantee for the overwhelmingly common case (a healthy local
  filesystem), not an absolute one for every pathological environment.
- **D9 — The egress parser is conservative, not a shell interpreter.** Known
  external/networked commands are denied mechanically. Syntax outside the
  bounded grammar becomes ambiguous and suppresses only the sidecar provider
  request; the action agent still runs. This favors missed memory updates over
  accidental provider egress. The allow path still sends the documented bank,
  status, and user/assistant transcript fields to the configured provider, so
  operators must treat every enabled or shadow invocation as external data
  processing.
- **Node.js version.** Requires `node:sqlite`, which shipped experimental
  and flagged in Node 22.5, then unflagged (still experimental-warned) in
  a later Node 22.x — this project was built and tested against Node
  22.22.3, where it is unflagged. `src/bin/hook.ts` fails open (not
  crashes) if `node:sqlite` cannot be loaded at all, but on an older Node
  22.x you may need `NODE_OPTIONS=--experimental-sqlite` in the hook's
  environment; on Node <22.5 this project cannot run.

## Alignment with the paper vs deviations

This implementation follows *"Remember When It Matters"* closely where
the design brief is silent, and follows the design brief exactly where it
specifies something the paper leaves as an implementation detail. Read
alongside the paper's own text (§3, §4.4, §4.5):

**Matches the paper directly:**
- The core two-phase loop — Phase 1 bank maintenance via a constrained set
  of operations, Phase 2 a strictly-optional grounded reminder or explicit
  silence — mirrors §3.3 almost exactly, including the four Phase 1
  operation names (`update_status`/`save_knowledge`/`save_procedural`/
  `delete` here vs. the paper's `memory_update_status`/
  `memory_save_knowledge`/`memory_save_procedural`/`memory_delete`).
- The `k=8` trajectory window (§4.1: *"a recent trajectory window of k
  (k=8) messages"*) is this project's literal default
  (`PMS_TRANSCRIPT_TAIL_K=8`).
- The private `status` field (§3.2: *"never shown to the action
  agent"*) is structurally unexposable here — `grounding` ids are checked
  against the `entry` table only, and `session.status` has no `id` a
  reminder could ever cite.
- The `<context_for_action>` example in this project's spec (IPv4 octets,
  a regex failing on `"1.2.3.4"` at step 14) traces directly to the
  paper's own qualitative analysis of a Terminal-Bench task it calls
  "regex-log" (§4.4: *"it points out that the current regex violates the
  task's boundary condition, misses single-digit IPv4 octets"*) — it is
  not an arbitrary example.
- This project's mechanical cooldown/similarity/factual-prose guards exist
  specifically because the paper's own qualitative analysis (§4.4)
  identifies redundant and over-confident interventions as the dominant
  failure mode of a purely-prompted memory agent, and names better
  silence-calibration as the open problem its RL stage (§4.5) targets.
  Lacking the ability to train a bespoke policy, this project enforces the
  same calibration goal mechanically instead.
- The paper's ablations (§4.3: full-bank-context / always-inject /
  injection-only / Mem0-style retrieval, all underperforming the full
  selective two-phase design) are the direct motivation for *not*
  offering an "always show the whole bank" or "always inject" mode here.

**Deliberate deviations (present in this project, not evaluated or not
specified in the paper):**
- **Forced triggers on tool failure and near-duplicate calls.** The
  paper's own main experiments use *only* a fixed interval (§3.4: *"we use
  a fixed interval to isolate the effect of the memory intervention policy
  itself"*), while explicitly naming exactly this kind of event-driven
  triggering as unevaluated future work (§3.4: *"more selective triggers
  are possible, such as invoking memory only after tool errors...or
  repeated commands"*). This project implements precisely that suggestion
  as a hard requirement, since a production hook sidecar benefits from
  reacting immediately to a failure rather than waiting for the next
  cadence tick.
- **No "always trigger at step 1".** The paper's schedule is *"invoked at
  the first step and then at a fixed interval"* (§3.5) — it seeds the bank
  from the task description before any drift can occur. The design brief
  for this project specifies exactly four trigger conditions (cadence,
  forced failure, forced near-duplicate, PreCompact sweep) and does not
  include a first-step special case, so this implementation doesn't add
  one unilaterally. In practice the first `PMS_CADENCE_N` calls of a
  session run with an empty or sparse bank until the first cadence tick;
  set `PMS_CADENCE_N=1` for closer parity if that matters for your use
  case.
- **PreCompact Phase-1-only sweep.** Has no analog in the paper at all —
  it is specific to adapting the architecture to Claude Code's hook
  lifecycle, where context compaction is a distinct event that could
  otherwise discard trajectory detail the bank hasn't captured yet.
- **60-entry bank cap, 6-step cooldown, 0.85 similarity threshold, 100-token
  reminder cap.** None of these specific numbers appear in the paper (its
  benchmark episodes are bounded and don't need an explicit bank ceiling
  or an explicit anti-redundancy threshold on top of the model's own
  judgment). They are this project's operational safeguards for
  long-running or resumed sessions, all defaulting to the values named in
  the design brief and independently configurable — except the 100-token
  reminder cap, which configuration may only ever *lower*, never raise
  (see ["Mechanical guards"](#mechanical-guards-the-reminder-contract)):
  that specific number is a product invariant, not just a tunable default.
- **Mechanically-checked grounding, not just "memory-grounded" by
  convention.** The paper describes reminders as memory-grounded as a
  qualitative design property. This project turns that into a
  machine-checked contract: a `grounding` attribute naming real,
  currently-live entry ids, verified against the bank as it exists
  immediately after this step's own edits, with any violation degrading
  to silence.
- **Single non-tool-calling model call, both phases as one text
  completion.** See limitation D3 above — a deliberate simplification for
  portability across Anthropic and OpenAI-compatible completion
  endpoints, since the design brief calls for "a single model call".
- **Smaller default model.** See ["Model configuration"](#model-configuration)
  — the paper's reported results use an Opus-tier memory agent; this
  project defaults to a fast/cheap model given it runs synchronously in
  the hook path, and documents upgrading `PMS_MODEL_NAME` as the way to
  trade latency for the paper's reported quality.
- **No results claimed for this implementation.** The pass@1 numbers
  above are the paper's own, from its own benchmark harness and models.
  This project has not been benchmarked against Terminal-Bench or
  τ²-Bench; it implements the architecture, not a reproduction of the
  paper's evaluation.

## Development

See **[`AGENTS.md`](AGENTS.md)** for local commands, the repo layout, and
the non-negotiable correctness properties (fail-open, exact schema,
exact wire format, no transaction across the model call, mechanical-only
guards, dual-enforced 15s timeout, no real network calls in tests, tests
run against compiled output) that any change here must preserve.

```bash
npm install
npm run verify   # typecheck && lint && build && test
npm run benchmark:fake  # local fake adapter; validates both harness gates without provider calls
```

## License

[MIT](LICENSE).
