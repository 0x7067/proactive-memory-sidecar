# Installing the hook

This sidecar attaches to three Claude Code hook events: **PostToolUse**,
**PostToolUseFailure**, and **PreCompact**. All three run the same compiled
CLI (`dist/src/bin/hook.js`); it inspects `hook_event_name` on stdin and
dispatches internally — you register the same command three times.

## 1. Build the sidecar

From the sidecar's own checkout:

```bash
npm install
npm run build
```

This produces `dist/src/bin/hook.js` (the hook entry point) and
`dist/src/bin/maintain.js` (the retention/pruning CLI — see the main
README's "Privacy and data lifecycle" section).

## 2. Reference it from the target project's Claude Code settings

Pick **one** of the following, depending on how you deployed the sidecar
relative to the project you want it active in.

### Option A — installed as a local dependency (recommended)

```bash
cd /path/to/your/project
npm install --save-dev /path/to/proactive-memory-sidecar   # local path or git URL
```

Then in `.claude/settings.json` (project-scoped, committable) or
`.claude/settings.local.json` (personal, gitignored):

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node",
          "args": ["${CLAUDE_PROJECT_DIR}/node_modules/proactive-memory-sidecar/dist/src/bin/hook.js"],
          "timeout": 20 }
      ]}
    ],
    "PostToolUseFailure": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node",
          "args": ["${CLAUDE_PROJECT_DIR}/node_modules/proactive-memory-sidecar/dist/src/bin/hook.js"],
          "timeout": 20 }
      ]}
    ],
    "PreCompact": [
      { "hooks": [
        { "type": "command", "command": "node",
          "args": ["${CLAUDE_PROJECT_DIR}/node_modules/proactive-memory-sidecar/dist/src/bin/hook.js"],
          "timeout": 20 }
      ]}
    ]
  }
}
```

This exact block is also in [`settings.example.json`](./settings.example.json)
next to this file — copy/merge it in.

### Option B — a single fixed checkout, shared across projects

Skip the `npm install` above and point `args` at the sidecar's absolute
`dist/src/bin/hook.js` path directly, e.g.
`"args": ["/home/you/tools/proactive-memory-sidecar/dist/src/bin/hook.js"]`.
Put this in `~/.claude/settings.json` to enable it for every project on the
machine, or in one project's `.claude/settings.local.json` to scope it to
that project only.

### Option C — global npm install

```bash
npm install -g /path/to/proactive-memory-sidecar
```

This puts `pms-hook` and `pms-maintain` on `PATH`. Reference the bare
command instead of `node <path>`:

```json
{ "type": "command", "command": "pms-hook", "timeout": 20 }
```

## 3. Configure the model adapter

The hook makes at most one model call per triggered step, and none at all
on the (common) fast path. Set the following as real environment variables
available to the hook process (shell profile, `direnv`, a `SessionStart`
hook writing to `CLAUDE_ENV_FILE`, or your process manager) — **not** in
`.claude/settings.json`, which is not a secret store and may be committed:

```bash
export PMS_MODEL_PROVIDER=anthropic          # or "openai" (any OpenAI-compatible endpoint)
export PMS_MODEL_API_KEY=sk-...              # falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY
export PMS_MODEL_NAME=claude-haiku-4-5       # pick a small/fast/cheap model — see README
```

Until this is set, the hook fails open on every triggered step (no API key
→ no call → silence), which is safe but inert. See the main
[README](../README.md#model-configuration) for the full variable list.

## 4. Roll out in shadow mode first

By default `PMS_MODE=shadow`: every decision is fully computed and logged
to the project-local SQLite database, but `additionalContext` is never
emitted, so the action agent's behavior is completely unaffected. Use a
few real sessions to inspect `intervention_log` (see the main README's
"Metrics and queries" section) before setting `PMS_MODE=live`.

## Sync behavior, timeout, and fail-open design

- **Sync, not async.** These hooks are registered as ordinary blocking
  command hooks, not `"async": true`. A reminder is only useful if it lands
  *before* the action agent's next decision — the tool result immediately
  following the triggering event. An async hook's output is only delivered
  on the *next* turn (per the Claude Code hooks reference), which would be
  one tool call too late for this use case. The cost is that a triggered
  step adds real latency (bounded — see below) to that one tool call; a
  non-triggered step (~most calls, since cadence defaults to every 4th
  call) adds negligible latency because no model call happens at all.
- **`timeout: 20`** (seconds — Claude Code's hook `timeout` field is in
  seconds, not milliseconds) gives headroom above the sidecar's own
  internal ceiling: a single model call is hard-capped at 15s
  (`HARD_MODEL_TIMEOUT_MS`, non-overridable upward), and the whole
  invocation (model call + local SQLite work) is capped at 18s by default
  (`PMS_OVERALL_TIMEOUT_MS`). The sidecar is designed to time out *itself*
  before Claude Code's external hook timeout would ever fire, so that it
  can still write a `silence` audit row and exit 0 cleanly instead of being
  killed. If you lower `PMS_MODEL_TIMEOUT_MS`/`PMS_OVERALL_TIMEOUT_MS`,
  you can safely lower this `timeout` field too; just keep it a few seconds
  above `PMS_OVERALL_TIMEOUT_MS`.
- **Fail-open, unconditionally.** Every error path — malformed stdin, an
  unreachable/erroring/slow model endpoint, a locked SQLite database, a
  bug in the sidecar itself — results in exit code `0` and empty stdout.
  Claude Code treats that identically to "this hook had nothing to say":
  the action agent is never blocked, never shown an error, and never even
  aware the sidecar exists. See the main README's "Fail-open design" and
  "Limitations" sections for the exact guarantees and their edges.

## Kill switch

Set `PMS_ENABLED=0` (or `false`) in the hook's environment to make every
invocation an immediate no-op (no stdin read past the check, no database
touched, exit 0). This is the fastest way to disable the sidecar without
editing `.claude/settings.json`. Claude Code's own `"disableAllHooks": true`
setting is a coarser alternative that also disables any other hooks you
have configured.
