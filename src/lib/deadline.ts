/**
 * A single wall-clock deadline for one hook invocation. Created once, as
 * close to process entry as practical (see `src/bin/hook.ts`), and
 * threaded down through every phase that can block — stdin read, SQLite
 * open/contention, and the model call — so no phase can independently
 * claim a larger slice of time than the documented sidecar budget
 * (`PMS_OVERALL_TIMEOUT_MS`, default/hard-capped at 15s). See README
 * "Fail-open design" for the caveat this cannot fully cover: a truly stuck
 * *synchronous* syscall (e.g. a hung filesystem) cannot be preempted by an
 * in-process JS timer, only raced against for the async portions.
 */
export interface Deadline {
  readonly startedAt: number;
  readonly deadlineAt: number;
  /** Milliseconds left before the deadline, clamped to >= 0. Defaults `now` to the real clock. */
  remainingMs(now?: number): number;
  /** True once `remainingMs() <= 0`. Defaults `now` to the real clock. */
  isExpired(now?: number): boolean;
}

/** Creates a `Deadline` that expires `budgetMs` after `startedAt` (defaults to `Date.now()`). A non-positive `budgetMs` yields an already-expired deadline. */
export function createDeadline(budgetMs: number, startedAt: number = Date.now()): Deadline {
  const deadlineAt = startedAt + Math.max(0, budgetMs);
  return {
    startedAt,
    deadlineAt,
    remainingMs(now: number = Date.now()): number {
      return Math.max(0, deadlineAt - now);
    },
    isExpired(now: number = Date.now()): boolean {
      return now >= deadlineAt;
    },
  };
}
