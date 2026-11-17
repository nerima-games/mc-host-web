import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'

import { callQa, callQaWithFrames } from './helpers/qa'
import { startGameSession } from './helpers/session'
import { waitForSimulationProgress } from './helpers/simulation-wait'

const MAX_OXYGEN_SECS = 15

type SwimmingSnapshot = {
  readonly swimming: {
    readonly active: boolean
    readonly fullySubmerged: boolean
    readonly oxygenSecs: number
    readonly drowningElapsedSecs: number
  }
  readonly environmentalContact: { readonly simulationElapsedSecs: number }
  readonly vitals: { readonly healthPoints: number }
}

const snapshot = (page: Page): Promise<SwimmingSnapshot> =>
  callQa(page, 'gameplay.snapshot')

const snapshotWithFrames = (page: Page): Promise<{ frames: number; value: SwimmingSnapshot }> =>
  callQaWithFrames(page, 'gameplay.snapshot')

test('consumes oxygen, applies drowning damage, and recovers after surfacing', async ({ page }) => {
  const consoleErrors: Array<string> = []
  const pageErrors: Array<string> = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error: Error) => pageErrors.push(`${error.name}: ${error.message}`))

  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await callQa(page, 'gameplay.seedSubmergedSwimmingEncounter')

  // Oxygen depletion, drowning damage, and post-surfacing recovery are all
  // simulated-time-gated (seconds of simulated time draining a per-second
  // counter), not instant UI responses — see waitForSimulationProgress.
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => (
      current.swimming.active
      && current.swimming.fullySubmerged
      && current.swimming.oxygenSecs < MAX_OXYGEN_SECS
    ),
    { description: 'oxygen depletion begins' },
  )
  await expect(page.locator('[data-testid="swimming"]')).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-swimming-pose', 'swimming')

  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.vitals.healthPoints < 20,
    { description: 'drowning damage' },
  )
  const drowned = await snapshot(page)
  expect(drowned.swimming.oxygenSecs).toBe(0)

  await callQa(page, 'gameplay.leaveSubmergedSwimmingEncounter')
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => (
      !current.swimming.active
      && !current.swimming.fullySubmerged
      && current.swimming.oxygenSecs > drowned.swimming.oxygenSecs
    ),
    { description: 'oxygen recovery after surfacing' },
  )
  await expect(page.locator('[data-testid="swimming"]')).toBeHidden()

  const surfaced = await snapshotWithFrames(page)
  let previousHealth = surfaced.value.vitals.healthPoints
  await waitForSimulationProgress(
    page,
    async () => {
      const current = await snapshotWithFrames(page)
      expect(current.value.swimming.active).toBe(false)
      expect(current.value.swimming.fullySubmerged).toBe(false)
      expect(current.value.swimming.oxygenSecs).toBeGreaterThanOrEqual(surfaced.value.swimming.oxygenSecs)
      expect(current.value.swimming.drowningElapsedSecs).toBe(0)
      // Passive regeneration may heal the player while drowning stays stopped.
      expect(current.value.vitals.healthPoints).toBeGreaterThanOrEqual(previousHealth)
      previousHealth = current.value.vitals.healthPoints
      return { frames: current.frames, value: current }
    },
    (current) => current.frames > surfaced.frames
      && current.value.environmentalContact.simulationElapsedSecs
        - surfaced.value.environmentalContact.simulationElapsedSecs > 1.2,
    { description: 'no new drowning across a full damage interval after surfacing' },
  )
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
