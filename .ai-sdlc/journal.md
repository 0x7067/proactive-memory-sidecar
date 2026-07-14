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
