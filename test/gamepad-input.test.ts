import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { DeltaTimeSecs } from '@nerima-games/mc-kernel'
import {
  makeInputService,
  type GamepadSnapshot,
  type InputEvent,
  type InputServiceApi,
} from '@nerima-games/mc-render'

import {
  browserGamepadSource,
  gamepadLookDelta,
  makeHostGamepadInput,
} from '../apps/web/gamepad-input'

// W3C standard-mapping indices (https://w3c.github.io/gamepad/#remapping).
// mc-render 0.13.0 GAMEPAD_BUTTONS omits the two triggers (Start at 7, dpad up
// at 10), so the tests that press these fail until mc-render is fixed.
const START = 9
const DPAD_UP = 12

type PadState = {
  readonly pressed?: ReadonlyArray<number>
  readonly axes?: ReadonlyArray<number>
}

const pad = ({ pressed = [], axes = [0, 0, 0, 0] }: PadState): GamepadSnapshot => ({
  connected: true,
  buttons: Array.from({ length: 17 }, (_, index) => ({
    pressed: pressed.includes(index),
    value: pressed.includes(index) ? 1 : 0,
  })),
  axes,
})

// The real input service with dispatch recorded, so the type is complete and
// held-action state can be read back through isActionActive.
const recordingInput = Effect.gen(function* makeRecordingInput() {
  const service = yield* makeInputService()
  const events: Array<InputEvent> = []
  const input: InputServiceApi = {
    ...service,
    dispatch: (event) => {
      events.push(event)
      return service.dispatch(event)
    },
  }
  const edges = () => events.filter((event) => event.kind !== 'gamepadtick')
  return { input, events, edges }
})

const fixture = Effect.gen(function* makeFixture() {
  const recording = yield* recordingInput
  let pads: ReadonlyArray<GamepadSnapshot | null> = []
  const gamepad = makeHostGamepadInput(recording.input, () => pads)
  const pollWith = (next: ReadonlyArray<GamepadSnapshot | null>) =>
    Effect.gen(function* pollFrame() {
      pads = next
      yield* gamepad.poll
    })
  return { ...recording, gamepad, pollWith }
})

describe('makeHostGamepadInput', () => {
  it.effect('dispatches press and release edges for bound buttons', () =>
    Effect.gen(function* () {
      const { edges, pollWith } = yield* fixture
      yield* pollWith([pad({ pressed: [START] })])
      yield* pollWith([pad({ pressed: [START] })])
      yield* pollWith([pad({})])
      expect(edges()).toEqual([
        { action: 'escape', kind: 'gamepadpress', target: 'window' },
        { action: 'escape', kind: 'gamepadrelease', target: 'window' },
      ])
    }))

  it.effect('reads the source once per poll', () =>
    Effect.gen(function* () {
      const { input } = yield* recordingInput
      let reads = 0
      const gamepad = makeHostGamepadInput(input, () => {
        reads += 1
        return [pad({ pressed: [START] })]
      })
      yield* gamepad.poll
      expect(reads).toBe(1)
    }))

  it.effect('dpad and left stick share moveForward: one press, one release', () =>
    Effect.gen(function* () {
      const { edges, input, pollWith } = yield* fixture
      yield* pollWith([pad({ pressed: [DPAD_UP] })])
      yield* pollWith([pad({ pressed: [DPAD_UP], axes: [0, -1, 0, 0] })])
      // Dpad released while the stick still holds forward.
      yield* pollWith([pad({ axes: [0, -1, 0, 0] })])
      expect(edges()).toEqual([{ action: 'moveForward', kind: 'gamepadpress', target: 'window' }])
      expect(yield* input.isActionActive('moveForward')).toBe(true)
      yield* pollWith([pad({})])
      expect(edges()).toEqual([
        { action: 'moveForward', kind: 'gamepadpress', target: 'window' },
        { action: 'moveForward', kind: 'gamepadrelease', target: 'window' },
      ])
      expect(yield* input.isActionActive('moveForward')).toBe(false)
    }))

  // Deadzone 0.15 rescales |raw| to (|raw| - 0.15) / 0.85, so the 0.5
  // threshold sits at |raw| = 0.575:
  //   raw 0.57 -> 0.42 / 0.85 = 0.4941 (below)
  //   raw 0.58 -> 0.43 / 0.85 = 0.5059 (above)
  it.effect('left stick threshold boundary', () =>
    Effect.gen(function* () {
      const { edges, pollWith } = yield* fixture
      yield* pollWith([pad({ axes: [0.57, 0, 0, 0] })])
      expect(edges()).toEqual([])
      yield* pollWith([pad({ axes: [0.58, 0, 0, 0] })])
      expect(edges()).toEqual([{ action: 'moveRight', kind: 'gamepadpress', target: 'window' }])
      yield* pollWith([pad({ axes: [0, -0.58, 0, 0] })])
      expect(edges()).toEqual([
        { action: 'moveRight', kind: 'gamepadpress', target: 'window' },
        { action: 'moveForward', kind: 'gamepadpress', target: 'window' },
        { action: 'moveRight', kind: 'gamepadrelease', target: 'window' },
      ])
    }))

  it.effect('disconnect releases held actions and sends zero axes', () =>
    Effect.gen(function* () {
      const { edges, events, input, pollWith } = yield* fixture
      yield* pollWith([pad({ pressed: [START], axes: [-1, 0, 0, 0] })])
      yield* pollWith([null, { ...pad({}), connected: false }])
      expect(edges()).toEqual([
        { action: 'escape', kind: 'gamepadpress', target: 'window' },
        { action: 'moveLeft', kind: 'gamepadpress', target: 'window' },
        { action: 'escape', kind: 'gamepadrelease', target: 'window' },
        { action: 'moveLeft', kind: 'gamepadrelease', target: 'window' },
      ])
      expect(events.at(-2)).toEqual({
        kind: 'gamepadtick',
        axes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
      })
      expect(yield* input.isActionActive('moveLeft')).toBe(false)
    }))

  it.effect('invalid axes fail typed and release held actions', () =>
    Effect.gen(function* () {
      const { edges, input, pollWith } = yield* fixture
      yield* pollWith([pad({ pressed: [DPAD_UP] })])
      const outOfRange = yield* Effect.flip(pollWith([pad({ pressed: [DPAD_UP], axes: [2, 0, 0, 0] })]))
      expect(outOfRange).toEqual({ _tag: 'GamepadAxesInputError', reason: 'axis-out-of-range' })
      expect(edges()).toEqual([
        { action: 'moveForward', kind: 'gamepadpress', target: 'window' },
        { action: 'moveForward', kind: 'gamepadrelease', target: 'window' },
      ])
      expect(yield* input.isActionActive('moveForward')).toBe(false)

      const nonFinite = yield* Effect.flip(pollWith([pad({ axes: [Number.NaN, 0, 0, 0] })]))
      expect(nonFinite).toEqual({ _tag: 'GamepadAxesInputError', reason: 'non-finite-axis' })
    }))

  it.effect('reset releases held move actions', () =>
    Effect.gen(function* () {
      const { edges, gamepad, pollWith } = yield* fixture
      yield* pollWith([pad({ axes: [0, 1, 0, 0] })])
      yield* gamepad.reset
      yield* gamepad.reset
      expect(edges()).toEqual([
        { action: 'moveBackward', kind: 'gamepadpress', target: 'window' },
        { action: 'moveBackward', kind: 'gamepadrelease', target: 'window' },
      ])
    }))
})

describe('gamepadLookDelta', () => {
  it('scales full right-stick deflection by the frame delta', () => {
    expect(gamepadLookDelta({ leftX: 0, leftY: 0, rightX: 1, rightY: -1 }, DeltaTimeSecs(0.025)))
      .toEqual({ x: 35, y: -35 })
  })

  it('is zero for a centered stick', () => {
    expect(gamepadLookDelta({ leftX: 1, leftY: 1, rightX: 0, rightY: 0 }, DeltaTimeSecs(0.05)))
      .toEqual({ x: 0, y: 0 })
  })
})

describe('browserGamepadSource', () => {
  it('passes navigator.getGamepads results through', () => {
    const connected: Gamepad = {
      axes: [0.25, 0, 0, 0],
      buttons: [{ pressed: true, touched: true, value: 1 }],
      connected: true,
      hapticActuators: [],
      id: 'fake-pad',
      index: 1,
      mapping: 'standard',
      timestamp: 0,
      vibrationActuator: {
        playEffect: () => Promise.resolve('complete'),
        pulse: () => Promise.resolve(true),
        reset: () => Promise.resolve('complete'),
      },
    }
    const source = browserGamepadSource({ getGamepads: () => [null, connected] })
    const pads = source()
    expect(pads).toEqual([null, connected])
    expect(pads[1]).toBe(connected)
  })
})
