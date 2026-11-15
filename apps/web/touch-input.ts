import {
  createTouchControlRoster as createRenderTouchControlRoster,
  defaultBindings,
  type TouchControlAction,
  type TouchControlRosterError,
  type TouchControlTarget,
  type TouchLookContact,
} from '@nerima-games/mc-render'
import { Result } from 'effect'

// mc-render 0.11 lowered this file's roster and look-drag state machine into
// its browser input adapter, so the host re-exports them instead of keeping a
// second copy that could drift from the adapter that consumes the roster.
export {
  advanceTouchLook,
  consumeTouchLook,
  resetTouchLook,
  TOUCH_CONTROL_ACTIONS,
  TOUCH_LOOK_CONTROLLER_IDLE,
  type ConsumedTouchLook,
  type TouchControlAction,
  type TouchLookContactPhase,
  type TouchLookControllerState,
  type TouchLookResetReason,
} from '@nerima-games/mc-render'

// Every action is required here, unlike mc-render's Partial map, so a missing
// HUD element is a type error at the call site rather than a runtime failure.
export type TouchControlTargets<Target = unknown> = Readonly<
  Record<TouchControlAction, Target>
>

export type TouchContact = TouchLookContact

const rosterErrorMessage = (error: TouchControlRosterError): string => {
  switch (error.reason) {
    case 'unbound-actions':
      return `Touch controls have no input binding: ${error.actions.join(', ')}`
    case 'missing-target':
      return `Touch control target is missing: ${error.action}`
    case 'shared-target':
      return `Touch control target is shared by ${error.owner} and ${error.action}`
  }
}

// Throws rather than returning the Result: the roster is built once from the
// static HUD markup during startup, where any failure is a markup defect with
// no recovery path, and this function's thrown-error contract predates the
// Result-returning mc-render API.
export const createTouchControlRoster = <Target>(
  targets: TouchControlTargets<Target>,
): ReadonlyArray<TouchControlTarget> =>
  Result.getOrThrowWith(
    createRenderTouchControlRoster(targets, defaultBindings()),
    (error) => new Error(rosterErrorMessage(error)),
  )

export type TouchControlsUiState = {
  readonly touchAvailable: boolean
  readonly playing: boolean
  readonly dead: boolean
  readonly inventoryOpen: boolean
  readonly paused: boolean
}

export type TouchControlsPresentation = {
  readonly visible: boolean
  readonly inert: boolean
}

export const touchControlsPresentation = (
  state: TouchControlsUiState,
): TouchControlsPresentation => {
  const visible =
    state.touchAvailable &&
    state.playing &&
    !state.dead &&
    !state.inventoryOpen &&
    !state.paused
  return { visible, inert: !visible }
}
