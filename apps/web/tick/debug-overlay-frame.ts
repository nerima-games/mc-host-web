import type { Effect } from 'effect'

export type DebugOverlayFrameInput = Readonly<{
  /** The count after `runFramePresentation` has counted this frame. */
  framesTotal: number
  /** The frame's unclamped interval (`FrameTiming.raw`). */
  raw: number
}>

/**
 * The debug overlay step of a frame, run after the frame's gameplay and inside
 * the frame lock. The first frame's `raw` is the synthetic first-frame
 * interval, not a measurement, so that frame shows no timing.
 */
export const runTickDebugOverlayFrame = <E, R>(
  update: (rawDeltaSecs: number | undefined) => Effect.Effect<void, E, R>,
  { framesTotal, raw }: DebugOverlayFrameInput,
): Effect.Effect<void, E, R> => update(framesTotal === 1 ? undefined : raw)
