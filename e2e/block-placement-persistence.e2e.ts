import { expect, test, type Page } from '@playwright/test'

import { callQa, callQaWithFrames } from './helpers/qa'
import { clearDatabase } from './helpers/database'
import { startGameSession } from './helpers/session'
import { waitForSimulationProgress } from './helpers/simulation-wait'

const SESSION_ID = 'block-placement-persistence-e2e'
const AIR_BLOCK_ID = 0
const STONE_BLOCK_ID = 2

type GameplaySnapshot = {
  readonly mode: 'survival' | 'creative'
  readonly inventory: {
    readonly slots: ReadonlyArray<{ readonly item: string; readonly count: number } | null>
  }
  readonly ignitionTarget: {
    readonly position: { readonly x: number; readonly y: number; readonly z: number }
    readonly block: number | null
  }
}

const snapshot = (page: Page): Promise<GameplaySnapshot> =>
  callQa(page, 'gameplay.snapshot')

const snapshotWithFrames = (page: Page): Promise<{ frames: number; value: GameplaySnapshot }> =>
  callQaWithFrames(page, 'gameplay.snapshot')

const inventoryCount = (current: GameplaySnapshot, item: string): number =>
  current.inventory.slots.reduce(
    (total, slot) => total + (slot?.item === item ? slot.count : 0),
    0,
  )

const grantPointerLock = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
    if (canvas === null) throw new Error('missing game canvas')
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => canvas,
    })
    document.dispatchEvent(new Event('pointerlockchange'))
  })
}

test('places one survival block atomically and restores it across reload', async ({ page }) => {
  await clearDatabase(page)
  await startGameSession(page, SESSION_ID)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  const seeded = await callQa<GameplaySnapshot>(page, 'gameplay.seedCreativePlacementEncounter')
  expect(seeded.mode).toBe('survival')
  expect(seeded.ignitionTarget.block).toBe(AIR_BLOCK_ID)
  expect(inventoryCount(seeded, 'stone')).toBe(2)

  const canvas = page.locator('#game-canvas')
  const placementsBefore = Number(await canvas.getAttribute('data-placements-requested'))
  await canvas.hover()
  await grantPointerLock(page)
  await canvas.click({ button: 'right' })

  // Placement registers once the frame loop processes the click — see
  // waitForSimulationProgress.
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => (
      current.ignitionTarget.block === STONE_BLOCK_ID
      && inventoryCount(current, 'stone') === 1
    ),
    { description: 'survival block placement' },
  )
  expect(Number(await canvas.getAttribute('data-placements-requested'))).toBe(placementsBefore + 1)

  const placed = await snapshot(page)
  await callQa(page, 'persistence.flush')
  await page.reload()
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  const restored = await snapshot(page)
  expect(restored.mode).toBe('survival')
  expect(restored.ignitionTarget).toMatchObject({
    position: placed.ignitionTarget.position,
    block: STONE_BLOCK_ID,
  })
  expect(inventoryCount(restored, 'stone')).toBe(1)
})
