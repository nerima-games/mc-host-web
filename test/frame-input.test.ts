import { describe, expect, it } from '@effect/vitest'
import { Effect, Result } from 'effect'

import { DeltaTimeSecs, MonotonicTimeSecs, position, PositionAxis } from '@nerima-games/mc-kernel'
import { ESCAPE_KEY_CODE, wrapHotbarSelection, type InputAction, type InputSnapshot } from '@nerima-games/mc-render'

import { runTickFrameInput, readFrameTiming } from '../apps/web/tick/frame-input'
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
