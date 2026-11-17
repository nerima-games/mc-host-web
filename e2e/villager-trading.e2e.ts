import { expect, test, type Page } from '@playwright/test'

import { callQa, callQaWithFrames } from './helpers/qa'
import { startGameSession } from './helpers/session'
import { waitForSimulationProgress } from './helpers/simulation-wait'

type InventorySlot = null | { readonly item: string; readonly count: number }
type Offer = {
  readonly id: string
  readonly input: { readonly item: string; readonly count: number }
  readonly output: { readonly item: string; readonly count: number }
  readonly uses: number
}
type Snapshot = {
  readonly inventory: { readonly slots: ReadonlyArray<InventorySlot> }
  readonly villagerUi: {
    readonly open: boolean
    readonly activeVillagerId: string | null
    readonly status: string
  }
  readonly villagers: ReadonlyArray<{ readonly id: string }>
  readonly villagerTrades: {
    readonly villagers: ReadonlyArray<{
      readonly id: string
      readonly profession: 'farmer' | 'toolsmith'
      readonly offers: ReadonlyArray<Offer>
    }>
  }
}

const snapshot = (page: Page): Promise<Snapshot> => callQa(page, 'gameplay.snapshot')

const snapshotWithFrames = (page: Page): Promise<{ frames: number; value: Snapshot }> =>
  callQaWithFrames(page, 'gameplay.snapshot')

const inventoryCount = (current: Snapshot, item: string): number =>
  current.inventory.slots.reduce(
    (total, slot) => total + (slot?.item === item ? slot.count : 0),
    0,
  )

const grantPointerLock = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const gameCanvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
    if (gameCanvas === null) throw new Error('missing game canvas')
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => gameCanvas,
    })
    document.dispatchEvent(new Event('pointerlockchange'))
  })
}

test('trades with a generated village resident and persists its stable state', async ({ page }) => {
  await startGameSession(page, `villager-${crypto.randomUUID()}`)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  const seeded = await callQa<Snapshot>(page, 'gameplay.seedVillageTradingEncounter')
  expect(seeded.villagers.length).toBeGreaterThan(0)
  expect(new Set(seeded.villagers.map(({ id }) => id)).size).toBe(seeded.villagers.length)
  expect(seeded.villagers[0]?.id).toMatch(/^village:/)

  await grantPointerLock(page)
  await page.locator('#game-canvas').click({ button: 'right' })
  await expect(page.locator('#trade-root')).toBeVisible()
  const opened = await snapshot(page)
  const villagerId = opened.villagerUi.activeVillagerId
  expect(villagerId).not.toBeNull()
  const offer = opened.villagerTrades.villagers
    .find(({ id }) => id === villagerId)?.offers[0]
  expect(offer).toBeDefined()

  // A trade attempt resolves once the frame loop processes the click — see
  // waitForSimulationProgress.
  await page.locator(`[data-trade-offer-id="${offer!.id}"]`).click()
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.villagerUi.status === 'You do not have the required items',
    { description: 'villager trade rejected for missing items' },
  )
  expect(inventoryCount(await snapshot(page), offer!.output.item)).toBe(0)

  await callQa(page, 'gameplay.grantNearestVillagerTradeInput')
  expect(inventoryCount(await snapshot(page), offer!.input.item)).toBe(offer!.input.count)
  await page.locator(`[data-trade-offer-id="${offer!.id}"]`).click()
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.villagerUi.status === 'Trade complete',
    { description: 'villager trade completes' },
  )
  const traded = await snapshot(page)
  expect(inventoryCount(traded, offer!.input.item)).toBe(0)
  expect(inventoryCount(traded, offer!.output.item)).toBe(offer!.output.count)
  expect(traded.villagerTrades.villagers
    .find(({ id }) => id === villagerId)?.offers[0]?.uses).toBe(1)

  await callQa(page, 'persistence.flush')
  await page.reload()
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  const restored = await snapshot(page)
  expect(restored.villagers.filter(({ id }) => id === villagerId)).toHaveLength(1)
  expect(restored.villagerTrades.villagers
    .find(({ id }) => id === villagerId)?.offers[0]?.uses).toBe(1)
})
