import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Result } from 'effect'

import { DeltaTimeSecs, MonotonicTimeSecs, position, PositionAxis } from '@nerima-games/mc-kernel'
import { ESCAPE_KEY_CODE, makeInputService, wrapHotbarSelection, type InputAction, type InputSnapshot } from '@nerima-games/mc-render'

import { makeFrameInputBoundary, runTickFrameInput, readFrameTiming } from '../apps/web/tick/frame-input'
import { mutableState, type H5aFrameInputContext } from '../apps/web/tick/h5a-context'
import { consumeNativeInput, EMPTY_NATIVE_INPUT_QUEUE, type NativeInputQueueState } from '../apps/web/native-input-queue'
import { selectedHotbarAfterInput } from '../apps/web/player-experience'
import { TOUCH_LOOK_CONTROLLER_IDLE } from '../apps/web/touch-input'

type FrameInputFixtureOptions = {
  readonly paused?: boolean
  readonly escapePressed?: boolean
  readonly previousSecs?: number
  readonly simulationElapsedSecs?: number
  readonly observerPulses?: ReadonlyArray<readonly [string, number]>
  readonly redstoneDirty?: boolean
  readonly inventoryOpen?: boolean
  readonly tradeOpen?: boolean
  readonly brewingOpen?: boolean
  readonly selectedHotbarIndex?: number
  readonly nativeInputQueue?: NativeInputQueueState
  readonly triggeredActions?: ReadonlyArray<InputAction>
  readonly activeActions?: ReadonlyArray<InputAction>
  readonly wheelSteps?: number
  readonly playerDead?: boolean
  readonly isCreativeMode?: boolean
  readonly pointerLocked?: boolean
  readonly bowInteractionLocked?: boolean
  readonly gamepadAxes?: InputSnapshot['gamepadAxes']
}

const makeFrameInputFixture = (options: FrameInputFixtureOptions = {}) => {
  const calls: Array<string> = []
  let previousSecs: ReturnType<typeof MonotonicTimeSecs> | undefined = MonotonicTimeSecs(options.previousSecs ?? 9.875)
  let simulationElapsedSecs = options.simulationElapsedSecs ?? 0
  let redstoneDirty = options.redstoneDirty ?? false
  let inventoryOpen = options.inventoryOpen ?? false
  let tradeOpen = options.tradeOpen ?? false
  let brewingOpen = options.brewingOpen ?? false
  let selectedHotbarIndex = options.selectedHotbarIndex ?? 0
  let nativeInputQueue = options.nativeInputQueue ?? EMPTY_NATIVE_INPUT_QUEUE
  const playerDead = options.playerDead ?? false
  const observerPulses = new Map(options.observerPulses ?? [])
  const triggeredActions = new Set(options.triggeredActions ?? [])
  const activeActions = new Set(options.activeActions ?? [])
  let sensitivity = 1
  const looks: Array<readonly [number, number]> = []
  const playerPose = {
    feetPosition: position(PositionAxis(0), PositionAxis(64), PositionAxis(0)),
    yawRadians: 0,
    pitchRadians: 0,
  }
  const context: H5aFrameInputContext = {
    firstFrameSecs: 0.016,
    clampDelta: (raw) => {
      calls.push(`clamp:${raw}`)
      return DeltaTimeSecs(Math.min(raw, 0.05))
    },
    inputApi: {
      wasActionJustTriggered: (action) => Effect.succeed(triggeredActions.has(action)),
      isActionActive: (action) => Effect.succeed(activeActions.has(action)),
    },
    state: {
      touchLookState: mutableState(() => TOUCH_LOOK_CONTROLLER_IDLE, () => undefined),
      previousSecs: mutableState(() => previousSecs, (value) => {
        previousSecs = value
        calls.push(`store:${value}`)
      }),
      simulationElapsedSecs: mutableState(() => simulationElapsedSecs, (value) => { simulationElapsedSecs = value }),
      redstoneDirty: mutableState(() => redstoneDirty, (value) => { redstoneDirty = value }),
      inventoryOpen: mutableState(() => inventoryOpen, (value) => { inventoryOpen = value }),
      tradeOpen: mutableState(() => tradeOpen, (value) => { tradeOpen = value }),
      brewingOpen: mutableState(() => brewingOpen, (value) => { brewingOpen = value }),
      selectedHotbarIndex: mutableState(() => selectedHotbarIndex, (value) => { selectedHotbarIndex = value }),
      vehicleControls: mutableState(() => ({ throttle: 0, steering: 0 }), () => undefined),
      nativeInputQueue: mutableState(() => nativeInputQueue, (value) => { nativeInputQueue = value }),
    },
    touchLook: {
      consume: (state) => {
        calls.push('consume-touch')
        return { state, delta: { positionX: 0, positionY: 0 } }
      },
    },
    handlePauseRequest: () => { calls.push('pause') },
    renderCrosshair: (nowSecs) => { calls.push(`crosshair:${nowSecs}`) },
    pointerLock: {
      isLockedToCanvas: () => options.pointerLocked ?? false,
      exit: () => { calls.push('pointer-exit') },
    },
    paused: () => options.paused ?? false,
    observerPulses,
    multiplayer: undefined,
    syncRedstoneSnapshot: () => { calls.push('redstone-sync') },
    isCreativeMode: options.isCreativeMode ?? false,
    survivalHunger: {
      submit: (activity) => Effect.sync(() => { calls.push(`submit:${activity._tag}`) }),
    },
    playerIsDead: () => playerDead,
    syncTouchControls: () => { calls.push('touch-sync') },
    setInventoryOpen: (open, mode) => {
      calls.push(`inventory:${open}:${mode ?? 'default'}`)
      inventoryOpen = open
    },
    setBrewingOpen: (open) => {
      calls.push(`brewing:${open}`)
      brewingOpen = open
    },
    canvas: { setAttribute: () => undefined },
    bowInteractionLocked: () => options.bowInteractionLocked ?? false,
    selectedHotbarAfterInput,
    wrapHotbarSelection,
    sendInventorySelection: (index) => { calls.push(`inventory-selection:${index}`) },
    resetPrimaryAttackGesture: () => { calls.push('reset-attack') },
    sendVitalsCommand: (command) => { calls.push(`vitals:${command.activity}:${command.amount}`) },
    consumeNativeInput,
    playerSettings: () => ({ sensitivity }),
    lookSensitivity: 1,
    playerApi: {
      look: (yaw, pitch) => {
        looks.push([yaw, pitch])
        return Effect.succeed(playerPose)
      },
    },
  }
  const frameInput: InputSnapshot = {
    pressed: new Set(),
    justPressed: new Set(options.escapePressed ? [ESCAPE_KEY_CODE] : []),
    uiClicks: new Set(),
    uiClickLandings: [],
    pointerDelta: { x: 0, y: 0 },
    wheelNotches: options.wheelSteps ?? 0,
    wheelSteps: options.wheelSteps ?? 0,
    pointerLocked: false,
    pointerLockState: 'unlocked',
    keyboardFocus: undefined,
    gamepadAxes: options.gamepadAxes ?? { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
  }

  return {
    calls, context, frameInput, observerPulses, looks,
    setSensitivity: (next: number) => { sensitivity = next },
  }
}

describe('frame input boundary', () => {
  it.effect('preserves a hotbar key delivered after the frame read its selection', () =>
    Effect.gen(function* () {
      const boundary = makeFrameInputBoundary(yield* makeInputService())
      const { input } = boundary
      const fixture = makeFrameInputFixture()
      const context: H5aFrameInputContext = { ...fixture.context, inputApi: input }
      const readSelection = yield* Deferred.make<void>()
      const resumeFrame = yield* Deferred.make<void>()
      const frame = yield* Effect.forkChild(boundary.runFrame((reading) => Effect.gen(function* () {
        runTickFrameInput(context, MonotonicTimeSecs(10), reading)
        expect(context.state.selectedHotbarIndex.get()).toBe(0)
        yield* Deferred.succeed(readSelection, undefined)
        yield* Deferred.await(resumeFrame)
        // The render stage also samples and ends input before the outer host frame ends.
        yield* input.endFrame(yield* input.snapshot)
        yield* input.endFrame(reading)
      })))
      yield* Deferred.await(readSelection)
      yield* input.dispatch({ kind: 'keydown', code: 'Digit4', target: 'window' })
      yield* Deferred.succeed(resumeFrame, undefined)
      yield* Fiber.join(frame)

      yield* boundary.runFrame((reading) => Effect.sync(() => {
        runTickFrameInput(context, MonotonicTimeSecs(10.05), reading)
        expect(context.state.selectedHotbarIndex.get()).toBe(3)
      }))
      expect(yield* input.wasActionJustTriggered('hotbarSlot4')).toBe(false)
    }),
  )

  it.effect('retains a release and repress of a key already present in the reading', () =>
    Effect.gen(function* () {
      const boundary = makeFrameInputBoundary(yield* makeInputService())
      const { input } = boundary
      yield* input.dispatch({ kind: 'keydown', code: 'Digit4', target: 'window' })
      yield* boundary.runFrame((reading) => Effect.gen(function* () {
        expect(reading.justPressed.has('Digit4')).toBe(true)
        yield* input.dispatch({ kind: 'keyup', code: 'Digit4', target: 'window' })
        yield* input.dispatch({ kind: 'keydown', code: 'Digit4', target: 'window' })
        yield* input.endFrame(yield* input.snapshot)
        expect(yield* input.wasActionJustTriggered('hotbarSlot4')).toBe(true)
      }))
      yield* boundary.runFrame((reading) => Effect.sync(() => {
        expect(reading.pressed.has('Digit4')).toBe(true)
        expect(reading.justPressed.has('Digit4')).toBe(true)
      }))
      expect(yield* input.wasActionJustTriggered('hotbarSlot4')).toBe(false)
      expect(yield* input.isActionActive('hotbarSlot4')).toBe(true)
    }),
  )

  it.effect('defers pointer, wheel, mouse and gamepad input without spending unread movement', () =>
    Effect.gen(function* () {
      const boundary = makeFrameInputBoundary(yield* makeInputService())
      const { input } = boundary
      yield* input.dispatch({ kind: 'pointerlockchange', locked: true })
      yield* input.dispatch({ kind: 'pointermove', deltaX: 4, deltaY: -3 })
      yield* input.dispatch({ kind: 'wheel', deltaY: 140, deltaMode: 'pixel' })
      yield* boundary.runFrame((reading) => Effect.gen(function* () {
        expect(reading.pointerDelta).toEqual({ x: 4, y: -3 })
        expect(reading.wheelSteps).toBe(1)
        yield* input.dispatch({ kind: 'pointermove', deltaX: 9, deltaY: 7 })
        yield* input.dispatch({ kind: 'wheel', deltaY: 80, deltaMode: 'pixel' })
        yield* input.dispatch({ kind: 'mousedown', button: 'MouseLeft', target: 'window', landing: 'lock-target' })
        yield* input.dispatch({ kind: 'mouseup', button: 'MouseLeft', target: 'window' })
        yield* input.dispatch({ kind: 'gamepadpress', action: 'jump', target: 'window' })
        yield* input.endFrame(yield* input.snapshot)
        expect(yield* input.wasActionJustTriggered('attack')).toBe(false)
        expect(yield* input.wasActionJustTriggered('jump')).toBe(false)
      }))
      yield* boundary.runFrame((reading) => Effect.gen(function* () {
        expect(reading.pointerDelta).toEqual({ x: 9, y: 7 })
        expect(reading.wheelSteps).toBe(1)
        expect(reading.wheelNotches).toBeCloseTo(1.2)
        expect(yield* input.wasActionJustTriggered('attack')).toBe(true)
        expect(yield* input.isActionActive('attack')).toBe(false)
        expect(yield* input.wasActionJustTriggered('jump')).toBe(true)
      }))
      const after = yield* input.snapshot
      expect(after.pointerDelta).toEqual({ x: 0, y: 0 })
      expect(after.wheelSteps).toBe(0)
      expect(after.wheelNotches).toBeCloseTo(0.2)
      expect(yield* input.wasActionJustTriggered('jump')).toBe(false)
    }),
  )

  it.effect('keeps unread UI clicks in arrival order for the next frame', () =>
    Effect.gen(function* () {
      const boundary = makeFrameInputBoundary(yield* makeInputService())
      const { input } = boundary
      yield* input.dispatch({ kind: 'mousedown', button: 'MouseRight', target: 'window', landing: 'ui' })
      yield* boundary.runFrame((reading) => Effect.gen(function* () {
        expect(reading.uiClickLandings).toEqual([{ button: 'MouseRight', landing: 'ui' }])
        yield* input.dispatch({ kind: 'mousedown', button: 'MouseMiddle', target: 'window', landing: 'elsewhere' })
        yield* input.dispatch({ kind: 'mousedown', button: 'MouseLeft', target: 'window', landing: 'lock-target' })
        yield* input.endFrame(yield* input.snapshot)
      }))
      yield* boundary.runFrame((reading) => Effect.sync(() => {
        expect(reading.uiClickLandings).toEqual([
          { button: 'MouseMiddle', landing: 'elsewhere' },
          { button: 'MouseLeft', landing: 'lock-target' },
        ])
      }))
      expect((yield* input.snapshot).uiClickLandings).toEqual([])
    }),
  )

  it.effect('clearHeld discards queued input without recreating wheel travel from the old reading', () =>
    Effect.gen(function* () {
      const boundary = makeFrameInputBoundary(yield* makeInputService())
      const { input } = boundary
      yield* input.dispatch({ kind: 'pointerlockchange', locked: true })
      yield* input.dispatch({ kind: 'wheel', deltaY: 250, deltaMode: 'pixel' })
      yield* boundary.runFrame(() => Effect.gen(function* () {
        yield* input.dispatch({ kind: 'keydown', code: 'Digit4', target: 'window' })
        yield* input.dispatch({ kind: 'wheel', deltaY: 100, deltaMode: 'pixel' })
        yield* input.clearHeld
        yield* input.dispatch({ kind: 'keydown', code: 'Digit5', target: 'window' })
      }))
      const after = yield* input.snapshot
      expect(after.justPressed).toEqual(new Set(['Digit5']))
      expect(after.pressed).toEqual(new Set(['Digit5']))
      expect(after.wheelNotches).toBe(0)
      expect(after.wheelSteps).toBe(0)
    }),
  )

  it.effect('preserves a typed frame failure and flushes input queued before it', () =>
    Effect.gen(function* () {
      const boundary = makeFrameInputBoundary(yield* makeInputService())
      const failure = { _tag: 'FrameRejected' }
      const result = yield* Effect.result(boundary.runFrame(() =>
        boundary.input.dispatch({ kind: 'keydown', code: 'Digit4', target: 'window' }).pipe(
          Effect.andThen(Effect.fail(failure)),
        )))
      expect(result).toEqual(Result.fail(failure))
      expect(yield* boundary.input.wasActionJustTriggered('hotbarSlot4')).toBe(true)
      yield* boundary.input.endFrame(yield* boundary.input.snapshot)
      expect(yield* boundary.input.wasActionJustTriggered('hotbarSlot4')).toBe(false)
    }),
  )

  it.effect('queues new arrivals behind replay even when the finalizer yields', () =>
    Effect.gen(function* () {
      const source = yield* makeInputService()
      const replayStarted = yield* Deferred.make<void>()
      const resumeReplay = yield* Deferred.make<void>()
      const boundary = makeFrameInputBoundary({
        ...source,
        dispatch: (event) => Deferred.succeed(replayStarted, undefined).pipe(
          Effect.andThen(Deferred.await(resumeReplay)),
          Effect.andThen(source.dispatch(event)),
        ),
      })
      const frame = yield* Effect.forkChild(boundary.runFrame(() =>
        boundary.input.dispatch({ kind: 'keydown', code: 'Digit4', target: 'window' })))
      yield* Deferred.await(replayStarted)
      yield* boundary.input.dispatch({ kind: 'keyup', code: 'Digit4', target: 'window' })
      yield* boundary.input.dispatch({ kind: 'keydown', code: 'Digit5', target: 'window' })
      yield* Deferred.succeed(resumeReplay, undefined)
      yield* Fiber.join(frame)
      const after = yield* boundary.input.snapshot
      expect(after.pressed).toEqual(new Set(['Digit5']))
      expect(after.justPressed).toEqual(new Set(['Digit4', 'Digit5']))
    }),
  )

  it.effect('clearHeld during replay cancels an in-flight press before applying newer input', () =>
    Effect.gen(function* () {
      const source = yield* makeInputService()
      const replayStarted = yield* Deferred.make<void>()
      const resumeReplay = yield* Deferred.make<void>()
      const boundary = makeFrameInputBoundary({
        ...source,
        dispatch: (event) => Deferred.succeed(replayStarted, undefined).pipe(
          Effect.andThen(Deferred.await(resumeReplay)),
          Effect.andThen(source.dispatch(event)),
        ),
      })
      const frame = yield* Effect.forkChild(boundary.runFrame(() =>
        boundary.input.dispatch({ kind: 'keydown', code: 'Digit4', target: 'window' })))
      yield* Deferred.await(replayStarted)
      yield* boundary.input.dispatch({ kind: 'keydown', code: 'Digit6', target: 'window' })
      yield* boundary.input.clearHeld
      yield* boundary.input.dispatch({ kind: 'keydown', code: 'Digit5', target: 'window' })
      yield* Deferred.succeed(resumeReplay, undefined)
      yield* Fiber.join(frame)
      const after = yield* boundary.input.snapshot
      expect(after.pressed).toEqual(new Set(['Digit5']))
      expect(after.justPressed).toEqual(new Set(['Digit5']))
    }),
  )

  it.effect('flushes input after interruption and resumes direct dispatch outside the frame', () =>
    Effect.gen(function* () {
      const boundary = makeFrameInputBoundary(yield* makeInputService())
      const entered = yield* Deferred.make<void>()
      const frame = yield* Effect.forkChild(boundary.runFrame(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))))
      yield* Deferred.await(entered)
      yield* boundary.input.dispatch({ kind: 'keydown', code: 'Digit4', target: 'window' })
      yield* Fiber.interrupt(frame)
      expect(yield* boundary.input.wasActionJustTriggered('hotbarSlot4')).toBe(true)
      yield* boundary.input.dispatch({ kind: 'keyup', code: 'Digit4', target: 'window' })
      expect(yield* boundary.input.isActionActive('hotbarSlot4')).toBe(false)
    }),
  )
})

describe('tick frame timing', () => {
  it('stores the current time and clamps a long frame to the physics limit', () => {
    const order: Array<string> = []
    const timing = readFrameTiming(
      MonotonicTimeSecs(2),
      MonotonicTimeSecs(1.5),
      0.016,
      (nowSecs) => { order.push(`store:${nowSecs}`) },
      (raw) => {
        order.push(`clamp:${raw}`)
        return DeltaTimeSecs(Math.min(raw, 0.05))
      },
    )

    expect(timing).toEqual({ raw: 0.5, deltaSecs: 0.05 })
    expect(order).toEqual(['store:2', 'clamp:0.5'])
  })

  it('uses the fixed first-frame interval when no previous time exists', () => {
    const timing = readFrameTiming(
      MonotonicTimeSecs(10),
      undefined,
      0.016,
      () => undefined,
      DeltaTimeSecs,
    )

    expect(timing).toEqual({ raw: 0.016, deltaSecs: 0.016 })
  })

  it('consumes touch look before handling Escape and records the current time', () => {
    const calls: Array<string> = []
    let previousSecs: ReturnType<typeof MonotonicTimeSecs> | undefined = MonotonicTimeSecs(1)
    const playerPose = {
      feetPosition: position(PositionAxis(0), PositionAxis(64), PositionAxis(0)),
      yawRadians: 0,
      pitchRadians: 0,
    }
    const context: H5aFrameInputContext = {
      firstFrameSecs: 0.016,
      clampDelta: DeltaTimeSecs,
      inputApi: {
        wasActionJustTriggered: () => Effect.succeed(false),
        isActionActive: () => Effect.succeed(false),
      },
      state: {
        touchLookState: mutableState(() => TOUCH_LOOK_CONTROLLER_IDLE, () => undefined),
        previousSecs: mutableState(() => previousSecs, (value) => { previousSecs = value }),
        simulationElapsedSecs: mutableState(() => 0, () => undefined),
        redstoneDirty: mutableState(() => false, () => undefined),
        inventoryOpen: mutableState(() => false, () => undefined),
        tradeOpen: mutableState(() => false, () => undefined),
        brewingOpen: mutableState(() => false, () => undefined),
        selectedHotbarIndex: mutableState(() => 0, () => undefined),
        vehicleControls: mutableState(() => ({ throttle: 0, steering: 0 }), () => undefined),
        nativeInputQueue: mutableState(() => EMPTY_NATIVE_INPUT_QUEUE, () => undefined),
      },
      touchLook: {
        consume: (state) => {
          calls.push('consume-touch')
          return { state, delta: { positionX: 4, positionY: -3 } }
        },
      },
      handlePauseRequest: () => { calls.push('pause') },
      renderCrosshair: (nowSecs: ReturnType<typeof MonotonicTimeSecs>) => {
        calls.push(`crosshair:${nowSecs}`)
      },
      pointerLock: { isLockedToCanvas: () => false, exit: () => undefined },
      paused: () => false,
      observerPulses: new Map(),
      multiplayer: undefined,
      syncRedstoneSnapshot: () => undefined,
      isCreativeMode: false,
      survivalHunger: {
        submit: () => Effect.void,
      },
      playerIsDead: () => false,
      syncTouchControls: () => undefined,
      setInventoryOpen: () => undefined,
      setBrewingOpen: () => undefined,
      canvas: { setAttribute: () => undefined },
      bowInteractionLocked: () => false,
      selectedHotbarAfterInput,
      wrapHotbarSelection,
      sendInventorySelection: () => undefined,
      resetPrimaryAttackGesture: () => undefined,
      sendVitalsCommand: () => undefined,
      consumeNativeInput,
      playerSettings: () => ({ sensitivity: 1 }),
      lookSensitivity: 1,
      playerApi: { look: () => Effect.succeed(playerPose) },
    }
    const frameInput: InputSnapshot = {
      pressed: new Set(),
      justPressed: new Set([ESCAPE_KEY_CODE]),
      uiClicks: new Set(),
      uiClickLandings: [],
      pointerDelta: { x: 0, y: 0 },
      wheelNotches: 0,
      wheelSteps: 0,
      pointerLocked: false,
      pointerLockState: 'unlocked',
      keyboardFocus: undefined,
      gamepadAxes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
    }

    expect(runTickFrameInput(context, MonotonicTimeSecs(2), frameInput)).toBeUndefined()

    expect(previousSecs).toBe(MonotonicTimeSecs(2))
    expect(calls).toEqual(['consume-touch', 'pause', 'crosshair:2'])
  })
})

describe('tick frame input branches', () => {
  it('adds the right stick to the look delta and reads the current sensitivity', () => {
    const fixture = makeFrameInputFixture({ gamepadAxes: { leftX: 0, leftY: 0, rightX: 0.5, rightY: -0.25 } })
    fixture.setSensitivity(2)

    const frame = runTickFrameInput(fixture.context, MonotonicTimeSecs(10), fixture.frameInput)

    // deltaSecs is clamped to 0.05: 0.5 * 1400 * 0.05 = 35 and -0.25 * 1400 * 0.05 = -17.5.
    expect(frame?.looked).toBe(true)
    expect(fixture.looks).toEqual([[-70, 35]])
  })

  it('stores the time and skips simulation while already paused', () => {
    const fixture = makeFrameInputFixture({ paused: true, previousSecs: 4 })

    const frame = runTickFrameInput(fixture.context, MonotonicTimeSecs(10), fixture.frameInput)

    expect(frame).toBeUndefined()
    expect(fixture.context.state.previousSecs.get()).toBe(MonotonicTimeSecs(10))
    expect(fixture.calls).toEqual(['consume-touch', 'crosshair:10', 'store:10'])
  })

  // Hunger and its starvation death moved into the frame (the survival-hunger
  // stage, handled after `runFrame` in player-movement.test.ts), so frame input
  // only closes the player UI of a player who is already dead.
  it('advances clamped time and closes player UI for a dead player without ticking hunger', () => {
    const fixture = makeFrameInputFixture({
      simulationElapsedSecs: 3,
      inventoryOpen: true,
      brewingOpen: true,
      pointerLocked: true,
      playerDead: true,
    })

    const frame = runTickFrameInput(fixture.context, MonotonicTimeSecs(10), fixture.frameInput)

    expect(frame?.raw).toBe(0.125)
    expect(frame?.deltaSecs).toBe(0.05)
    expect(frame?.dead).toBe(true)
    expect(frame?.canUse).toBe(false)
    expect(fixture.context.state.simulationElapsedSecs.get()).toBe(3.05)
    expect(fixture.context.state.inventoryOpen.get()).toBe(false)
    expect(fixture.context.state.brewingOpen.get()).toBe(false)
    expect(fixture.calls).toEqual([
      'consume-touch',
      'store:10',
      'clamp:0.125',
      'touch-sync',
      'inventory:false:default',
      'brewing:false',
      'pointer-exit',
      'reset-attack',
    ])
  })

  it('expires observer pulses at the elapsed-time boundary and syncs redstone once', () => {
    const fixture = makeFrameInputFixture({
      simulationElapsedSecs: 5,
      observerPulses: [['expired', 4.99], ['at-boundary', 5], ['future', 5.01]],
    })

    const frame = runTickFrameInput(fixture.context, MonotonicTimeSecs(10), fixture.frameInput)

    expect(frame?.deltaSecs).toBe(0.05)
    expect(Array.from(fixture.observerPulses.entries())).toEqual([['future', 5.01]])
    expect(fixture.context.state.redstoneDirty.get()).toBe(true)
    expect(fixture.context.state.simulationElapsedSecs.get()).toBe(5.05)
    expect(fixture.calls).toEqual([
      'consume-touch',
      'store:10',
      'clamp:0.125',
      'redstone-sync',
      'touch-sync',
      'reset-attack',
    ])
  })

  it('opens inventory from the bound action and suppresses use for the rest of the frame', () => {
    const fixture = makeFrameInputFixture({ triggeredActions: ['openInventory'] })

    const frame = runTickFrameInput(fixture.context, MonotonicTimeSecs(10), fixture.frameInput)

    expect(frame?.canUse).toBe(false)
    expect(fixture.context.state.inventoryOpen.get()).toBe(true)
    expect(fixture.calls).toEqual([
      'consume-touch',
      'store:10',
      'clamp:0.125',
      'touch-sync',
      'inventory:true:player',
      'reset-attack',
    ])
  })

  it('uses a direct hotbar key before wheel selection', () => {
    const fixture = makeFrameInputFixture({
      selectedHotbarIndex: 6,
      triggeredActions: ['hotbarSlot4'],
      wheelSteps: -2,
    })

    const frame = runTickFrameInput(fixture.context, MonotonicTimeSecs(10), fixture.frameInput)

    expect(frame?.dead).toBe(false)
    expect(fixture.context.state.selectedHotbarIndex.get()).toBe(3)
    expect(fixture.calls).toEqual([
      'consume-touch',
      'store:10',
      'clamp:0.125',
      'touch-sync',
      'reset-attack',
    ])
  })

  it('passes wheel input to hotbar wrapping when no direct slot is selected', () => {
    const fixture = makeFrameInputFixture({ selectedHotbarIndex: 2, wheelSteps: -1 })
    const context: H5aFrameInputContext = {
      ...fixture.context,
      wrapHotbarSelection: (current, steps, size) => {
        fixture.calls.push(`wrap:${current}:${steps}:${size}`)
        return Result.succeed(6)
      },
    }

    const frame = runTickFrameInput(context, MonotonicTimeSecs(10), fixture.frameInput)

    expect(frame?.dead).toBe(false)
    expect(context.state.selectedHotbarIndex.get()).toBe(6)
    expect(fixture.calls).toEqual([
      'consume-touch',
      'store:10',
      'clamp:0.125',
      'touch-sync',
      'wrap:2:-1:9',
      'reset-attack',
    ])
  })

  it('consumes queued native attack and use once while reporting both actions', () => {
    const fixture = makeFrameInputFixture({ nativeInputQueue: { attack: 1, use: 1 } })

    const frame = runTickFrameInput(fixture.context, MonotonicTimeSecs(10), fixture.frameInput)

    expect(frame?.attackTriggered).toBe(true)
    expect(frame?.attackHeld).toBe(true)
    expect(frame?.canUse).toBe(true)
    expect(frame?.useTriggered).toBe(true)
    expect(frame?.useHeld).toBe(false)
    expect(fixture.context.state.nativeInputQueue.get()).toEqual({ attack: 0, use: 0 })
    expect(fixture.calls).toEqual([
      'consume-touch',
      'store:10',
      'clamp:0.125',
      'touch-sync',
      'reset-attack',
      'submit:attack',
    ])
  })
})
