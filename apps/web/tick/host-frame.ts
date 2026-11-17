import { bindingFor, type InputServiceApi, type InputSnapshot } from '@nerima-games/mc-render'
import type { DeltaTimeSecs, MonotonicTimeSecs } from '@nerima-games/mc-kernel'
import type { FixedStepFailure } from '@nerima-games/mc-sim'

import { Effect } from 'effect'

import type { FixedStepFrame, FixedStepFrameLoop, FixedStepTick } from './fixed-step-frame'
import { readFrameTiming, type FrameTiming } from './frame-input'
import type { H5aFrameInputContext, MutableState } from './h5a-context'

/** `halt` ends the frame's ticks and skips its presentation. */
export type HostFrameTickOutcome = 'continue' | 'halt'

export type HostPresentedFrame = FixedStepFrame & {
  /** `raw` is the unclamped wall-clock delta; `deltaSecs` is what stages integrate. */
  readonly timing: FrameTiming
  readonly nowSecs: MonotonicTimeSecs
}

export type HostFrameContext<TickError, PresentError> = {
  readonly input: Pick<InputServiceApi, 'snapshot' | 'endFrame'>
  readonly fixedStep: Pick<FixedStepFrameLoop, 'runFrame'>
  /** The previous frame's instant; the frame reads and advances it once. */
  readonly previousFrameSecs: MutableState<MonotonicTimeSecs | undefined>
  readonly firstFrameSecs: number
  readonly clampDelta: (raw: number) => DeltaTimeSecs
  readonly look: (input: InputSnapshot, frameDeltaSecs: DeltaTimeSecs) => void
  readonly tick: (tick: FixedStepTick) => Effect.Effect<HostFrameTickOutcome, TickError>
  /** False while the game is paused: a paused frame draws nothing. */
  readonly presents: () => boolean
  readonly present: (frame: HostPresentedFrame) => Effect.Effect<void, PresentError>
}

/**
 * One render frame, F2 to F7 of the render/tick split: read the input once,
 * turn the view once, run zero to ten fixed ticks from that reading, present
 * once at the frame delta, and end that same reading once. The view turns and
 * the reading ends even on a frame that runs no tick or fails.
 */
export const runHostFrame = <TickError, PresentError>(
  context: HostFrameContext<TickError, PresentError>,
  nowSecs: MonotonicTimeSecs,
): Effect.Effect<void, TickError | PresentError | FixedStepFailure> => Effect.gen(function* () {
  const frameInput = yield* context.input.snapshot
  yield* Effect.gen(function* () {
    const timing = readFrameTiming(
      nowSecs,
      context.previousFrameSecs.get(),
      context.firstFrameSecs,
      context.previousFrameSecs.set,
      context.clampDelta,
    )
    context.look(frameInput, timing.deltaSecs)
    let halted = false
    const stepped = yield* context.fixedStep.runFrame({ nowSecs, input: frameInput }, (tick) => Effect.gen(function* () {
      if (halted) return
      halted = (yield* context.tick(tick)) === 'halt'
    }))
    if (halted || !context.presents()) return
    yield* context.present({ ...stepped, timing, nowSecs })
  }).pipe(Effect.ensuring(context.input.endFrame(frameInput)))
})

/**
 * The input queries one tick reads, answered from that tick's input rather than
 * from the input service. The fixed-step loop gives a frame's edges to its first
 * tick only and carries them over a frame with no tick, while the service keeps
 * them until the frame's single `endFrame`. Actions resolve through the
 * service's bindings, as the service's own `wasActionJustTriggered` does.
 */
export const tickInputQueries = (
  inputApi: Pick<InputServiceApi, 'bindings' | 'isActionActive'>,
  input: InputSnapshot,
): H5aFrameInputContext['inputApi'] => ({
  isActionActive: inputApi.isActionActive,
  wasActionJustTriggered: (action) => Effect.map(inputApi.bindings, (bindings) => {
    const code = bindingFor(bindings, action)
    return code !== undefined && input.justPressed.has(code)
  }),
})
