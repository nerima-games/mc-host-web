import { expect, test, type Page } from '@playwright/test'

import { callQa, callQaWithFrames } from './helpers/qa'
import { startGameSession } from './helpers/session'
import { waitForSimulationProgress } from './helpers/simulation-wait'

// Standard gamepad mapping: lower face button = 0, Start = 9.
const JUMP = 0
const START = 9
const NEUTRAL = { pressed: [], axes: [0, 0, 0, 0] }

type PadState = {
  readonly pressed: ReadonlyArray<number>
  readonly axes: ReadonlyArray<number>
}

type GameplaySnapshot = {
  readonly pose: {
    readonly feetPosition: { readonly x: number; readonly y: number; readonly z: number }
    readonly yawRadians: number
  }
  readonly fall: { readonly grounded: boolean }
}

declare global {
  interface Window {
    __E2E_GAMEPAD__?: {
      readonly set: (pad: PadState | null) => number
      readonly polls: () => number
    }
  }
}

const installGamepad = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    let current: PadState | null = null
    let polls = 0
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => {
        polls += 1
        if (current === null) return [null]
        const state = current
        return [{
          axes: state.axes,
          connected: true,
          id: 'e2e-standard-gamepad',
          index: 0,
          mapping: 'standard',
          timestamp: performance.now(),
          buttons: Array.from({ length: 17 }, (_, index) => ({
            pressed: state.pressed.includes(index),
            touched: state.pressed.includes(index),
            value: state.pressed.includes(index) ? 1 : 0,
          })),
          hapticActuators: [],
          vibrationActuator: null,
        }]
      },
    })
    window.__E2E_GAMEPAD__ = {
      set: (state) => { current = state; return polls },
      polls: () => polls,
    }
  })
}

const setPad = async (page: Page, state: PadState | null): Promise<void> => {
  const previousPolls = await page.evaluate((next) => {
    const gamepad = window.__E2E_GAMEPAD__
    if (gamepad === undefined) throw new Error('missing E2E gamepad')
    return gamepad.set(next)
  }, state)
  // The host polls before handling input, including paused frames. A second
  // poll starts only after the first frame completes, settling both input edges.
  await expect.poll(() => page.evaluate(() => {
    const gamepad = window.__E2E_GAMEPAD__
    if (gamepad === undefined) throw new Error('missing E2E gamepad')
    return gamepad.polls()
  })).toBeGreaterThanOrEqual(previousPolls + 2)
}

const snapshotWithFrames = (page: Page): Promise<{ frames: number; value: GameplaySnapshot }> =>
  callQaWithFrames(page, 'gameplay.snapshot')

const pressStart = async (page: Page, axes: ReadonlyArray<number> = NEUTRAL.axes): Promise<void> => {
  await setPad(page, { pressed: [START], axes })
  await setPad(page, { pressed: [], axes })
}

test('gamepad sticks move and turn the player, and the face button jumps and lands', async ({ page }) => {
  await installGamepad(page)
  await startGameSession(page, 'gamepad-movement')
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await callQa(page, 'gameplay.seedSmokeGroundingEncounter')
  const settled = await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (snapshot) => snapshot.fall.grounded,
    { description: 'gamepad player settles onto flat terrain' },
  )

  await setPad(page, { pressed: [], axes: [0, -1, 0, 0] })
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (snapshot) => Math.hypot(
      snapshot.pose.feetPosition.x - settled.pose.feetPosition.x,
      snapshot.pose.feetPosition.z - settled.pose.feetPosition.z,
    ) > 0.5,
    { description: 'left stick moves the player' },
  )
  await setPad(page, NEUTRAL)

  const beforeLook = (await snapshotWithFrames(page)).value.pose.yawRadians
  await setPad(page, { pressed: [], axes: [0, 0, 1, 0] })
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (snapshot) => Math.abs(snapshot.pose.yawRadians - beforeLook) > 0.5,
    { description: 'right stick turns the player' },
  )
  await setPad(page, NEUTRAL)

  const beforeJump = await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (snapshot) => snapshot.fall.grounded,
    { description: 'player is grounded before the gamepad jump' },
  )
  await setPad(page, { pressed: [JUMP], axes: [0, 0, 0, 0] })
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (snapshot) => !snapshot.fall.grounded
      && snapshot.pose.feetPosition.y > beforeJump.pose.feetPosition.y,
    { description: 'face button lifts the player off the ground' },
  )
  await setPad(page, NEUTRAL)
  const landed = await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (snapshot) => snapshot.fall.grounded,
    { description: 'gamepad jump lands back on the ground' },
  )
  expect(landed.pose.feetPosition.y).toBeCloseTo(beforeJump.pose.feetPosition.y, 1)
  await setPad(page, null)
})

test('standard Start pauses and closes settings before dismissing pause', async ({ page }) => {
  await installGamepad(page)
  await startGameSession(page, 'gamepad-pause-settings')
  const body = page.locator('body')
  const pause = page.getByTestId('pause-overlay')
  const settings = page.getByTestId('settings-root')
  await expect(body).toHaveAttribute('data-mc-compose-boot', 'running')

  await pressStart(page)
  await expect(body).toHaveAttribute('data-session-paused', 'true')
  await expect(pause).toBeVisible()
  await page.getByTestId('options-button').click()
  await expect(settings).toBeVisible()

  await pressStart(page)
  await expect(settings).toBeHidden()
  await expect(pause).toBeVisible()
  await expect(body).toHaveAttribute('data-session-paused', 'true')
  await expect(page.getByTestId('options-button')).toBeFocused()
  await setPad(page, null)
})

test('a forward stick held through pause moves again after Resume without another stick input', async ({ page }) => {
  await installGamepad(page)
  await startGameSession(page, 'gamepad-held-stick-resume')
  const body = page.locator('body')
  const pause = page.getByTestId('pause-overlay')
  await expect(body).toHaveAttribute('data-mc-compose-boot', 'running')
  await callQa(page, 'gameplay.seedSmokeGroundingEncounter')
  const settled = await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (snapshot) => snapshot.fall.grounded,
    { description: 'held-stick player settles onto flat terrain' },
  )

  const forwardAxes = [0, -1, 0, 0]
  await setPad(page, { pressed: [], axes: forwardAxes })
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (snapshot) => Math.hypot(
      snapshot.pose.feetPosition.x - settled.pose.feetPosition.x,
      snapshot.pose.feetPosition.z - settled.pose.feetPosition.z,
    ) > 0.5,
    { description: 'forward stick moves before pausing' },
  )

  await pressStart(page, forwardAxes)
  await expect(body).toHaveAttribute('data-session-paused', 'true')
  await expect(pause).toBeVisible()
  const pausedPosition = (await snapshotWithFrames(page)).value.pose.feetPosition

  // Keep the same physical stick state across Resume. Sending a fresh stick
  // edge here would conceal a host that cleared input without restoring holds.
  await page.getByTestId('resume-button').click()
  await expect(pause).toBeHidden()
  await expect(body).toHaveAttribute('data-session-paused', 'false')
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (snapshot) => Math.hypot(
      snapshot.pose.feetPosition.x - pausedPosition.x,
      snapshot.pose.feetPosition.z - pausedPosition.z,
    ) > 0.5,
    { description: 'unchanged forward stick moves after Resume' },
  )
  await setPad(page, NEUTRAL)
  await setPad(page, null)
})
