/**
 * Side-effect-only module that must be the FIRST import in every CLI entry
 * point (before `node:sqlite` or anything else is imported).
 *
 * `node:sqlite` is still marked experimental by Node and emits an
 * `ExperimentalWarning` the first time it is touched. Hooks are graded on
 * clean stdout/stderr by Claude Code's transcript, and a stray warning line
 * is noise a fail-open tool shouldn't produce. ES module evaluation order
 * guarantees this module's top-level code runs before any subsequently
 * imported module's top-level code (imports are evaluated depth-first, in
 * source order), so placing `import "./lib/suppress-warnings.js"` as the
 * first line of a bin entry point suppresses the warning even though the
 * triggering `import("node:sqlite")` happens in a different module.
 *
 * We remove Node's default warning printer (a normal listener on
 * `process`) and install our own that only surfaces warnings when
 * PMS_DEBUG is set, and only to stderr — stdout is reserved exclusively
 * for the hook's JSON decision.
 */

process.removeAllListeners("warning");
process.on("warning", (warning: Error) => {
  if (process.env.PMS_DEBUG === undefined) return;
  const truthy = ["1", "true", "yes", "on"].includes(process.env.PMS_DEBUG.trim().toLowerCase());
  if (!truthy) return;
  console.error(`[proactive-memory-sidecar:warning] ${warning.name}: ${warning.message}`);
});
