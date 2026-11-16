import { describe, expect, it } from '@effect/vitest'
import { Brand, Effect, Result } from 'effect'

import { MonotonicTimeSecs, SimulationTick } from '@nerima-games/mc-kernel'
import type { InputSnapshot } from '@nerima-games/mc-render'
import { DEFAULT_TICK_DURATION } from '@nerima-games/mc-sim'

import {
  FIXED_TICK_SECS,
  HOST_MAX_CATCH_UP_TICKS,
  makeFixedStepFrameLoop,
  type FixedStepFrameLoop,
  type FixedStepTick,
} from '../apps/web/tick/fixed-step-frame'

const reading = (overrides: Partial<InputSnapshot> = {}): InputSnapshot => ({
  pressed: new Set(),
  justPressed: new Set(),
  uiClicks: new Set(),
  uiClickLandings: [],
  pointerDelta: { x: 0, y: 0 },
  wheelNotches: 0,
  wheelSteps: 0,
  pointerLocked: false,
  pointerLockState: 'unlocked',
  keyboardFocus: undefined,
  gamepadAxes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
  ...overrides,
})

const runFrame = (loop: FixedStepFrameLoop, nowSecs: number, input: InputSnapshot = reading()) => {
  const seen: Array<FixedStepTick> = []
  const frame = Effect.runSync(loop.runFrame(
    { nowSecs: MonotonicTimeSecs(nowSecs), input },
    (tick) => Effect.sync(() => { seen.push(tick) }),
  ))
  return { frame, seen }
}

const newLoop = () => Effect.runSync(makeFixedStepFrameLoop())

describe('fixed step frame constants', () => {
  it('uses the 20 Hz mc-sim step and the vanilla ten-tick bound', () => {
    expect(FIXED_TICK_SECS).toBe(DEFAULT_TICK_DURATION)
    expect(FIXED_TICK_SECS).toBeCloseTo(0.05, 10)
    expect(HOST_MAX_CATCH_UP_TICKS).toBe(10)
  })
})

describe('fixed step frame timing', () => {
  it('runs several ticks for a slow frame', () => {
    const loop = newLoop()
    const first = runFrame(loop, 10)
    expect(first.frame.ticks).toBe(0)
    expect(first.seen).toEqual([])

    const { frame, seen } = runFrame(loop, 10.16)

    expect(frame.ticks).toBe(3)
    expect(seen.map((tick) => tick.tick)).toEqual([1, 2, 3])
    expect(seen.map((tick) => tick.index)).toEqual([0, 1, 2])
    expect(frame.simulationTick).toBe(3)
    expect(frame.partialTick).toBeCloseTo(0.2, 6)
    expect(frame.overloaded).toBe(false)
  })

  it('runs no tick for a fast frame and interpolates', () => {
    const loop = newLoop()
    runFrame(loop, 10)

    const fast = runFrame(loop, 10.016)
    expect(fast.frame.ticks).toBe(0)
    expect(fast.seen).toEqual([])
    expect(fast.frame.partialTick).toBeCloseTo(0.32, 5)
    expect(fast.frame.simulationTick).toBe(0)

    const next = runFrame(loop, 10.05)
    expect(next.frame.ticks).toBe(1)
    expect(next.seen.map((tick) => tick.tick)).toEqual([1])
  })

  it('bounds catch-up to ten ticks and drops the excess', () => {
    const loop = newLoop()
    runFrame(loop, 10)

    const stalled = runFrame(loop, 40)
    expect(stalled.frame.ticks).toBe(10)
    expect(stalled.seen.map((tick) => tick.tick)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(stalled.frame.overloaded).toBe(true)

    const after = runFrame(loop, 40.016)
    expect(after.frame.ticks).toBe(0)
    expect(after.seen).toEqual([])
    expect(after.frame.overloaded).toBe(false)
    expect(after.frame.simulationTick).toBe(10)
  })

  it('numbers ticks from the initial tick', () => {
    const loop = Effect.runSync(makeFixedStepFrameLoop(SimulationTick(100)))
    runFrame(loop, 10)
    const { seen } = runFrame(loop, 10.11)
    expect(seen.map((tick) => tick.tick)).toEqual([101, 102])
  })
})

describe('fixed step frame input', () => {
  it('applies edges to the first tick only', () => {
    const loop = newLoop()
    runFrame(loop, 10)

    const { seen } = runFrame(loop, 10.16, reading({
      justPressed: new Set(['KeyE']),
      uiClicks: new Set(['MouseLeft']),
      uiClickLandings: [{ button: 'MouseLeft', landing: 'ui' }],
      pointerDelta: { x: 5, y: -2 },
      wheelSteps: 1,
      wheelNotches: 1.5,
    }))

    expect(seen).toHaveLength(3)
    const [first, second, third] = seen.map((tick) => tick.input)
    expect(first?.justPressed).toEqual(new Set(['KeyE']))
    expect(first?.uiClicks).toEqual(new Set(['MouseLeft']))
    expect(first?.uiClickLandings).toEqual([{ button: 'MouseLeft', landing: 'ui' }])
    expect(first?.pointerDelta).toEqual({ x: 5, y: -2 })
    expect(first?.wheelSteps).toBe(1)
    expect(first?.wheelNotches).toBe(1.5)
    for (const later of [second, third]) {
      expect(later?.justPressed).toEqual(new Set())
      expect(later?.uiClicks).toEqual(new Set())
      expect(later?.uiClickLandings).toEqual([])
      expect(later?.pointerDelta).toEqual({ x: 0, y: 0 })
      expect(later?.wheelSteps).toBe(0)
      expect(later?.wheelNotches).toBe(0.5)
    }
  })

  it('applies held input to every tick', () => {
    const loop = newLoop()
    runFrame(loop, 10)

    const { seen } = runFrame(loop, 10.16, reading({
      pressed: new Set(['KeyW']),
      pointerLocked: true,
      pointerLockState: 'locked',
      gamepadAxes: { leftX: 0.5, leftY: 0, rightX: 0, rightY: 0 },
    }))

    expect(seen).toHaveLength(3)
    for (const { input } of seen) {
      expect(input.pressed).toEqual(new Set(['KeyW']))
      expect(input.pointerLocked).toBe(true)
      expect(input.pointerLockState).toBe('locked')
      expect(input.gamepadAxes).toEqual({ leftX: 0.5, leftY: 0, rightX: 0, rightY: 0 })
    }
  })

  it('carries edges from frames without a tick to the next tick exactly once', () => {
    const loop = newLoop()
    runFrame(loop, 10)

    const frameA = runFrame(loop, 10.016, reading({
      pressed: new Set(['KeyE']),
      justPressed: new Set(['KeyE']),
      uiClickLandings: [{ button: 'MouseLeft', landing: 'elsewhere' }],
      pointerDelta: { x: 1, y: 0 },
      wheelSteps: 1,
      wheelNotches: 1.25,
    }))
    expect(frameA.seen).toEqual([])

    const frameB = runFrame(loop, 10.05, reading({
      justPressed: new Set(['KeyQ']),
      uiClickLandings: [{ button: 'MouseLeft', landing: 'ui' }],
      pointerDelta: { x: 2, y: 0 },
      wheelSteps: 1,
      wheelNotches: 1.25,
    }))

    expect(frameB.seen).toHaveLength(1)
    const consumed = frameB.seen[0]?.input
    expect(consumed?.justPressed).toEqual(new Set(['KeyE', 'KeyQ']))
    expect(consumed?.pressed).toEqual(new Set())
    expect(consumed?.uiClickLandings).toEqual([
      { button: 'MouseLeft', landing: 'elsewhere' },
      { button: 'MouseLeft', landing: 'ui' },
    ])
    expect(consumed?.pointerDelta).toEqual({ x: 3, y: 0 })
    expect(consumed?.wheelSteps).toBe(2)
    expect(consumed?.wheelNotches).toBe(2.25)

    const later = runFrame(loop, 10.11)
    expect(later.seen).toHaveLength(1)
    expect(later.seen[0]?.input.justPressed).toEqual(new Set())
    expect(later.seen[0]?.input.uiClickLandings).toEqual([])
    expect(later.seen[0]?.input.pointerDelta).toEqual({ x: 0, y: 0 })
    expect(later.seen[0]?.input.wheelSteps).toBe(0)
  })
})

describe('fixed step frame failures', () => {
  it('fails with the mc-sim failure when the clock goes backwards and keeps the previous state', () => {
    const loop = newLoop()
    runFrame(loop, 10)
    runFrame(loop, 10.016)
    let ran = 0

    const result = Effect.runSync(Effect.result(loop.runFrame(
      { nowSecs: MonotonicTimeSecs(9), input: reading({ justPressed: new Set(['KeyX']) }) },
      () => Effect.sync(() => { ran += 1 }),
    )))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(Brand.BrandError)
    expect(ran).toBe(0)
    expect(Effect.runSync(loop.partialTick)).toBeCloseTo(0.32, 5)

    // The delta is measured from 10.016, the last accepted instant.
    const next = runFrame(loop, 10.05)
    expect(next.frame.ticks).toBe(1)
    expect(next.seen.map((tick) => tick.tick)).toEqual([1])
    expect(next.seen[0]?.input.justPressed).toEqual(new Set())
  })

  it('stops the frame at a failing tick and propagates its typed error', () => {
    const loop = newLoop()
    runFrame(loop, 10)
    const ran: Array<number> = []

    const result = Effect.runSync(Effect.result(loop.runFrame(
      { nowSecs: MonotonicTimeSecs(10.16), input: reading() },
      ({ index }) => index === 1
        ? Effect.fail({ _tag: 'TickFailed', index })
        : Effect.sync(() => { ran.push(index) }),
    )))

    expect(result).toEqual(Result.fail({ _tag: 'TickFailed', index: 1 }))
    expect(ran).toEqual([0])
    // The advance was committed before the bodies ran, so the time is not replayed.
    expect(Effect.runSync(loop.simulationTick)).toBe(3)
    expect(runFrame(loop, 10.17).frame.ticks).toBe(0)
  })
})

describe('fixed step frame getters', () => {
  it('reports zero before the first frame and the last frame afterwards', () => {
    const loop = newLoop()
    expect(Effect.runSync(loop.partialTick)).toBe(0)
    expect(Effect.runSync(loop.simulationTick)).toBe(0)

    runFrame(loop, 10)
    runFrame(loop, 10.16)

    expect(Effect.runSync(loop.partialTick)).toBeCloseTo(0.2, 6)
    expect(Effect.runSync(loop.simulationTick)).toBe(3)
  })
})
