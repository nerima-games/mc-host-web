import { Effect } from 'effect'

/**
 * World writes from outside the frame fiber (DOM handlers, timers, QA hooks),
 * deferred to the frame boundary.
 *
 * The frame runs in a forked fiber that can yield between a view's revision
 * read and its commit, so a handler that commits directly either moves the
 * world revision under the frame (`WorldRevisionConflict` in the frame) or
 * finds the coordinator's single permit taken (`AsyncFiberError` in the
 * handler's `runSync`). A handler instead enqueues its whole effect, including
 * whatever it does with the write's result, and the frame fiber runs it.
 */
export type FrameBoundaryQueue<E> = Readonly<{
  /** Synchronous and runtime-free, so a DOM handler can call it at any time. */
  enqueue: (write: Effect.Effect<void, E>) => void
  /**
   * Runs, in enqueue order, the writes queued before this drain started.
   * Writes enqueued while it runs, including by a queued write, wait for the
   * next drain, so a write that re-enqueues cannot hold the frame forever.
   *
   * The first failing write fails the drain with its own error, for the frame's
   * failure path. That write is removed; the writes after it are not run and
   * stay queued in order, as do the unrun writes if the drain is interrupted.
   *
   * Only the frame fiber may run it, one drain at a time.
   */
  drain: Effect.Effect<void, E>
}>

export const makeFrameBoundaryQueue = <E>(): FrameBoundaryQueue<E> => {
  const pending: Array<Effect.Effect<void, E>> = []
  return {
    enqueue: (write) => {
      pending.push(write)
    },
    drain: Effect.suspend(() =>
      Effect.forEach(
        pending.slice(),
        // Writes are only appended elsewhere, so the head is the write about to run.
        // Removing it first means a failed or interrupted write is never rerun.
        (write) => Effect.andThen(Effect.sync(() => pending.shift()), write),
        { discard: true },
      )),
  }
}
