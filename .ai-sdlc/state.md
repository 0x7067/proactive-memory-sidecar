# Project State
updated: 2026-07-14

## Goal
Provide a reliable local proactive-memory hook shared by Claude Code and
Codex without leaking sensitive tool payloads or spending model calls that
produce no useful interventions.

## Now
Standalone privacy, effectiveness, storage, and deployment remediation is
implemented and verified. Global proactive-memory PostToolUse hooks remain
disabled. Codex's zero-reminder defect was missing rollout `response_item`
messages in recent-trajectory prompt construction; the trigger, provider parser,
bank operations, guards, and `additionalContext` contract were not the defect.
Cadence remains unchanged, and the recorded Codex sample still fails its gate.

## Verification path
- Parse `~/.claude/settings.json` and `~/.codex/hooks.json`; neither should
  contain proactive-memory PostToolUse registrations while remediation is open.
- Final repository verifier: `npm run verify` passes 308 tests in 43 suites.
- Live-hook check: the Claude and Codex home hook files contain no
  proactive-memory hook command or registration.
- Benchmark against the audit baseline: Codex made 47 model calls with 63,351
  input tokens and produced zero reminders; Claude made 34 calls with 48,711
  input tokens and produced 10 reminders.

## Decisions
- Keep fail-open hook behavior, mechanical guards, and one invocation deadline.
- Treat shadow mode as external data processing because it still calls a model.
- Default to silence and no provider request when a Bash command cannot be
  classified safely.
- Keep hooks disabled until privacy tests and per-harness effectiveness gates
  pass; provide an explicit, reversible re-enable procedure afterward.
- Keep installation standalone: hook templates point directly to this checkout;
  agentctl is not an installation, wrapper, configuration, or deployment layer.
- Store each project's database under `.proactive-memory/`, repairing directory
  mode to 700 and database mode to 600 whenever it opens.
- Treat fake-adapter results as pipeline evidence only, never as authorization
  for provider traffic or harness re-enable.

## Landmines
- A top-level tool allowlist is insufficient for general shell tools; inspect
  nested executables and subcommands without logging or forwarding raw secrets.
- Git has both local and networked subcommands; do not classify all Git events
  as equivalent.
- Shadow mode still performs provider processing; count accepted shadow
  reminders by joining `effectiveness_metric` to `intervention_log` rather than
  treating `emitted_reminder` as true when stdout was intentionally empty.

## Next
1. Keep both harnesses disabled by default; do not edit home hook files as part
   of this remediation.
2. If explicitly approved, run one bounded, project-scoped Claude shadow canary
   and require every privacy/effectiveness gate to pass before live mode.
3. Do not recommend Codex re-enable until a new consented real-provider sample
   with the fixed trajectory path produces enough reminders to pass its gate.
4. Roll back any future project-scoped attachment by restoring its hook file or
   setting `PMS_ENABLED=0`.
