# AGENTS.md

Instructions for any agent (or human) working in this repository.

## What this is

A local-only, no-external-service sidecar for Claude Code hooks. It
maintains a per-session SQLite memory bank and selectively injects short,
fact-only reminders into the action agent. See `README.md` for the full
design and `hooks/README.md` for install/attach instructions. This file is
about *working on the sidecar's own code*, not about using it.

## Local commands

```bash
npm install          # install dependencies (zero runtime deps; dev-only toolchain)
npm run typecheck     # tsc --noEmit, strict mode
npm run lint          # eslint . (flat config, typescript-eslint recommendedTypeChecked)
npm run lint:fix       # eslint . --fix
npm run build          # tsc -> dist/ (dist/src mirrors src/, dist/test mirrors test/)
npm test               # build, then node --test against the COMPILED output in dist/test
npm run test:only      # run tests against whatever is already in dist/ (skip rebuild)
npm run verify          # typecheck && lint && build && test — run this before considering any change done
```

Always run `npm run verify` before calling a change complete. All four
checks are cheap (whole suite runs in well under a minute) and this project
has zero tolerance for a broken `main`.

## Non-negotiable constraints

These are correctness properties the design depends on, not style
preferences. A change that violates one of these is a regression even if
tests still pass superficially — add/adjust tests to cover the property
if you touch code near it.

1. **Fail-open, always.** `src/bin/hook.ts`'s `main()` must never let an
   exception escape, and must always call `process.exit(0)`. Every new
   failure mode added anywhere in the call graph needs a corresponding
   degrade-to-silence path, not a thrown error that reaches the top.
   Stdout must contain *only* the single JSON decision line (or nothing) —
   never warnings, logs, or partial output. `src/lib/suppress-warnings.ts`
   must remain the first import in every CLI entry point.
2. **The three mandated tables are exact.** `session`, `entry`, and
   `intervention_log` in `src/db/schema.ts` reproduce the brief's schema
   verbatim (names, types, constraints, column order). Do not add columns
   to them. New bookkeeping goes in an additive auxiliary table
   (`trigger_event`, `bank_op_log`, `session_progress`) instead, bumping
   `SCHEMA_VERSION` and adding a migration branch in `initializeSchema`,
   never editing history.
3. **The Phase 2 wire format is exact.** `<context_for_action
   grounding="...">...</context_for_action>` and `<no_intervention/>` in
   `src/engine/parser.ts` must keep matching those two literal shapes. The
   live-mode stdout shape
   (`{"hookSpecificOutput":{"hookEventName":...,"additionalContext":...}}`)
   must keep matching what Claude Code's hook JSON output schema expects
   (see the "Add context for Claude" section quoted in `README.md`).
4. **No write transaction spans the model call.** `processHookEvent` in
   `src/engine/engine.ts` deliberately commits its "Phase A" bookkeeping
   transaction *before* awaiting the model adapter, and opens a fresh
   "Phase B" transaction only after the model responds — see the comment
   there. Holding a SQLite write lock across a ~15s network call would
   stall sibling hook invocations from a parallel tool-call batch. Don't
   collapse these into one transaction for tidiness.
5. **Guards are mechanical, not another model call.** Everything in
   `src/engine/guards.ts` must stay pure/deterministic (regex, arithmetic,
   set membership). If you need smarter enforcement, that's a prompt
   change, not a guard change — the brief requires zero additional model
   calls for guard enforcement.
6. **Hard ceilings are always enforced redundantly, never trusted from one
   place only.** This project has three: the 15s model timeout
   (`HARD_MODEL_TIMEOUT_MS`, clamped in `src/config.ts` at load time,
   again in `src/model/http-adapter.ts`'s `AbortController` via
   `Math.min(request.timeoutMs, HARD_MODEL_TIMEOUT_MS)`, and a third time
   dynamically against the shared per-invocation deadline — see #11); the
   15s overall invocation budget (`HARD_OVERALL_TIMEOUT_MS`, clamped in
   `src/config.ts` and enforced live by `src/lib/deadline.ts`); and the
   100-token reminder cap (`HARD_REMINDER_MAX_TOKENS`, clamped in
   `src/config.ts` and again inside `checkTokenCap` in
   `src/engine/guards.ts`, independent of what `ctx.maxTokens` claims).
   Keep every enforcement point when touching any of these — removing one
   silently weakens the invariant even if the others still hold today.
7. **No real network calls in tests.** Engine/store/parser/guard tests use
   `test/helpers/fake-model-adapter.ts`. HTTP-adapter and CLI-subprocess
   tests spin up a local `node:http` server on `127.0.0.1` and point the
   adapter at it — never at a real provider. `npm test` must be runnable
   with zero API keys and zero network access.
8. **Tests exercise compiled output.** `npm test` builds first, then runs
   `node --test` against `dist/test/**/*.test.js`. This is deliberate: it's
   the same JavaScript the hook CLI actually ships and Claude Code actually
   invokes, not a transpiled-on-the-fly approximation of it.
9. **`session_progress` (schema v2) holds two independent, durable,
   monotonic counters — do not conflate them.**
   `post_tool_use_success_count` increments *only* on `PostToolUse` and
   drives the cadence check in `src/trigger/trigger-policy.ts`;
   `committed_step` is the Phase-B concurrency watermark checked (and, on
   success, advanced) at the top of Phase B in
   `src/engine/engine.ts#processHookEvent` — see README "Trigger policy"
   and "Concurrency model". Neither may be replaced by
   `session.step_count` (the mandated, all-event chronological counter);
   that would reintroduce the cadence-drift and stale-overwrite bugs both
   exist to fix.
10. **Bank entry ids are a constrained grammar; untrusted free text in
    prompts is always JSON-escaped.** `validateEntryId` in
    `src/engine/parser.ts` (`^[a-z0-9:_-]+$`) is the only place an id may
    be accepted — do not loosen it or add a raw-string fallback. Bank
    content, session status, transcript text, and tool error messages are
    rendered via `quoteUntrusted()` in `src/engine/prompt.ts`
    (`JSON.stringify`), never spliced into the prompt template as raw
    interpolated strings — see README "Model-prompt data boundaries".
11. **There is exactly one deadline per invocation — thread it through,
    don't add a parallel timeout.** `src/bin/hook.ts#main` creates a
    single `Deadline` (`src/lib/deadline.ts`) right after config loads and
    passes it (or a value derived from `deadline.remainingMs()`) into
    every phase that can block: `readStdin`, the `busy_timeout` PRAGMA
    given to `openDatabase`, and `EngineDeps.deadline` into
    `processHookEvent`. If you add a new blocking phase to `main()` or to
    the engine, thread the same deadline through it — do not give it an
    independent `PMS_*_TIMEOUT_MS` that isn't itself capped by
    `deadline.remainingMs()`, or the 15s whole-invocation budget
    (README "Fail-open design") silently stops being a real ceiling again.

## Repo layout

```
src/
  bin/            hook.ts (Claude Code entry point), maintain.ts (retention CLI)
  lib/            dependency-free utilities: warning suppression, debug logging,
                  trigram similarity, tool-input canonicalization, type guards,
                  the single per-invocation Deadline (deadline.ts)
  db/             schema/migrations, connection + pragmas, transaction helper
  store/          one module per table (+ the three auxiliary tables) — all DB
                  access outside src/db goes through these, never raw SQL
                  scattered around
  transcript/     Claude Code transcript JSONL tail reader
  trigger/        cadence/forced/near-duplicate/PreCompact trigger policy
  model/          ModelAdapter interface + default Anthropic/OpenAI-compatible impl
  engine/         prompt building, response parsing, mechanical guards, orchestration
  config.ts       env -> validated Config, all tunables with defaults + clamping
  constants.ts    every default numeric/string contract, in one place
  types.ts        shared domain types
  hook-io.ts      hook payload validation + subagent-event detection
test/             mirrors src/ one-for-one, plus helpers/ (fakes/fixtures) and
                  bin/ (end-to-end subprocess tests against the real compiled CLI)
hooks/            settings.example.json + install walkthrough for consumers
```

## Style

- ESM throughout (`"type": "module"`), `NodeNext` module resolution,
  explicit `.js` extensions on relative imports (required by NodeNext).
- No runtime dependencies. `node:sqlite`, `node:fetch`, `node:test`, and
  friends only. Think hard before adding one — this project's reliability
  story rests partly on having almost nothing to update or break.
- Prefer small pure functions with explicit inputs over hidden state, even
  inside `src/engine/` — it's what makes the guard/parser/trigger-policy
  test files possible without spinning up a database.
- TypeScript strict mode is on, including `exactOptionalPropertyTypes`.
  Hook payload fields are modeled as `T | undefined` (required-but-nullable)
  rather than `field?: T` for this reason — see the comment at the top of
  `src/types.ts` before "fixing" that back to `?:`.
