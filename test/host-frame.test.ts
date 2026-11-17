import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { DeltaTimeSecs, MonotonicTimeSecs } from '@nerima-games/mc-kernel'
import { makeInputService, type InputServiceApi, type InputSnapshot } from '@nerima-games/mc-render'

import { FIXED_TICK_SECS, makeFixedStepFrameLoop } from '../apps/web/tick/fixed-step-frame'
import {
  runHostFrame,
  tickInputQueries,
  type HostFrameContext,
  type HostFrameTickOutcome,
  type HostPresentedFrame,
} from '../apps/web/tick/host-frame'

type FrameLog = {
  readonly events: Array<string>
  readonly reads: Array<InputSnapshot>
  readonly ended: Array<InputSnapshot | undefined>
  readonly looks: Array<{ readonly input: InputSnapshot; readonly frameDeltaSecs: DeltaTimeSecs }>
  readonly presented: Array<HostPresentedFrame>
  readonly tickEdges: Array<boolean>
}

// The real input service with its reads and frame ends recorded.
const recordedInput = (service: InputServiceApi, log: FrameLog): HostFrameContext<never, never>['input'] => ({
  snapshot: Effect.tap(service.snapshot, (reading) => Effect.sync(() => {
    log.events.push('read')
    log.reads.push(reading)
  })),
  endFrame: (frame) => Effect.andThen(
    Effect.sync(() => {
      log.events.push('end')
      log.ended.push(frame)
    }),
    service.endFrame(frame),
  ),
})

const makeFrame = Effect.gen(function* () {
  const service = yield* makeInputService()
  const fixedStep = yield* makeFixedStepFrameLoop()
  const log: FrameLog = { events: [], reads: [], ended: [], looks: [], presented: [], tickEdges: [] }
  let previous: MonotonicTimeSecs | undefined
  let paused = false
  let tickOutcome: HostFrameTickOutcome = 'continue'
  const context: HostFrameContext<never, never> = {
    input: recordedInput(service, log),
    fixedStep,
    frameDelta: (nowSecs) => {
      const delta = DeltaTimeSecs(previous === undefined ? 0 : nowSecs - previous)
      previous = nowSecs
      return delta
    },
    look: (input, frameDeltaSecs) => {
      log.events.push('look')
      log.looks.push({ input, frameDeltaSecs })
    },
    tick: ({ input }) => Effect.gen(function* () {
      log.events.push('tick')
      log.tickEdges.push(yield* tickInputQueries(service, input).wasActionJustTriggered('openInventory'))
      return tickOutcome
    }),
    presents: () => !paused,
    present: (frame) => Effect.sync(() => {
      log.events.push('present')
      log.presented.push(frame)
    }),
  }
  const frameAt = (nowSecs: number) => runHostFrame(context, MonotonicTimeSecs(nowSecs))
  return {
    service,
    log,
    frameAt,
    pause: () => { paused = true },
    haltTicks: () => { tickOutcome = 'halt' },
  }
})

describe('runHostFrame', () => {
  it.effect('reads, looks, ticks, presents and ends once each, in that order', () =>
    Effect.gen(function* () {
      const { log, frameAt } = yield* makeFrame
      yield* frameAt(10)
      yield* frameAt(10.06)

      expect(log.events).toStrictEqual([
        'read', 'look', 'present', 'end',
        'read', 'look', 'tick', 'present', 'end',
      ])
      // The look and the end receive the object the frame read.
      expect(log.looks.map(({ input }) => input)).toStrictEqual(log.reads)
      expect(log.ended).toStrictEqual(log.reads)
      expect(log.ended[1]).toBe(log.reads[1])
      expect(log.looks[1]?.frameDeltaSecs).toBeCloseTo(0.06, 10)
      expect(log.presented[1]).toMatchObject({ ticks: 1, simulationTick: 1, nowSecs: 10.06 })
    }))

  it.effect('a frame that runs no tick still turns the view and presents with the partial tick', () =>
    Effect.gen(function* () {
      const { log, frameAt } = yield* makeFrame
      yield* frameAt(10)
      yield* frameAt(10.02)

      expect(log.events.filter((event) => event === 'tick')).toStrictEqual([])
      expect(log.looks).toHaveLength(2)
      expect(log.presented[1]?.ticks).toBe(0)
      expect(log.presented[1]?.partialTick).toBeCloseTo(0.4, 6)
      expect(log.presented[1]?.frameDeltaSecs).toBeCloseTo(0.02, 10)
    }))

  it.effect('a paused frame ticks and ends its reading but does not present', () =>
    Effect.gen(function* () {
      const { log, frameAt, pause } = yield* makeFrame
      yield* frameAt(10)
      pause()
      yield* frameAt(10.06)

      expect(log.events.slice(4)).toStrictEqual(['read', 'look', 'tick', 'end'])
    }))

  it.effect('a halted tick stops the frame\'s later ticks and its presentation', () =>
    Effect.gen(function* () {
      const { log, frameAt, haltTicks } = yield* makeFrame
      yield* frameAt(10)
      haltTicks()
      // 0.16 s is three ticks; the first halts the frame.
      yield* frameAt(10.16)

      expect(log.events.slice(4)).toStrictEqual(['read', 'look', 'tick', 'end'])
    }))

  it.effect('a failing tick still ends the frame\'s reading', () =>
    Effect.gen(function* () {
      const service = yield* makeInputService()
      const log: FrameLog = { events: [], reads: [], ended: [], looks: [], presented: [], tickEdges: [] }
      const failing: HostFrameContext<'tick-failed', never> = {
        input: recordedInput(service, log),
        fixedStep: yield* makeFixedStepFrameLoop(),
        frameDelta: () => DeltaTimeSecs(0.05),
        look: () => undefined,
        tick: () => Effect.fail('tick-failed' as const),
        presents: () => true,
        present: () => Effect.void,
      }
      yield* runHostFrame(failing, MonotonicTimeSecs(10))
      const failure = yield* Effect.flip(runHostFrame(failing, MonotonicTimeSecs(10.06)))

      expect(failure).toBe('tick-failed')
      expect(log.ended).toStrictEqual(log.reads)
      expect(log.ended).toHaveLength(2)
    }))
})

describe('tickInputQueries', () => {
  it.effect('a key pressed before a two-tick frame triggers its action on the first tick only', () =>
    Effect.gen(function* () {
      const { service, log, frameAt } = yield* makeFrame
      yield* frameAt(10)
      yield* service.dispatch({ kind: 'keydown', code: 'KeyE', target: 'window' })
      // The service itself reports the edge for the whole frame.
      expect(yield* service.wasActionJustTriggered('openInventory')).toBe(true)
      // Timestamps sit off tick boundaries: mc-sim truncates each delta to
      // whole 1/60,000,000 s units, so an exact 0.1 s can come out as one tick.
      yield* frameAt(10.11)
      yield* frameAt(10.16)

      expect(log.tickEdges).toStrictEqual([true, false, false])
    }))

  it.effect('a key pressed on a frame with no tick triggers on the next frame\'s first tick', () =>
    Effect.gen(function* () {
      const { service, log, frameAt } = yield* makeFrame
      yield* frameAt(10)
      yield* service.dispatch({ kind: 'keydown', code: 'KeyE', target: 'window' })
      yield* frameAt(10.02)
      // The frame's end cleared the service's edge; the loop carried it.
      expect(yield* service.wasActionJustTriggered('openInventory')).toBe(false)
      yield* frameAt(10.06)

      expect(log.tickEdges).toStrictEqual([true])
    }))

  it.effect('reads held actions from the service and never resolves escape', () =>
    Effect.gen(function* () {
      const service = yield* makeInputService()
      yield* service.dispatch({ kind: 'keydown', code: 'KeyW', target: 'window' })
      const reading = yield* service.snapshot
      const queries = tickInputQueries(service, reading)

      expect(yield* queries.isActionActive('moveForward')).toBe(true)
      expect(yield* queries.wasActionJustTriggered('moveForward')).toBe(true)
      expect(yield* queries.wasActionJustTriggered('escape')).toBe(false)
    }))
})

describe('fixed tick delta', () => {
  it('is the 20 Hz step the tick body runs at', () => {
    expect(FIXED_TICK_SECS).toBeCloseTo(0.05, 10)
  })
})
