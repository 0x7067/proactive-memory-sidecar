# Project State
updated: 2026-07-14

## Goal
Provide a reliable local proactive-memory hook shared by Claude Code and
Codex without leaking sensitive tool payloads or spending model calls that
produce no useful interventions.

## Now
Global proactive-memory tool hooks are disabled in both Claude Code and Codex.
The 2026-07-14 audit found that the installed wrapper's tool-name denylist lets
external commands pass when invoked through Bash. Redaction removed token-like
values in the tested payload, but the command content was still sent to the
configured model provider. The source fix belongs in this standalone repo; do
not reintroduce agentctl as a deployment dependency.

## Verification path
- Parse `~/.claude/settings.json` and `~/.codex/hooks.json`; neither should
  contain proactive-memory PostToolUse registrations while remediation is open.
- Reproduce the privacy defect with sensitive external commands wrapped in
  Bash, including nested shells, pipelines, environment assignments, and
  command substitutions; assert that no provider request occurs.
- Run `npm run verify` under the repo-pinned Node toolchain.
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

## Landmines
- A top-level tool allowlist is insufficient for general shell tools; inspect
  nested executables and subcommands without logging or forwarding raw secrets.
- Git has both local and networked subcommands; do not classify all Git events
  as equivalent.
- Codex's zero-reminder result may be an output-contract, grounding, parser, or
  trigger-calibration defect; prove which before tuning cadence.

## Next
1. Implement command-aware provider-egress guards and adversarial tests.
2. Add privacy-safe skip-reason and effectiveness metrics.
3. Diagnose Codex's zero-reminder path, then publish safe re-enable steps.
