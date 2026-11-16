import {
  DEFAULT_GAMEPAD_BINDINGS,
  GAMEPAD_BUTTONS,
  GAMEPLAY_LISTENER_TARGET,
  gamepadButtonIsPressed,
  makeGamepadInputAdapter,
  normalizeGamepadAxes,
  type GamepadAxes,
  type GamepadAxesInputError,
  type GamepadSnapshot,
  type GamepadSource,
  type InputAction,
  type InputServiceApi,
} from '@nerima-games/mc-render'
import type { DeltaTimeSecs } from '@nerima-games/mc-kernel'
import { Effect, Result } from 'effect'

export type HostGamepadInput = {
  readonly poll: Effect.Effect<void, GamepadAxesInputError>
  readonly reset: Effect.Effect<void>
  // The input service dropped every held action (InputServiceApi.clearHeld).
  // Forget the held stick directions so the next poll presses them again,
  // while keeping the button edges: a Start still held is not a new press.
  readonly inputCleared: Effect.Effect<void>
}

export type GamepadLookDelta = {
  readonly x: number
  readonly y: number
}

/**
 * Deflection on the deadzone-rescaled left stick past which a direction counts
 * as held. Movement is digital (`isActionActive`), so the stick is thresholded.
 */
export const GAMEPAD_MOVE_AXIS_THRESHOLD = 0.5

/**
 * Right-stick look speed at full deflection, in the pointer-delta units that
 * frame-input multiplies by `LOOK_SENSITIVITY` (main.ts, 0.0022 rad per unit)
 * and the player's sensitivity setting. At sensitivity 1:
 * 1400 * 0.0022 = 3.08 rad/s, about 176 degrees per second (half a turn per
 * second).
 */
export const GAMEPAD_LOOK_PIXELS_PER_SECOND = 1400

// The DOM Gamepad structurally satisfies GamepadSnapshot (connected, buttons
// with pressed/value, axes), so the browser array is returned as is.
export const browserGamepadSource = (
  navigator: Pick<Navigator, 'getGamepads'>,
): GamepadSource => () => navigator.getGamepads()

const dpadPressed = (pad: GamepadSnapshot, button: (typeof GAMEPAD_BUTTONS)[number]): boolean =>
  gamepadButtonIsPressed(pad.buttons[GAMEPAD_BUTTONS.indexOf(button)])

const moveActionsHeld = (
  pad: GamepadSnapshot,
  axes: GamepadAxes,
): ReadonlyArray<readonly [InputAction, boolean]> => [
  ['moveForward', axes.leftY < -GAMEPAD_MOVE_AXIS_THRESHOLD || dpadPressed(pad, 'dpadUp')],
  ['moveBackward', axes.leftY > GAMEPAD_MOVE_AXIS_THRESHOLD || dpadPressed(pad, 'dpadDown')],
  ['moveLeft', axes.leftX < -GAMEPAD_MOVE_AXIS_THRESHOLD || dpadPressed(pad, 'dpadLeft')],
  ['moveRight', axes.leftX > GAMEPAD_MOVE_AXIS_THRESHOLD || dpadPressed(pad, 'dpadRight')],
]

export const makeHostGamepadInput = (
  input: InputServiceApi,
  source: GamepadSource,
): HostGamepadInput => {
  let frame: ReadonlyArray<GamepadSnapshot | null> = []
  // The dpad is unbound in the adapter: it and the left stick drive the same
  // move actions, which resolve to one keyboard code in the input service, so
  // a release from one source would cancel the other if both dispatched.
  const adapter = makeGamepadInputAdapter(input, () => frame, {
    ...DEFAULT_GAMEPAD_BINDINGS,
    dpadUp: undefined,
    dpadDown: undefined,
    dpadLeft: undefined,
    dpadRight: undefined,
  })
  const heldMoves = new Set<InputAction>()

  const setMoveHeld = (action: InputAction, held: boolean): Effect.Effect<void> => {
    if (held === heldMoves.has(action)) return Effect.void
    if (held) heldMoves.add(action)
    else heldMoves.delete(action)
    return input.dispatch({
      action,
      kind: held ? 'gamepadpress' : 'gamepadrelease',
      target: GAMEPLAY_LISTENER_TARGET,
    })
  }

  const reset = Effect.gen(function* resetHostGamepad() {
    yield* adapter.reset
    for (const action of [...heldMoves]) yield* setMoveHeld(action, false)
  })

  const poll = Effect.gen(function* pollHostGamepad() {
    frame = source()
    const pad = frame.find(
      (candidate): candidate is GamepadSnapshot => candidate !== null && candidate.connected,
    )
    if (pad === undefined) {
      yield* reset
      return
    }
    const axes = normalizeGamepadAxes(pad.axes)
    if (Result.isFailure(axes)) return yield* Effect.fail(axes.failure)
    yield* adapter.poll
    for (const [action, held] of moveActionsHeld(pad, axes.success)) yield* setMoveHeld(action, held)
  }).pipe(Effect.tapError(() => reset))

  const inputCleared = Effect.sync(() => heldMoves.clear())

  return { poll, reset, inputCleared }
}

// DeltaTimeSecs is a validated brand (finite, non-negative), so no re-check.
export const gamepadLookDelta = (axes: GamepadAxes, deltaSecs: DeltaTimeSecs): GamepadLookDelta => ({
  x: axes.rightX * GAMEPAD_LOOK_PIXELS_PER_SECOND * deltaSecs,
  y: axes.rightY * GAMEPAD_LOOK_PIXELS_PER_SECOND * deltaSecs,
})
