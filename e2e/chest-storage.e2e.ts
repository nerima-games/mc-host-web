import { itemComponents, type ItemComponents } from '@nerima-games/mc-kernel'
import { expect, test, type Page } from '@playwright/test'
import { Result } from 'effect'

import { callQa, callQaWithFrames } from './helpers/qa'
import { clearDatabase } from './helpers/database'
import { startGameSession } from './helpers/session'
import { waitForSimulationProgress } from './helpers/simulation-wait'

type StoredStack = {
  item: string
  count: number
  components: ItemComponents
  durability: { current: number; max: number } | null
}

type GameplaySnapshot = {
  target: { block: number }
  inventory: {
    slots: Array<{ item: string; count: number; components: ItemComponents } | null>
    durability: Array<{ current: number; max: number } | null>
  }
  containerStorage: {
    containers: Array<{
      id: string
      slots: Array<StoredStack | null>
    }>
  }
  itemMetadata: {
    customNames: Record<string, string>
    enchantedItems: Record<
      string,
      {
        item: string
        durability: { current: number; max: number } | null
        enchantments: Array<{ id: string; level: number }>
      }
    >
  }
  entities: Array<{
    item?: string
    count?: number
    durability?: { current: number; max: number } | null
  }>
}

const snapshotWithFrames = (page: Page): Promise<{ frames: number; value: GameplaySnapshot }> =>
  callQaWithFrames(page, 'gameplay.snapshot')

const grantPointerLock = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const gameCanvas = document.querySelector('#game-canvas')
    if (gameCanvas === null) {
      throw new Error('Game canvas is unavailable')
    }
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => gameCanvas,
    })
    document.dispatchEvent(new Event('pointerlockchange'))
  })
}

const openTargetedChest = async (page: Page): Promise<void> => {
  const canvas = page.locator('#game-canvas')
  await canvas.hover()
  await grantPointerLock(page)
  await canvas.click({ button: 'right' })
  await expect(page.locator('[data-mx-ui="chest-storage"]')).toBeVisible()
}

const mineCurrentTarget = async (page: Page): Promise<void> => {
  const canvas = page.locator('#game-canvas')
  const requestedBefore = Number(await canvas.getAttribute('data-breaks-requested'))
  const completedBefore = Number(await canvas.getAttribute('data-breaks-completed'))
  await canvas.hover()
  await grantPointerLock(page)
  await page.mouse.down({ button: 'left' })
  // Mining accumulates progress over simulated frames — see
  // waitForSimulationProgress.
  try {
    await waitForSimulationProgress(
      page,
      () => canvas.evaluate((element) => ({
        frames: Number(document.body.getAttribute('data-frames')),
        value: element.getAttribute('data-breaks-requested'),
      })),
      (value) => value === String(requestedBefore + 1),
      { description: 'mining break request' },
    )
  } finally {
    await page.mouse.up({ button: 'left' })
  }
  await waitForSimulationProgress(
    page,
    () => canvas.evaluate((element) => ({
      frames: Number(document.body.getAttribute('data-frames')),
      value: element.getAttribute('data-breaks-completed'),
    })),
    (value) => value === String(completedBefore + 1),
    { description: 'mining break completion' },
  )
}

const waitForGame = async (page: Page): Promise<void> => {
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await expect(page.locator('[data-mx-ui="hotbar"] [data-mx-ui="slot"]')).toHaveCount(9)
}

test('moves, persists, and spills chest contents', async ({ page }) => {
  await clearDatabase(page)
  await startGameSession(page, 'chest-storage-e2e')
  await waitForGame(page)
  await callQa(page, 'gameplay.seedCraftingLog')
  await callQa(page, 'gameplay.setPose', 105)

  await openTargetedChest(page)
  const chest = page.locator('[data-mx-ui="chest-storage"]')
  await chest
    .locator('[data-region="player-hotbar"] [data-interaction-slot="0"]')
    .click()
  await chest.locator('[data-region="chest"] [data-interaction-slot="0"]').click()

  await expect(chest.getByText('Moved 1 oak_log')).toBeVisible()
  let snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  expect(snapshot.containerStorage.containers).toHaveLength(1)
  expect(snapshot.containerStorage.containers[0]?.id).toMatch(/^overworld:/)
  expect(snapshot.containerStorage.containers[0]?.slots[0]).toEqual({
    item: 'oak_log',
    count: 1,
    components: Result.getOrThrow(itemComponents('oak_log')),
    durability: null,
  })

  await chest.getByRole('button', { name: 'Close chest' }).click()
  await callQa(page, 'persistence.flush')
  await page.reload()
  await waitForGame(page)

  await openTargetedChest(page)
  await expect(
    chest.getByRole('button', { name: 'Chest slot 1, Oak Log, 1', exact: true }),
  ).toBeVisible()
  snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  expect(snapshot.containerStorage.containers[0]?.slots[0]).toEqual({
    item: 'oak_log',
    count: 1,
    components: Result.getOrThrow(itemComponents('oak_log')),
    durability: null,
  })

  await page.getByRole('button', { name: 'Close chest' }).click()
  await mineCurrentTarget(page)
  // Block destruction settling and the dropped item's pickup both need
  // several simulated frames to complete — see waitForSimulationProgress.
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.target.block === 0,
    { description: 'chest block destruction' },
  )

  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.inventory.slots.findIndex((slot) => slot?.item === 'oak_log') >= 0,
    { description: 'dropped oak_log pickup' },
  )

  snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  expect(snapshot.containerStorage.containers).toEqual([])
  const pickedUpSlot = snapshot.inventory.slots.findIndex((slot) => slot?.item === 'oak_log')
  expect(snapshot.inventory.slots[pickedUpSlot]).toEqual({
    item: 'oak_log',
    count: 1,
    components: Result.getOrThrow(itemComponents('oak_log')),
  })
  expect(snapshot.inventory.durability[pickedUpSlot]).toBeNull()
})

test('moves chest item metadata without merging incompatible stacks', async ({ page }) => {
  await clearDatabase(page)
  await startGameSession(page, 'chest-item-metadata-e2e')
  await waitForGame(page)
  await callQa(page, 'gameplay.seedChestTransferMetadata')
  await callQa(page, 'gameplay.setPose', 105)

  await openTargetedChest(page)
  const chest = page.locator('[data-mx-ui="chest-storage"]')
  await chest.locator('[data-region="player-hotbar"] [data-interaction-slot="0"]').click()
  await chest.locator('[data-region="chest"] [data-interaction-slot="0"]').click()

  let snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  const containerId = snapshot.containerStorage.containers[0]?.id
  expect(containerId).toBeDefined()
  const containerKey = `container:${containerId}:0`
  expect(snapshot.itemMetadata.customNames['0']).toBeUndefined()
  expect(snapshot.itemMetadata.customNames[containerKey]).toBe('Silk Runner')
  expect(snapshot.itemMetadata.enchantedItems['0']).toBeUndefined()
  expect(snapshot.itemMetadata.enchantedItems[containerKey]).toMatchObject({
    item: 'diamond_pickaxe',
    enchantments: [{ id: 'efficiency', level: 5 }],
  })

  await chest.getByRole('button', { name: 'Close chest' }).click()
  await callQa(page, 'persistence.flush')
  await page.reload()
  await waitForGame(page)
  await openTargetedChest(page)

  snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  expect(snapshot.itemMetadata.customNames[containerKey]).toBe('Silk Runner')
  expect(snapshot.itemMetadata.enchantedItems[containerKey]).toMatchObject({
    item: 'diamond_pickaxe',
    enchantments: [{ id: 'efficiency', level: 5 }],
  })

  await callQa(page, 'gameplay.seedChestTransferMetadataConflict')
  await chest.locator('[data-region="chest"] [data-interaction-slot="0"]').click()
  await chest.locator('[data-region="player-hotbar"] [data-interaction-slot="0"]').click()
  await expect(chest.getByText('Destination contains different item metadata')).toBeVisible()

  snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  expect(snapshot.itemMetadata.customNames['0']).toBe('Fortune Runner')
  expect(snapshot.itemMetadata.customNames[containerKey]).toBe('Silk Runner')

  await chest.locator('[data-region="player-hotbar"] [data-interaction-slot="1"]').click()
  await expect(chest.getByText('Moved 1 diamond_pickaxe')).toBeVisible()

  snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  expect(snapshot.containerStorage.containers[0]?.slots[0]).toBeNull()
  expect(snapshot.itemMetadata.customNames[containerKey]).toBeUndefined()
  expect(snapshot.itemMetadata.customNames['0']).toBe('Fortune Runner')
  expect(snapshot.itemMetadata.customNames['1']).toBe('Silk Runner')
  expect(snapshot.itemMetadata.enchantedItems[containerKey]).toBeUndefined()
  expect(snapshot.itemMetadata.enchantedItems['0']).toMatchObject({
    enchantments: [{ id: 'fortune', level: 3 }],
  })
  expect(snapshot.itemMetadata.enchantedItems['1']).toMatchObject({
    enchantments: [{ id: 'efficiency', level: 5 }],
  })
})

test('retains chest item metadata through destruction, pickup, and reload', async ({ page }) => {
  await clearDatabase(page)
  await startGameSession(page, 'chest-dropped-item-metadata-e2e')
  await waitForGame(page)
  await callQa(page, 'gameplay.seedChestTransferMetadata')
  await callQa(page, 'gameplay.setPose', 105)

  await openTargetedChest(page)
  const chest = page.locator('[data-mx-ui="chest-storage"]')
  await chest.locator('[data-region="player-hotbar"] [data-interaction-slot="0"]').click()
  await chest.locator('[data-region="chest"] [data-interaction-slot="0"]').click()
  await chest.getByRole('button', { name: 'Close chest' }).click()
  await mineCurrentTarget(page)

  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.inventory.slots.findIndex((slot) => slot?.item === 'diamond_pickaxe') >= 0,
    { description: 'dropped diamond_pickaxe pickup' },
  )

  let snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  const pickedUpSlot = snapshot.inventory.slots
    .findIndex((slot) => slot?.item === 'diamond_pickaxe')
  expect(snapshot.containerStorage.containers).toEqual([])
  expect(snapshot.itemMetadata.customNames[String(pickedUpSlot)]).toBe('Silk Runner')
  expect(snapshot.itemMetadata.enchantedItems[String(pickedUpSlot)]).toMatchObject({
    item: 'diamond_pickaxe',
    enchantments: [{ id: 'efficiency', level: 5 }],
  })

  await callQa(page, 'persistence.flush')
  await page.reload()
  await waitForGame(page)
  snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  const restoredSlot = snapshot.inventory.slots
    .findIndex((slot) => slot?.item === 'diamond_pickaxe')
  expect(snapshot.itemMetadata.customNames[String(restoredSlot)]).toBe('Silk Runner')
  expect(snapshot.itemMetadata.enchantedItems[String(restoredSlot)]).toMatchObject({
    item: 'diamond_pickaxe',
    enchantments: [{ id: 'efficiency', level: 5 }],
  })
})

test('discards restored custom names without a backing stack', async ({ page }) => {
  await clearDatabase(page)
  await startGameSession(page, 'stale-custom-name-e2e')
  await waitForGame(page)
  await callQa(page, 'gameplay.seedStaleCustomNames')
  await callQa(page, 'persistence.flush')
  await page.reload()
  await waitForGame(page)

  const snapshot = await callQa<GameplaySnapshot>(page, 'gameplay.snapshot')
  expect(snapshot.itemMetadata.customNames['35']).toBeUndefined()
  expect(snapshot.itemMetadata.customNames['equipment:head']).toBeUndefined()
  expect(snapshot.itemMetadata.customNames['unknown:slot']).toBeUndefined()
})
