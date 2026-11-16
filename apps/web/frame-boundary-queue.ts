import { Deferred, Effect, Semaphore } from 'effect'

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
   * Only one drain may run at a time, never while a frame runs: `FrameBoundary`
   * runs it under the frame lock.
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

/**
 * The queue plus the one frame lock that serializes every world access made
 * outside a frame with the frames themselves.
 *
 * The lock exists because frames stop while the tab is hidden (no
 * `requestAnimationFrame`), and some work cannot wait for the next frame: the
 * hidden-tab network pump and save snapshots. That work runs under the lock
 * instead, so it never interleaves with a frame that has yielded.
 *
 * Once the loop has stopped nothing drains, so work still queued then, or
 * queued later, never runs and an `atFrameBoundary` caller never resumes.
 * Such a caller holds only a pending promise, which page unload does not wait
 * for. Work under the lock still runs after the stop, so a final save does.
 */
export type FrameBoundary<E> = Readonly<{
  enqueue: FrameBoundaryQueue<E>['enqueue']
  /**
   * Wraps one frame: holds the lock for the whole frame and drains first, so
   * writes queued while the previous frame ran apply before this one reads.
   */
  frame: <A, FrameError, R>(body: Effect.Effect<A, FrameError, R>) => Effect.Effect<A, E | FrameError, R>
  /** Drains under the lock from outside a frame, for when frames do not run. */
  drainOutsideFrame: Effect.Effect<void, E>
  /**
   * Runs `work` under the lock from outside a frame. A frame must not wait
   * for it, because the frame already holds the lock.
   */
  outsideFrame: <A, WorkError, R>(work: Effect.Effect<A, WorkError, R>) => Effect.Effect<A, WorkError, R>
  /**
   * Queues `work` and resumes with its outcome once a drain has run it. The
   * queued write itself always succeeds, so a failing `work` fails this
   * caller and not the frame.
   */
  atFrameBoundary: <A, WorkError>(work: Effect.Effect<A, WorkError>) => Effect.Effect<A, WorkError>
}>

export const makeFrameBoundary = <E>(): Effect.Effect<FrameBoundary<E>> =>
  Effect.map(Semaphore.make(1), (lock) => {
    const queue = makeFrameBoundaryQueue<E>()
    const atFrameBoundary = <A, WorkError>(work: Effect.Effect<A, WorkError>): Effect.Effect<A, WorkError> =>
      Effect.flatMap(Deferred.make<A, WorkError>(), (done) =>
        Effect.andThen(
          Effect.sync(() => {
            queue.enqueue(Effect.asVoid(Deferred.into(work, done)))
          }),
          Deferred.await(done),
        ))
    return {
      enqueue: queue.enqueue,
      frame: (body) => Semaphore.withPermit(lock, Effect.andThen(queue.drain, body)),
      drainOutsideFrame: Semaphore.withPermit(lock, queue.drain),
      outsideFrame: (work) => Semaphore.withPermit(lock, work),
      atFrameBoundary,
    }
  })
