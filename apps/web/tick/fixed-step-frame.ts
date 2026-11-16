import type { InputSnapshot } from '@nerima-games/mc-render'
import {
  DeltaTimeSecs,
  InterpolationFraction,
  SimulationTick,
  type MonotonicTimeSecs,
  type NonNegativeTickCount,
} from '@nerima-games/mc-kernel'
import {
  advanceFixedStep,
  createFixedStepAccumulator,
  DEFAULT_TICK_DURATION,
  type FixedStepAccumulator,
  type FixedStepFailure,
} from '@nerima-games/mc-sim'
import { Effect, Ref, Result } from 'effect'

// One render frame drives zero or more 20 Hz simulation ticks.
//
// Catch-up bound: like the vanilla client, a frame runs at most
// HOST_MAX_CATCH_UP_TICKS ticks. After a long stall (a background tab, a
// debugger pause) mc-sim's accumulator discards the excess time and reports
// `overloaded`, so the world does not fast-forward through minutes of ticks.
//
// Input: the caller reads the input service once per frame, but ticks consume
// input the way vanilla's KeyMapping does.
// - Level fields (pressed, pointerLocked, pointerLockState, keyboardFocus,
//   gamepadAxes) come from the current reading for every tick.
// - Edge fields (justPressed, uiClicks, uiClickLandings, wheelSteps) are
//   consumed once, by the frame's first tick. A frame that runs
//   no tick carries its edges forward until a tick consumes them, so a key
//   pressed and released between ticks still fires once (and is not held).
// - wheelNotches is not summed into the carry: the input service already keeps
//   the sub-notch remainder in the next reading, so only the whole steps that
//   were carried are added back. Later ticks of a frame see only that remainder.
// - pointerDelta is never passed to a tick, carried or not. The frame turns the
//   camera once from its own reading before the ticks run; a tick that also saw
//   the delta would turn the player a second time.

export const FIXED_TICK_SECS: DeltaTimeSecs = DeltaTimeSecs(DEFAULT_TICK_DURATION)
export const HOST_MAX_CATCH_UP_TICKS = 10

export type FixedStepFrame = {
  readonly ticks: NonNegativeTickCount
  readonly simulationTick: SimulationTick
  readonly partialTick: InterpolationFraction
  readonly overloaded: boolean
}

export type FixedStepTick = {
  readonly input: InputSnapshot
  readonly tick: SimulationTick
  readonly index: number
}

export type FixedStepFrameLoop = {
  readonly runFrame: <E, R>(
    frame: { readonly nowSecs: MonotonicTimeSecs; readonly input: InputSnapshot },
    runTick: (tick: FixedStepTick) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<FixedStepFrame, E | FixedStepFailure, R>
  readonly partialTick: Effect.Effect<InterpolationFraction>
  readonly simulationTick: Effect.Effect<SimulationTick>
}

type InputEdges = Pick<InputSnapshot, 'justPressed' | 'uiClicks' | 'uiClickLandings' | 'wheelSteps'>

type LoopState = {
  readonly accumulator: FixedStepAccumulator
  readonly previousSecs: MonotonicTimeSecs | undefined
  readonly partialTick: InterpolationFraction
  readonly carriedEdges: InputEdges
}

const NO_EDGES: InputEdges = {
  justPressed: new Set(),
  uiClicks: new Set(),
  uiClickLandings: [],
  wheelSteps: 0,
}

const NO_POINTER_DELTA: InputSnapshot['pointerDelta'] = { x: 0, y: 0 }

const mergeEdges = (earlier: InputEdges, later: InputEdges): InputEdges => ({
  justPressed: new Set([...earlier.justPressed, ...later.justPressed]),
  uiClicks: new Set([...earlier.uiClicks, ...later.uiClicks]),
  uiClickLandings: [...earlier.uiClickLandings, ...later.uiClickLandings],
  wheelSteps: earlier.wheelSteps + later.wheelSteps,
})

const tickInputs = (current: InputSnapshot, carried: InputEdges, ticks: number): ReadonlyArray<InputSnapshot> => {
  const first: InputSnapshot = {
    ...current,
    ...mergeEdges(carried, current),
    pointerDelta: NO_POINTER_DELTA,
    wheelNotches: current.wheelNotches + carried.wheelSteps,
  }
  const rest: InputSnapshot = {
    ...current,
    ...NO_EDGES,
    pointerDelta: NO_POINTER_DELTA,
    wheelNotches: first.wheelNotches - first.wheelSteps,
  }
  return Array.from({ length: ticks }, (_, index) => (index === 0 ? first : rest))
}

export const makeFixedStepFrameLoop = (initialTick: SimulationTick = SimulationTick(0)): Effect.Effect<FixedStepFrameLoop> =>
  Effect.map(
    Ref.make<LoopState>({
      accumulator: createFixedStepAccumulator(initialTick, DEFAULT_TICK_DURATION, HOST_MAX_CATCH_UP_TICKS),
      previousSecs: undefined,
      partialTick: InterpolationFraction(0),
      carriedEdges: NO_EDGES,
    }),
    (stateRef): FixedStepFrameLoop => ({
      runFrame: (frame, runTick) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          const rawDelta = state.previousSecs === undefined ? 0 : frame.nowSecs - state.previousSecs
          // A negative delta (clock going backwards) fails here as a BrandError,
          // which is part of FixedStepFailure; the state stays untouched.
          const advanced = yield* Effect.fromResult(
            Result.flatMap(DeltaTimeSecs.result(rawDelta), (delta) => advanceFixedStep(state.accumulator, delta)),
          )
          const ticks = Number(advanced.ticks)
          const inputs = ticks === 0 ? [] : tickInputs(frame.input, state.carriedEdges, ticks)
          // Committed before the tick bodies run, so a failing tick cannot make
          // the next frame replay the elapsed time or the consumed edges.
          yield* Ref.set(stateRef, {
            accumulator: advanced.state,
            previousSecs: frame.nowSecs,
            partialTick: advanced.interpolationFraction,
            carriedEdges: ticks === 0 ? mergeEdges(state.carriedEdges, frame.input) : NO_EDGES,
          })
          const firstTick = advanced.state.tick - ticks + 1
          yield* Effect.forEach(
            inputs,
            (input, index) => runTick({ input, tick: SimulationTick(firstTick + index), index }),
            { discard: true },
          )
          return {
            ticks: advanced.ticks,
            simulationTick: advanced.state.tick,
            partialTick: advanced.interpolationFraction,
            overloaded: advanced.overloaded,
          }
        }),
      partialTick: Effect.map(Ref.get(stateRef), (state) => state.partialTick),
      simulationTick: Effect.map(Ref.get(stateRef), (state) => state.accumulator.tick),
    }),
  )
