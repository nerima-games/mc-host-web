import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'

import { callQa, callQaWithFrames } from './helpers/qa'
import { regenerationHeals, type NutritionSnapshot } from './helpers/regeneration'
import { startGameSession } from './helpers/session'
import { waitForSimulationProgress } from './helpers/simulation-wait'

type GameplaySnapshot = {
  readonly pose: {
    readonly feetPosition: { readonly x: number; readonly y: number; readonly z: number }
  }
  readonly dimension: 'overworld' | 'nether'
  readonly vitals: NutritionSnapshot & {
    readonly healthPoints: number
    readonly lastDamageCause?: string
  }
  readonly dead: boolean
  readonly environmentalContact: { readonly simulationElapsedSecs: number }
  readonly fall: {
    readonly grounded: boolean
    readonly accumulatedDistance: number
  }
}

const snapshot = (page: Page): Promise<GameplaySnapshot> =>
  callQa(page, 'gameplay.snapshot')

const snapshotWithFrames = (page: Page): Promise<{ frames: number; value: GameplaySnapshot }> =>
  callQaWithFrames(page, 'gameplay.snapshot')

const startRunningGame = async (page: Page) => {
  const consoleErrors: Array<string> = []
  const pageErrors: Array<string> = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error: Error) => pageErrors.push(`${error.name}: ${error.message}`))
  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  return { consoleErrors, pageErrors }
}

const damageBudgetHealth = (initial: GameplaySnapshot, current: GameplaySnapshot): number => {
  const heals = regenerationHeals(initial.vitals, current.vitals)
  expect(heals).toBeGreaterThanOrEqual(0)
  expect(heals).toBeCloseTo(Math.round(heals), 5)
  return current.vitals.healthPoints - heals
}

const waitForLanding = async (page: Page, initial: GameplaySnapshot, healthPoints: number) => {
  let previous = initial
  let previousFrames: number | undefined
  const read = async () => {
    const current = await snapshotWithFrames(page)
    const value = current.value
    expect(value.pose.feetPosition.x).toBe(initial.pose.feetPosition.x)
    expect(value.pose.feetPosition.z).toBe(initial.pose.feetPosition.z)
    expect(value.environmentalContact.simulationElapsedSecs
      - previous.environmentalContact.simulationElapsedSecs).toBeLessThan(0.5)
    expect(value.environmentalContact.simulationElapsedSecs)
      .toBeGreaterThanOrEqual(previous.environmentalContact.simulationElapsedSecs)
    if (previousFrames !== undefined) expect(current.frames).toBeGreaterThan(previousFrames)
    const heals = regenerationHeals(initial.vitals, value.vitals)
    const previousHeals = regenerationHeals(initial.vitals, previous.vitals)
    expect(heals).toBeGreaterThanOrEqual(previousHeals)
    if (heals > previousHeals) expect(value.vitals.foodTimerSecs).toBeLessThan(previous.vitals.foodTimerSecs)
    previous = value
    previousFrames = current.frames
    return { frames: current.frames, value: { snapshot: value, adjustedHealth: damageBudgetHealth(initial, value) } }
  }
  // Falling and landing are physics simulated over several frames, not
  // instant — see waitForSimulationProgress.
  await waitForSimulationProgress(
    page,
    read,
    (current) => (
      current.snapshot.fall.grounded
      && current.snapshot.pose.feetPosition.y === 65
      && current.adjustedHealth === healthPoints
    ),
    { description: 'fall landing' },
  )
  return read
}

test('keeps a normal-physics fall within the safe distance harmless', async ({ page }) => {
  const faults = await startRunningGame(page)
  const seeded = await callQa<GameplaySnapshot>(page, 'gameplay.seedSafeFall')
  expect(seeded.pose.feetPosition.y - 65).toBeLessThanOrEqual(3)

  const read = await waitForLanding(page, seeded, 20)
  await page.waitForTimeout(150)
  expect((await read()).value.adjustedHealth).toBe(20)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('applies ceil(distance - 3) once for a damaging landing', async ({ page }) => {
  const faults = await startRunningGame(page)
  const seeded = await callQa<GameplaySnapshot>(page, 'gameplay.seedDamagingFall')
  expect(seeded.pose.feetPosition.y - 65).toBe(7)

  const read = await waitForLanding(page, seeded, 16)
  await page.waitForTimeout(150)
  expect((await read()).value.adjustedHealth).toBe(16)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('uses the existing death and respawn flow for a lethal landing', async ({ page }) => {
  const faults = await startRunningGame(page)
  await callQa<GameplaySnapshot>(page, 'gameplay.seedLethalFall')

  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.dead,
    { description: 'lethal fall landing' },
  )
  const dead = await snapshot(page)
  expect(dead.vitals.healthPoints).toBe(0)
  expect(dead.vitals.lastDamageCause).toBe('fall')

  const respawned = await callQa<GameplaySnapshot>(page, 'gameplay.respawn')
  expect(respawned.dead).toBe(false)
  expect(respawned.vitals.healthPoints).toBe(20)
  await page.waitForTimeout(150)
  expect((await snapshot(page)).vitals.healthPoints).toBe(20)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('does not replay a consumed landing after a dimension change', async ({ page }) => {
  const faults = await startRunningGame(page)
  const seeded = await callQa<GameplaySnapshot>(page, 'gameplay.seedDamagingFall')
  await waitForLanding(page, seeded, 16)

  const changed = await callQa<GameplaySnapshot>(page, 'gameplay.enterNether')
  expect(changed.dimension).toBe('nether')
  expect(damageBudgetHealth(seeded, changed)).toBe(16)
  await page.waitForTimeout(150)
  const stable = await snapshot(page)
  expect(stable.dimension).toBe('nether')
  expect(damageBudgetHealth(seeded, stable)).toBe(16)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})
