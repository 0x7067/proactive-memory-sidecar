## 2026-07-14 — Verified global Claude and Codex installation
- Did: refreshed the then-current pinned global install through agentctl's wrapper.
- Verified: the sidecar test suite passed and a live smoke produced a reminder.
- Superseded: the later privacy audit below disabled both hook registrations and
  rejected agentctl as the deployment source for the next iteration.

## 2026-07-14 — Audit disabled proactive hooks pending source remediation
- Did: audited live hook wiring, stored metrics, provider-bound payload handling,
  and harness effectiveness; removed proactive PostToolUse hooks from Claude Code
  and Codex while preserving native memory and SDLC lifecycle hooks.
- Verified: a Railway command invoked through Bash reached model processing even
  though direct Railway tool names are denied; tested token-like values were
  redacted, but command content still crossed the provider boundary.
- Measured: Codex used 47 model calls and 63,351 input tokens for zero reminders;
  Claude used 34 calls and 48,711 input tokens for 10 reminders.
- Decided: fix privacy and effectiveness in this standalone repo, keep hooks off
  until the new tests and gates pass, and do not reintroduce agentctl for now.

## 2026-07-14 — Standalone privacy and effectiveness remediation
- Did: added a pre-prompt provider-egress classifier, content-minimized event
  summaries, content-free funnel metrics, project-local secure storage, Codex
  rollout trajectory support, per-harness gates, and standalone hook templates.
- Diagnosed: Codex's 47 valid `no_intervention` responses lacked recent
  trajectory because `response_item` messages were ignored; cadence is unchanged.
- Verified: `npm run verify` passes 308 tests in 43 suites. Denied and ambiguous
  commands build no prompt, call no adapter, and persist no raw command/secret;
  both harness wire tests and the no-provider fake benchmark pass.
- Decided: keep home hooks disabled and Codex unrecommended; any future canary
  must be explicitly approved, project-scoped, and reversible.
