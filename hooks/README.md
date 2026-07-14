# Standalone installation and hook attachment

This repository is the complete installation and deployment boundary. The
hook command must point directly to this checkout's compiled CLI. Do not route
it through agentctl or any other installer, wrapper, generated configuration,
or deployment layer.

The examples do not modify `~/.claude` or `~/.codex`. Copy or merge them only
after the privacy checks and the relevant harness effectiveness gate pass.

## 1. Build and verify the fixed checkout

Use a stable absolute path. Moving or deleting the checkout breaks the hook
command but still fails open.

```bash
cd /absolute/path/to/proactive-memory-sidecar
npm ci
npm run verify
```

The build creates:

- `dist/src/bin/hook.js`: the synchronous hook entry point.
- `dist/src/bin/maintain.js`: the retention CLI.

No runtime package or service is installed elsewhere.

## 2. Keep storage project-local

The default database is
`<hook payload cwd>/.proactive-memory/bank.sqlite3`. The sidecar sets the
database directory to mode `700` and the database file to mode `600` whenever
it opens the database. Add this to each target project's `.gitignore`:

```gitignore
.proactive-memory/
```

Do not set `PMS_DB_PATH` to a machine-global agent state directory. Use
`PMS_DB_PATH` or `PMS_DB_RELATIVE_PATH` only when an operator deliberately
chooses another project-local or tighter location.

## 3. Prepare project-scoped hook configuration

### Claude Code

Merge [`settings.example.json`](./settings.example.json) into the target
project's `.claude/settings.local.json` or `.claude/settings.json`. Replace
`/absolute/path/to/proactive-memory-sidecar` with the fixed checkout path.

Claude registers `PostToolUse`, `PostToolUseFailure`, and `PreCompact`.

### Codex

Copy [`codex.hooks.example.json`](./codex.hooks.example.json) to the target
project's `.codex/hooks.json` and replace the same absolute-path placeholder.
Codex registers `PostToolUse` and `PreCompact`; failed supported tool calls
arrive as `PostToolUse` with a failed response. Review and trust the project
hook through Codex's `/hooks` interface before expecting it to run.

Both harnesses receive the same stdout contract. Claude failures preserve
`hookEventName: "PostToolUseFailure"`; Codex failures preserve
`hookEventName: "PostToolUse"`.

## 4. Configure the provider explicitly

Set credentials in the hook process environment, not in a committed hook JSON
file:

```bash
export PMS_MODEL_PROVIDER=anthropic
export PMS_MODEL_API_KEY=...
export PMS_MODEL_NAME=claude-haiku-4-5
```

The sidecar calls only the configured model endpoint. Shadow mode still calls
that endpoint and still performs external data processing. It changes only
whether an accepted reminder is emitted to the action agent.

## 5. Re-enable proposal and rollback

Do not use the fake-adapter benchmark as authorization for provider traffic.
It proves the pipeline and gate calculation without network access:

```bash
npm run benchmark:fake
```

A reversible rollout is:

1. Keep the current hook files backed up.
2. Obtain approval for the documented provider-bound fields and a bounded
   shadow canary.
3. Attach one harness in one project with `PMS_MODE=shadow`.
4. Query `effectiveness_metric` for that harness, joining
   `intervention_log` by `(session_id, step)` to count accepted shadow
   reminders. Require zero provider calls on privacy skips and enough accepted
   reminders to pass every gate in `src/effectiveness/gate.ts`.
5. Change only that harness to `PMS_MODE=live` after its real-provider sample
   passes.
6. Roll back by restoring the backed-up hook file or setting `PMS_ENABLED=0`.

The recorded Claude sample (34 model calls, 48,711 input tokens, 10 reminders)
clears the current yield/token/latency thresholds, subject to a new privacy-safe
canary. The recorded Codex sample (47 calls, 63,351 input tokens, zero
reminders) fails. Do not recommend or perform a Codex re-enable until a new,
consented sample with the fixed transcript path produces measured reminders
and passes the Codex gate.

## Privacy behavior during rollout

Before prompt construction, the sidecar classifies the current tool event.
Known external-service, network, credential, database, infrastructure,
browser, and messaging operations produce silence and zero provider requests.
An event outside the conservative grammar is ambiguous and gets the same
treatment. The action agent continues normally in every case.

The Bash classifier follows environment assignments, absolute paths, `env`,
`sudo`, `command`, nested `bash`/`sh`/`zsh -c`, pipelines, compound commands,
command substitutions, and executable subcommands. Local Git operations may
proceed to the trigger policy; networked Git operations do not.

## Retention

Rows remain until an operator prunes them. Preview the default 30-day policy,
then apply it deliberately:

```bash
node /absolute/path/to/proactive-memory-sidecar/dist/src/bin/maintain.js \
  --cwd /path/to/project --older-than-days 30 --dry-run
node /absolute/path/to/proactive-memory-sidecar/dist/src/bin/maintain.js \
  --cwd /path/to/project --older-than-days 30 --vacuum
```

Nothing in this repository schedules retention automatically.

## Timing and fail-open behavior

The templates use a 17-second harness timeout around the sidecar's one
hard-capped 15-second invocation deadline. Hooks stay synchronous because
context must arrive before the action agent's next decision. Every failure,
timeout, denied event, or ambiguous event exits `0`; stdout contains one valid
hook response or nothing.
