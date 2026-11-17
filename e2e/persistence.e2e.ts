import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'
import { DROPPED_ITEM_PICKUP_RADIUS, isDroppedItemBehaviour, isHostileMobSnapshot } from '@nerima-games/mx-gameplay'
import { Result, Schema } from 'effect'
import { SaveEnvelopeSchema, SaveFormatVersion, sealSaveEnvelope, type SaveEnvelope } from '@nerima-games/mc-save'

import type { SessionHead } from '../apps/web/session-persistence'
import { callQa, callQaWithFrames } from './helpers/qa'
import { clearDatabase, DATABASE_NAME } from './helpers/database'
import {
  SESSION_SAVE_INCOMPATIBLE_MESSAGE,
  SESSION_SAVE_STORAGE_FAILURE_MESSAGE,
} from '../apps/web/session-save-coordinator'
import {
  SESSION_CHECKPOINT_OPENED_MESSAGE,
  SESSION_FUTURE_VERSION_MESSAGE,
} from '../apps/web/session-restoration'
import { startGameSession } from './helpers/session'
import { waitForSimulationProgress } from './helpers/simulation-wait'

const SAVED_MARKER_KEY = '__mcComposeSawSavedPersistence'
const AIR_BLOCK_ID = 0
const STONE_BLOCK_ID = 2
const OBSIDIAN_BLOCK_ID = 40
const NETHER_PORTAL_BLOCK_ID = 118

type Position = { readonly x: number; readonly y: number; readonly z: number }
type Pose = {
  readonly feetPosition: Position
  readonly yawRadians: number
  readonly pitchRadians: number
}
type InventorySlot = null | {
  readonly item?: string
  readonly itemId?: string
  readonly count: number
}
type GameplaySnapshot = {
  readonly pose: Pose
  readonly dimension: string
  readonly activeChunkDimension: string
  readonly dead: boolean
  readonly entities: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly feetPosition: Position
    readonly healthPoints: number
    readonly behaviour: unknown
  }>
  readonly renderedEntities: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly category: string
    readonly feetPosition: Position
  }>
  readonly weather: {
    readonly weather: 'clear' | 'rain' | 'thunder'
    readonly remainingSecs: number
  }
  readonly vitals: {
    readonly healthPoints: number
    readonly foodTimerSecs: number
    readonly [key: string]: unknown
  }
  readonly inventory: { readonly slots: ReadonlyArray<InventorySlot> }
  readonly villagerTrades: { readonly restockElapsedSecs: number }
  readonly itemMetadata: {
    readonly customNames: Readonly<Record<string, string>>
    readonly enchantedItems: Readonly<Record<string, {
      readonly item: string
      readonly durability: number
      readonly enchantments: ReadonlyArray<{ readonly id: string; readonly level: number }>
    }>>
  }
  readonly target: {
    readonly position: Position
    readonly reading: string
    readonly block: number | null
  }
  readonly portals: ReadonlyArray<{
    readonly dimension: string
    readonly position: Position
  }>
  readonly activePortal: null | {
    readonly anchor: Position
    readonly interiorBlock: number | null
    readonly framePosition: Position
    readonly frameBlock: number | null
  }
  readonly environmentalContact: {
    readonly simulationElapsedSecs: number
    readonly lastDamageElapsedSecs: number | null
    readonly cells: ReadonlyArray<{
      readonly position: Position
      readonly block: 'lava' | 'cactus'
      readonly contactDamage: number
    }>
  }
}

type PageFaults = {
  readonly consoleErrors: ReadonlyArray<string>
  readonly pageErrors: ReadonlyArray<string>
}

const watchForFaults = (page: Page): PageFaults => {
  const consoleErrors: Array<string> = []
  const pageErrors: Array<string> = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error: Error) => pageErrors.push(`${error.name}: ${error.message}`))
  return { consoleErrors, pageErrors }
}

const snapshot = (page: Page): Promise<GameplaySnapshot> =>
  callQa(page, 'gameplay.snapshot')

const snapshotWithFrames = (page: Page): Promise<{ frames: number; value: GameplaySnapshot }> =>
  callQaWithFrames(page, 'gameplay.snapshot')

const hotbarText = (page: Page): Promise<ReadonlyArray<string | null>> =>
  page.locator('[data-mx-ui="hotbar"] [data-mx-ui="slot"]').allTextContents()

// A save that completes while the player keeps drifting can flip
// `data-session-persistence` to 'saved' for as little as one frame before the
// next drift-driven dirty event overwrites it — too narrow a window for
// polling the attribute from outside the page to reliably catch. A
// MutationObserver installed inside the page latches the instant it happens,
// regardless of how often the test later checks in.
const watchForSavedPersistence = (page: Page): Promise<void> =>
  page.evaluate(({ key }) => {
    const globalScope = globalThis as unknown as Record<string, boolean>
    const body = document.body
    const latch = (): void => {
      if (body.getAttribute('data-session-persistence') === 'saved') globalScope[key] = true
    }
    globalScope[key] = false
    latch()
    new MutationObserver(latch).observe(body, {
      attributes: true,
      attributeFilter: ['data-session-persistence'],
    })
  }, { key: SAVED_MARKER_KEY })

const sawSavedPersistenceWithFrames = (
  page: Page,
): Promise<{ frames: number; value: boolean }> =>
  page.evaluate(({ key }) => ({
    frames: Number(document.body.getAttribute('data-frames')),
    value: (globalThis as unknown as Record<string, boolean>)[key] === true,
  }), { key: SAVED_MARKER_KEY }) as Promise<{ frames: number; value: boolean }>

const seedGroundedMiningEncounter = async (page: Page): Promise<void> => {
  await callQa(page, 'gameplay.seedSmokeGroundingEncounter')
  await callQa(page, 'gameplay.setPose', STONE_BLOCK_ID)
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-player-grounded', 'true')
}

const SAVE_STORE_NAME = 'saves'
// One above the session format this build writes (SESSION_FORMAT_VERSION).
const NEWER_SESSION_FORMAT_VERSION = 19

const sessionHeadKey = (sessionId: string): string =>
  `mc-compose/session/${encodeURIComponent(sessionId)}/head`
const sessionCheckpointHeadKey = (sessionId: string): string =>
  `mc-compose/session/${encodeURIComponent(sessionId)}/checkpoint/head`
// The autosave runs every 5 s (AUTOSAVE_INTERVAL_MS in main.ts) whether or not
// anything changed; a checkpoint needs a second save after the first.
const STORED_RECORD_WAIT = { timeout: 30_000 }

// mc-save's IndexedDB record: the key path, the insertion sequence, the envelope.
const StoredSaveRecordSchema = Schema.Struct({
  key: Schema.String,
  seq: Schema.Number,
  envelope: SaveEnvelopeSchema,
})
type StoredSaveRecord = typeof StoredSaveRecordSchema.Type

const readStoredRecord = async (page: Page, key: string): Promise<StoredSaveRecord | undefined> => {
  const stored: unknown = await page.evaluate(async ({ databaseName, storeName, recordKey }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.addEventListener('success', () => resolve(request.result), { once: true })
      request.addEventListener('error', () => reject(request.error), { once: true })
    })
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction(storeName).objectStore(storeName).get(recordKey)
        request.addEventListener('success', () => resolve(request.result), { once: true })
        request.addEventListener('error', () => reject(request.error), { once: true })
      })
    } finally {
      database.close()
    }
  }, { databaseName: DATABASE_NAME, storeName: SAVE_STORE_NAME, recordKey: key })
  return stored === undefined ? undefined : Result.getOrThrow(Schema.decodeUnknownResult(StoredSaveRecordSchema)(stored))
}

const requireStoredRecord = async (page: Page, key: string): Promise<StoredSaveRecord> => {
  const record = await readStoredRecord(page, key)
  if (record === undefined) throw new Error(`no stored record at ${key}`)
  return record
}

const waitForStoredRecord = async (page: Page, key: string): Promise<void> => {
  await expect.poll(async () => (await readStoredRecord(page, key)) !== undefined, STORED_RECORD_WAIT).toBe(true)
}

const writeStoredRecord = (page: Page, record: StoredSaveRecord): Promise<void> =>
  page.evaluate(async ({ databaseName, storeName, value }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.addEventListener('success', () => resolve(request.result), { once: true })
      request.addEventListener('error', () => reject(request.error), { once: true })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite')
        transaction.objectStore(storeName).put(value)
        transaction.addEventListener('complete', () => resolve(), { once: true })
        transaction.addEventListener('error', () => reject(transaction.error), { once: true })
        transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
      })
    } finally {
      database.close()
    }
  }, { databaseName: DATABASE_NAME, storeName: SAVE_STORE_NAME, value: record })

const replaceStoredEnvelope = async (
  page: Page,
  key: string,
  replace: (envelope: SaveEnvelope) => SaveEnvelope,
): Promise<void> => {
  const record = await requireStoredRecord(page, key)
  await writeStoredRecord(page, { ...record, envelope: replace(record.envelope) })
}

// The same head as a newer build would seal it: valid integrity, newer version.
const sealedAtNewerVersion = (envelope: SaveEnvelope): SaveEnvelope =>
  Result.getOrThrow(sealSaveEnvelope(
    {
      format: envelope.format,
      version: SaveFormatVersion(NEWER_SESSION_FORMAT_VERSION),
      payload: envelope.payload,
    },
    envelope.extensions,
  ))

// The integrity still describes the original payload, so the checksum fails.
const tamperedPayload = (envelope: SaveEnvelope): SaveEnvelope => ({ ...envelope, payload: { tampered: true } })

// A same-origin page that does not run the game, so no save can replace a
// record written from it before the next boot reads it.
const leaveGame = async (page: Page): Promise<void> => {
  await page.goto('/@vite/client')
}

// Every readwrite transaction throws while armed. The fault stays armed until
// the test disarms it, so an autosave that takes the fault first does not let
// the Save and Quit under test through.
const installStorageWriteFault = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const faultState = { armed: false }
    const originalTransaction = IDBDatabase.prototype.transaction
    const transactionWithFault = function (
      this: IDBDatabase,
      ...arguments_: Parameters<IDBDatabase['transaction']>
    ): IDBTransaction {
      if (arguments_[1] === 'readwrite' && faultState.armed) {
        throw new DOMException('Injected session write failure', 'InvalidStateError')
      }
      return originalTransaction.apply(this, arguments_)
    }
    IDBDatabase.prototype.transaction = transactionWithFault
    ;(globalThis as unknown as { setStorageWriteFault: (armed: boolean) => void }).setStorageWriteFault = (armed) => {
      faultState.armed = armed
    }
  })
}

const setStorageWriteFault = (page: Page, armed: boolean): Promise<void> =>
  page.evaluate((next) => {
    ;(globalThis as unknown as { setStorageWriteFault: (armed: boolean) => void }).setStorageWriteFault(next)
  }, armed)

const openPauseMenu = async (page: Page): Promise<void> => {
  await page.keyboard.press('Escape')
  await expect(page.locator('body')).toHaveAttribute('data-session-paused', 'true')
  await expect(page.getByTestId('save-quit-button')).toBeVisible()
}

test('restores a dynamic entity with stable identity and state', async ({ page }) => {
  const faults = watchForFaults(page)
  await clearDatabase(page)

  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await callQa(page, 'gameplay.seedMeleeDropEncounter')
  await callQa(page, 'gameplay.seedSmokeGroundingEncounter')
  await expect(page.locator('#game-canvas')).toHaveAttribute(
    'data-player-grounded',
    'true',
  )
  const published = await snapshot(page)
  expect(published.entities).toHaveLength(1)

  await callQa(page, 'persistence.flush')
  await expect(page.locator('body')).toHaveAttribute('data-session-persistence', 'saved')
  await page.reload()
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  const restored = await snapshot(page)
  expect(restored.entities).toEqual(published.entities)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('retains death-drop custom name and enchantments through reload and pickup', async ({ page }) => {
  const faults = watchForFaults(page)
  await clearDatabase(page)

  await startGameSession(page)
  const body = page.locator('body')
  await expect(body).toHaveAttribute('data-mc-compose-boot', 'running')
  const seeded = await callQa<GameplaySnapshot>(page, 'gameplay.seedChestTransferMetadata')
  expect(seeded.inventory.slots[0]?.item).toBe('diamond_pickaxe')
  expect(seeded.itemMetadata.customNames['0']).toBe('Silk Runner')
  expect(seeded.itemMetadata.enchantedItems['0']).toMatchObject({
    item: 'diamond_pickaxe',
    enchantments: [{ id: 'efficiency', level: 5 }],
  })

  for (let hit = 0; hit < 10 && !(await snapshot(page)).dead; hit += 1) {
    await callQa(page, 'gameplay.damage')
  }
  await expect.poll(async () => (await snapshot(page)).dead).toBe(true)
  const death = await snapshot(page)
  expect(death.inventory.slots[0]).toBeNull()
  expect(death.itemMetadata.customNames['0']).toBeUndefined()
  expect(death.itemMetadata.enchantedItems['0']).toBeUndefined()
  expect(death.entities.filter(({ kind }) => kind === 'dropped_item')).toHaveLength(1)

  await callQa(page, 'persistence.flush')
  await expect(body).toHaveAttribute('data-session-persistence', 'saved')
  await page.reload()
  await expect(body).toHaveAttribute('data-mc-compose-boot', 'running')
  await expect.poll(async () => (await snapshot(page)).dead).toBe(true)
  const reloaded = await snapshot(page)
  expect(reloaded.entities.filter(({ kind }) => kind === 'dropped_item')).toHaveLength(1)

  await callQa(page, 'gameplay.respawn')
  // Death never moved the player (the damage loop above is stationary), so
  // this world's default respawn point is the same position the item
  // dropped at — within the hand-rolled pickup loop's 1.5-unit radius
  // (`apps/web/main.ts`'s per-frame pickup, restored to being the only
  // picker-upper now that `droppedItemPickup: false` is honored again).
  // Respawning already stands the player on the drop, so it is usually
  // picked up before this line runs; `targetNearestDroppedItem` would throw
  // "no dropped item found" in that case. Only walk to it if it is still
  // there — this keeps the explicit-walk path exercised for a respawn that
  // is NOT already on top of the drop, without assuming either outcome.
  if ((await snapshot(page)).entities.some(({ kind }) => kind === 'dropped_item')) {
    await callQa(page, 'gameplay.targetNearestDroppedItem')
  }
  await expect.poll(async () => {
    const current = await snapshot(page)
    return current.inventory.slots.findIndex((slot) => slot?.item === 'diamond_pickaxe')
  }).toBeGreaterThanOrEqual(0)

  const recovered = await snapshot(page)
  const recoveredSlot = recovered.inventory.slots.findIndex(
    (slot) => slot?.item === 'diamond_pickaxe',
  )
  expect(recovered.entities.filter(({ kind }) => kind === 'dropped_item')).toEqual([])
  expect(recovered.itemMetadata.customNames[String(recoveredSlot)]).toBe('Silk Runner')
  expect(recovered.itemMetadata.enchantedItems[String(recoveredSlot)]).toMatchObject({
    item: 'diamond_pickaxe',
    enchantments: [{ id: 'efficiency', level: 5 }],
  })
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

// Keep every non-ecosystem entity so unexpected entries still fail the roster checks.
const nonEcosystemEntities = (
  current: GameplaySnapshot,
): ReadonlyArray<GameplaySnapshot['entities'][number]> =>
  current.entities.filter(({ behaviour }) => !(
    isHostileMobSnapshot(behaviour) && behaviour.behaviour?._tag === 'EcosystemMob'
  ))

test('isolates and restores entity rosters across dimensions and reload', async ({ page }) => {
  const faults = watchForFaults(page)
  await clearDatabase(page)

  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  const serial = (id: string): number => {
    const match = /(?<serial>\d+)$/u.exec(id)
    if (match?.groups?.['serial'] === undefined) throw new Error(`entity id has no serial: ${id}`)
    return Number(match.groups['serial'])
  }
  const damageUntilNewDrop = async (
    existingEntityIds: ReadonlyArray<string>,
  ): Promise<GameplaySnapshot> => {
    const maximumAttempts = 10
    const dropState = async () => {
      const entities = nonEcosystemEntities(await snapshot(page))
      const ids = new Set(entities.map(({ id }) => id))
      return {
        count: entities.length,
        kinds: entities.map(({ kind }) => kind),
        retainedExistingIds: existingEntityIds.every((id) => ids.has(id)),
        uniqueIds: ids.size === entities.length,
      }
    }

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const beforeDamage = await snapshot(page)
      await callQa(page, 'gameplay.damage')
      try {
        await expect.poll(async () => {
          const current = await snapshot(page)
          return current.dead || current.vitals.healthPoints < beforeDamage.vitals.healthPoints
        }, { timeout: 500 }).toBe(true)
      } catch (error: unknown) {
        if (attempt === maximumAttempts - 1) throw error
        continue
      }
      if ((await snapshot(page)).dead) break
    }

    await expect.poll(async () => (await snapshot(page)).dead).toBe(true)
    await expect.poll(dropState).toEqual({
      count: existingEntityIds.length + 1,
      kinds: Array.from(
        { length: existingEntityIds.length + 1 },
        () => 'dropped_item',
      ),
      retainedExistingIds: true,
      uniqueIds: true,
    })
    const current = await snapshot(page)
    const newDrop = nonEcosystemEntities(current).find(({ id }) => !existingEntityIds.includes(id))
    expect(newDrop?.kind).toBe('dropped_item')
    if (newDrop === undefined || !isDroppedItemBehaviour(newDrop.behaviour)) {
      throw new Error('new death drop has no dropped-item behaviour')
    }
    expect({ item: newDrop.behaviour.item, count: newDrop.behaviour.count }).toEqual({
      item: 'potato', count: 2,
    })
    return current
  }

  await callQa(page, 'gameplay.seedFoodUseEncounter')
  // Keep the first drop away from the respawn point used to prepare the next dimension.
  await callQa(page, 'gameplay.seedSmokeGroundingEncounter')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-player-grounded', 'true')
  const priorOverworldSerial = Math.max(-1, ...(await snapshot(page)).entities.map(({ id }) => serial(id)))
  const overworld = await damageUntilNewDrop([])
  const seededOverworld = nonEcosystemEntities(overworld)
  const overworldDrop = seededOverworld[0]
  expect(overworld.dimension).toBe('overworld')
  expect(serial(overworldDrop?.id ?? '')).toBeGreaterThan(priorOverworldSerial)

  await callQa(page, 'gameplay.seedFoodUseEncounter')
  await callQa(page, 'gameplay.enterNether')
  await expect.poll(async () => (await snapshot(page)).activeChunkDimension).toBe('nether')
  // Entering the nether must not carry the overworld's death drops with it.
  expect(nonEcosystemEntities(await snapshot(page))).toEqual([])
  const nether = await damageUntilNewDrop([])
  const seededNether = nonEcosystemEntities(nether)
  expect(seededNether).toHaveLength(1)
  expect(seededNether[0]?.kind).toBe('dropped_item')
  // NOT an id-string comparison against `overworldDrop`: ids are minted
  // `${kind}-${serial}` from a counter that is per-DIMENSION, not global
  // (mc-sim's entity manager keeps one `nextSerial` per roster), so two
  // entities in different dimensions can legitimately share a literal id —
  // and once natural spawns can consume serials ahead of a seeded entity,
  // that coincidence is no longer rare enough to treat as a leak signal.
  // The leak property — that the overworld's seeded entities did not carry
  // into the nether roster — is what the empty-`nonEcosystemEntities` assertion
  // just above already proved, by roster membership rather than by id.

  await callQa(page, 'persistence.flush')
  await expect(page.locator('body')).toHaveAttribute('data-session-persistence', 'saved')
  await page.reload()
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await expect.poll(async () => (await snapshot(page)).activeChunkDimension).toBe('nether')
  const restoredNether = await snapshot(page)
  const seededRestoredNether = nonEcosystemEntities(restoredNether)
  // Compares the SEEDED subset only: the ecosystem's own population keeps
  // evolving in real time (including across a reload's round trip), so
  // asserting the full roster is byte-identical would just be asserting how
  // long the reload happened to take. Reload stability of what this test
  // seeded is the property that matters, and it is asserted exactly.
  expect(seededRestoredNether.map(({ id, kind }) => ({ id, kind }))).toEqual(
    seededNether.map(({ id, kind }) => ({ id, kind })),
  )
  expect(seededRestoredNether[0]?.feetPosition).toEqual(seededNether[0]?.feetPosition)

  await callQa(page, 'gameplay.enterOverworld')
  await expect.poll(async () => (await snapshot(page)).activeChunkDimension).toBe('overworld')
  // Respawn and prepare both fixtures at one boundary so no intermediate frame can collect the retained drop.
  await page.evaluate(async () => {
    const transport = window.__NERIMA_GAMES_QA__
    if (transport === undefined) throw new Error('missing QA transport')
    const results = await Promise.all([
      transport.dispatch('gameplay', 'respawn', null),
      transport.dispatch('gameplay', 'seedFoodUseEncounter', null),
      transport.dispatch('gameplay', 'seedSmokeGroundingEncounter', null),
    ])
    for (const result of results) {
      if (result._tag === 'Failure') throw new Error(`QA command failed: ${JSON.stringify(result.error)}`)
    }
  })
  await expect.poll(async () => (await snapshot(page)).dead).toBe(false)
  await callQa(page, 'gameplay.enterNether')
  await expect.poll(async () => (await snapshot(page)).activeChunkDimension).toBe('nether')
  const retainedNetherDrop = seededNether[0]
  if (retainedNetherDrop === undefined) throw new Error('missing first nether death drop')
  const secondNether = await snapshot(page)
  // Horizontal separation remains outside pickup range even while the second fixture falls.
  expect(Math.hypot(
    secondNether.pose.feetPosition.x - retainedNetherDrop.feetPosition.x,
    secondNether.pose.feetPosition.z - retainedNetherDrop.feetPosition.z,
  )).toBeGreaterThan(DROPPED_ITEM_PICKUP_RADIUS)
  const expandedNether = await damageUntilNewDrop(seededNether.map(({ id }) => id))
  const seededExpandedNether = nonEcosystemEntities(expandedNether)
  expect(seededExpandedNether).toHaveLength(2)
  const nextNether = seededExpandedNether.find(({ id }) => id !== seededNether[0]?.id)
  expect(serial(nextNether?.id ?? '')).toBeGreaterThan(serial(seededNether[0]?.id ?? ''))

  await callQa(page, 'gameplay.enterOverworld')
  await expect.poll(async () => (await snapshot(page)).activeChunkDimension).toBe('overworld')
  const restoredOverworld = await snapshot(page)
  const seededRestoredOverworld = nonEcosystemEntities(restoredOverworld)
  expect(seededRestoredOverworld.map(({ id, kind }) => ({ id, kind }))).toEqual(
    seededOverworld.map(({ id, kind }) => ({ id, kind })),
  )
  expect(seededRestoredOverworld[0]?.feetPosition).toEqual(overworldDrop?.feetPosition)

  // The leak property this test exists for: entities seeded in one
  // dimension never surface in another dimension's roster, in either
  // direction, reload or not.
  expect(seededRestoredOverworld.map(({ feetPosition }) => feetPosition)).not.toContainEqual(
    seededNether[0]?.feetPosition,
  )
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('publishes a mined world, inventory, and exact pose across reload', async ({ page }) => {
  const faults = watchForFaults(page)
  await clearDatabase(page)

  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await expect(page.locator('[data-mx-ui="hotbar"] [data-mx-ui="slot"]')).toHaveCount(9)
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-weather-audio-mode', 'clear')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-weather-particles', '0')

  await seedGroundedMiningEncounter(page)
  const beforeBreak = await snapshot(page)
  expect(beforeBreak.target.reading).toBe('Block')
  expect(beforeBreak.target.block).not.toBe(AIR_BLOCK_ID)

  expect(await callQa<unknown>(page, 'gameplay.breakTarget')).not.toBeNull()
  await expect.poll(async () => (await snapshot(page)).target.block).toBe(AIR_BLOCK_ID)
  await expect.poll(async () => (await snapshot(page)).pose.feetPosition.y).toBe(63)
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-player-grounded', 'true')

  await callQa(page, 'gameplay.setWeather')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-weather', 'thunder')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-weather-audio-mode', 'thunder')
  await expect.poll(async () => Number(
    await page.locator('#game-canvas').getAttribute('data-weather-particles'),
  )).toBeGreaterThan(0)

  const published = await snapshot(page)
  const publishedHotbar = await hotbarText(page)
  expect(published.inventory.slots).toHaveLength(36)
  expect(publishedHotbar).toHaveLength(9)

  await callQa(page, 'persistence.flush')
  await expect(page.locator('body')).toHaveAttribute('data-session-persistence', 'saved')
  await page.reload()
  await expect(page).toHaveURL(/\?session=e2e$/u)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-world-source', 'persisted')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-weather', 'thunder')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-weather-audio-mode', 'thunder')
  await expect.poll(async () => Number(
    await page.locator('#game-canvas').getAttribute('data-weather-particles'),
  )).toBeGreaterThan(0)

  await expect.poll(async () => (await snapshot(page)).target.block).toBe(AIR_BLOCK_ID)
  const restored = await snapshot(page)
  expect(restored.pose).toEqual(published.pose)
  expect(restored.dimension).toBe(published.dimension)
  expect(restored.weather.weather).toBe(published.weather.weather)
  expect(Math.abs(restored.weather.remainingSecs - published.weather.remainingSecs)).toBeLessThan(5)
  expect(restored.inventory).toEqual(published.inventory)
  expect(await hotbarText(page)).toEqual(publishedHotbar)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('debounces dirty gameplay into a durable save without an explicit flush', async ({ page }) => {
  const faults = watchForFaults(page)
  await clearDatabase(page)

  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  await seedGroundedMiningEncounter(page)
  const durableEntityRoster = (value: GameplaySnapshot) => value.entities.map((entity) => ({
    id: entity.id,
    kind: entity.kind,
    healthPoints: entity.healthPoints,
  }))
  const readPublishedHead = () => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nerima-games-minecraft')
      request.addEventListener('success', () => resolve(request.result), { once: true })
      request.addEventListener('error', () => reject(request.error), { once: true })
    })
    try {
      const record = await new Promise<{
        readonly seq: number
        readonly envelope: { readonly payload: SessionHead }
      } | undefined>((resolve, reject) => {
        const request = database.transaction('saves', 'readonly').objectStore('saves')
          .get('mc-compose/session/e2e/head')
        request.addEventListener('success', () => resolve(request.result), { once: true })
        request.addEventListener('error', () => reject(request.error), { once: true })
      })
      if (record === undefined) return undefined
      return {
        sequence: record.seq,
        pose: record.envelope.payload.state.player,
        roster: record.envelope.payload.state.entities.overworld.entities.map(({ id, kind, healthPoints }) => ({
          id, kind, healthPoints,
        })),
      }
    } finally {
      database.close()
    }
  })
  const beforeMining = await readPublishedHead()
  expect(await callQa<unknown>(page, 'gameplay.breakTarget')).not.toBeNull()
  await expect.poll(async () => (await snapshot(page)).target.block).toBe(AIR_BLOCK_ID)
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-player-grounded', 'true')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('pause-overlay')).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-session-paused', 'true')
  const published = await snapshot(page)
  // A live frame can spawn a mob after a save completes; wait for the frozen roster's own publication.
  await expect.poll(async () => {
    const head = await readPublishedHead()
    return {
      newer: head !== undefined && (beforeMining === undefined || head.sequence > beforeMining.sequence),
      pose: head?.pose,
      roster: head?.roster,
    }
  }).toEqual({ newer: true, pose: published.pose, roster: durableEntityRoster(published) })
  await expect(page.locator('body')).toHaveAttribute('data-session-persistence', 'saved')

  await page.reload()
  await expect(page).toHaveURL(/\?session=e2e$/u)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-world-source', 'persisted')
  await expect.poll(async () => (await snapshot(page)).target.block).toBe(AIR_BLOCK_ID)
  const restored = await snapshot(page)
  expect(restored).toEqual({
    ...published,
    // Autonomous entities resume immediately after boot, so compare their durable roster below.
    entities: restored.entities,
    renderedEntities: restored.renderedEntities,
    environmentalContact: {
      ...published.environmentalContact,
      simulationElapsedSecs: expect.any(Number),
    },
    weather: {
      ...published.weather,
      remainingSecs: expect.any(Number),
    },
    vitals: {
      ...published.vitals,
      foodTimerSecs: expect.any(Number),
    },
    villagerTrades: {
      ...published.villagerTrades,
      restockElapsedSecs: expect.any(Number),
    },
  })
  expect(durableEntityRoster(restored)).toEqual(durableEntityRoster(published))
  expect(Math.abs(restored.weather.remainingSecs - published.weather.remainingSecs)).toBeLessThan(5)
  expect(restored.vitals.foodTimerSecs).toBeGreaterThanOrEqual(0)
  expect(restored.vitals.foodTimerSecs).toBeLessThan(4)
  expect(restored.villagerTrades.restockElapsedSecs).toBeGreaterThan(0)
  expect(
    Math.abs(
      restored.villagerTrades.restockElapsedSecs - published.villagerTrades.restockElapsedSecs,
    ),
  ).toBeLessThan(1)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('isolates and restores edits while travelling overworld to nether and back', async ({ page }) => {
  const faults = watchForFaults(page)
  await clearDatabase(page)

  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  await callQa(page, 'gameplay.setPose')
  expect(await callQa<unknown>(page, 'gameplay.breakTarget')).not.toBeNull()
  await expect.poll(async () => (await snapshot(page)).target.block).toBe(AIR_BLOCK_ID)

  await callQa(page, 'gameplay.enterNether')
  await expect.poll(async () => (await snapshot(page)).activeChunkDimension).toBe('nether')
  const nether = await snapshot(page)
  expect(nether.dimension).toBe('nether')
  expect(nether.target.reading).toBe('Block')
  expect(nether.target.block).not.toBe(AIR_BLOCK_ID)

  await callQa(page, 'gameplay.enterOverworld')
  await expect.poll(async () => (await snapshot(page)).activeChunkDimension).toBe('overworld')
  const overworld = await snapshot(page)
  expect(overworld.dimension).toBe('overworld')
  expect(overworld.target.block).toBe(AIR_BLOCK_ID)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('materializes, persists, and reuses a portal round trip without duplicates', async ({ page }) => {
  const faults = watchForFaults(page)
  await clearDatabase(page)

  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  const seeded = await callQa<GameplaySnapshot>(page, 'gameplay.seedPortalEncounter')
  expect(seeded.dimension).toBe('overworld')
  expect(seeded.portals).toEqual([
    { dimension: 'overworld', position: { x: 120, y: 65, z: 8 } },
  ])
  expect(seeded.activePortal?.interiorBlock).toBe(NETHER_PORTAL_BLOCK_ID)
  expect(seeded.activePortal?.frameBlock).toBe(OBSIDIAN_BLOCK_ID)

  // Portal dimension transitions stream chunks over several simulated
  // frames — see waitForSimulationProgress.
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.dimension === 'nether',
    { description: 'portal transition to nether' },
  )
  const generated = await snapshot(page)
  expect(generated.activeChunkDimension).toBe('nether')
  expect(generated.portals).toEqual([
    { dimension: 'overworld', position: { x: 120, y: 65, z: 8 } },
    { dimension: 'nether', position: { x: 15, y: 65, z: 1 } },
  ])
  expect(generated.activePortal?.anchor).toEqual({ x: 15, y: 65, z: 1 })
  expect(generated.activePortal?.interiorBlock).toBe(NETHER_PORTAL_BLOCK_ID)
  expect(generated.activePortal?.frameBlock).toBe(OBSIDIAN_BLOCK_ID)

  await callQa(page, 'persistence.flush')
  await expect(page.locator('body')).toHaveAttribute('data-session-persistence', 'saved')
  await page.reload()
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-world-source', 'persisted')

  const restored = await snapshot(page)
  expect(restored.dimension).toBe('nether')
  expect(restored.activeChunkDimension).toBe('nether')
  expect(restored.portals).toEqual(generated.portals)
  expect(restored.activePortal?.interiorBlock).toBe(NETHER_PORTAL_BLOCK_ID)
  expect(restored.activePortal?.frameBlock).toBe(OBSIDIAN_BLOCK_ID)

  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.dimension === 'overworld',
    { description: 'portal transition to overworld' },
  )
  const returned = await snapshot(page)
  expect(returned.activeChunkDimension).toBe('overworld')
  expect(returned.portals).toEqual(generated.portals)
  expect(returned.portals.filter(({ dimension }) => dimension === 'overworld')).toHaveLength(1)
  expect(returned.portals.filter(({ dimension }) => dimension === 'nether')).toHaveLength(1)
  expect(returned.activePortal?.anchor).toEqual({ x: 120, y: 65, z: 8 })
  expect(returned.activePortal?.interiorBlock).toBe(NETHER_PORTAL_BLOCK_ID)
  expect(returned.activePortal?.frameBlock).toBe(OBSIDIAN_BLOCK_ID)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('reaches saved after an autosave, even while the player keeps drifting', async ({ page }) => {
  const faults = watchForFaults(page)
  await clearDatabase(page)

  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  // Water buoyancy moves the player every frame with zero input — the same
  // condition that starved the indicator in production: `main.ts`'s
  // `if (looked || moved) markSessionDirty()` mints a fresh dirty generation
  // on essentially every frame, so a save's async round trip is always
  // racing a newer generation than the one it captured. The regression was
  // that the indicator compared a just-completed save against whatever
  // generation was live *when the callback ran*, which under continuous
  // drift is (almost) never the generation the save actually covered.
  await callQa(page, 'gameplay.seedSubmergedSwimmingEncounter')
  await watchForSavedPersistence(page)

  // AUTOSAVE_INTERVAL_MS (main.ts) is 5s and does not wait for a debounce
  // gap the continuous drift never provides — this only needs to observe
  // that a background save eventually completes and is shown, not to force
  // one. waitForSimulationProgress backs this off by real frame progress
  // rather than a fixed wall-clock sleep, matching the drift-sensitive
  // waits elsewhere in this suite.
  await waitForSimulationProgress(
    page,
    () => sawSavedPersistenceWithFrames(page),
    (sawSaved) => sawSaved,
    { description: 'save indicator reaches saved despite continuous drift' },
  )

  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('sends a world saved by a newer version to the title screen with its message', async ({ page }) => {
  const faults = watchForFaults(page)
  const sessionId = 'future-version-e2e'
  await clearDatabase(page)

  await startGameSession(page, sessionId)
  const body = page.locator('body')
  await expect(body).toHaveAttribute('data-mc-compose-boot', 'running')
  await waitForStoredRecord(page, sessionHeadKey(sessionId))

  await leaveGame(page)
  await replaceStoredEnvelope(page, sessionHeadKey(sessionId), sealedAtNewerVersion)
  await page.goto(`/?session=${sessionId}`)

  await expect(page).toHaveURL('/?loadError=future-version-session')
  await expect(body).toHaveAttribute('data-mc-compose-route', 'title')
  await expect(page.locator('#title-status')).toHaveText(SESSION_FUTURE_VERSION_MESSAGE)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

test('reopens a world from its checkpoint when the latest save is unreadable', async ({ page }) => {
  const faults = watchForFaults(page)
  const sessionId = 'checkpoint-recovery-e2e'
  await clearDatabase(page)

  await startGameSession(page, sessionId)
  const body = page.locator('body')
  await expect(body).toHaveAttribute('data-mc-compose-boot', 'running')
  // The second save copies the first one to the checkpoint before replacing it.
  await waitForStoredRecord(page, sessionCheckpointHeadKey(sessionId))

  await leaveGame(page)
  await replaceStoredEnvelope(page, sessionHeadKey(sessionId), tamperedPayload)
  await page.goto(`/?session=${sessionId}`)

  await expect(page).toHaveURL(new RegExp(`\\?session=${sessionId}$`, 'u'))
  await expect(body).toHaveAttribute('data-mc-compose-boot', 'running')
  await expect(body).toHaveAttribute('data-session-source', 'checkpoint')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-world-source', 'persisted')
  await expect(page.locator('[data-pause-error]')).toHaveText(SESSION_CHECKPOINT_OPENED_MESSAGE)
  expect(faults.pageErrors).toEqual([])
  expect(faults.consoleErrors).toEqual([])
})

// The message the Save and Quit handler wrote before #45's typed messages.
const GENERIC_SAVE_FAILURE_MESSAGE = 'Save failed. Your world is still open; please try again.'

// Clicks Save and Quit with every text written to the pause error line
// recorded from before the click. The autosave keeps running while paused and
// can overwrite the line, so the final text alone cannot show what the Save and
// Quit handler wrote. With `armFault`, the storage write fault is armed in the
// same evaluation, so no autosave runs between arming and the click.
const clickSaveQuitRecordingErrors = (page: Page, armFault: boolean): Promise<void> =>
  page.evaluate((arm) => {
    const errorLine = document.querySelector('[data-pause-error]')
    if (errorLine === null) throw new Error('missing pause error line')
    const button = document.querySelector<HTMLButtonElement>('[data-testid="save-quit-button"]')
    if (button === null) throw new Error('missing save-quit button')
    const texts: Array<string> = []
    ;(globalThis as unknown as { pauseErrorTexts: Array<string> }).pauseErrorTexts = texts
    new MutationObserver(() => { texts.push(errorLine.textContent ?? '') })
      .observe(errorLine, { childList: true, characterData: true, subtree: true })
    if (arm) {
      ;(globalThis as unknown as { setStorageWriteFault: (armed: boolean) => void }).setStorageWriteFault(true)
    }
    button.click()
  }, armFault)

// The non-empty texts written to the pause error line since the click.
const recordedPauseErrors = async (page: Page): Promise<ReadonlyArray<string>> =>
  (await page.evaluate(() => [...(globalThis as unknown as { pauseErrorTexts: Array<string> }).pauseErrorTexts]))
    .filter((text) => text !== '')

test('keeps the world open with the storage message when Save and Quit cannot write', async ({ page }) => {
  const faults = watchForFaults(page)
  const sessionId = 'save-quit-storage-failure-e2e'
  await installStorageWriteFault(page)
  await clearDatabase(page)

  await startGameSession(page, sessionId)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await waitForStoredRecord(page, sessionHeadKey(sessionId))
  await openPauseMenu(page)

  const saveQuitButton = page.getByTestId('save-quit-button')
  // The fault stays armed until this Save and Quit is seen failing, so an
  // autosave already waiting to write cannot use it up first.
  await clickSaveQuitRecordingErrors(page, true)
  await expect(saveQuitButton).not.toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('[data-pause-error]')).toHaveText(SESSION_SAVE_STORAGE_FAILURE_MESSAGE)
  const written = await recordedPauseErrors(page)
  expect(written).not.toContain(GENERIC_SAVE_FAILURE_MESSAGE)
  expect(written.at(-1)).toBe(SESSION_SAVE_STORAGE_FAILURE_MESSAGE)
  await expect(page).toHaveURL(new RegExp(`\\?session=${sessionId}$`, 'u'))
  await setStorageWriteFault(page, false)

  await saveQuitButton.click()
  await expect(page).toHaveURL('/')
  expect(faults.pageErrors).toEqual([])
})

test('keeps the world open with the incompatible-save message when Save and Quit meets a newer save', async ({ page }) => {
  const faults = watchForFaults(page)
  const sessionId = 'save-quit-incompatible-e2e'
  await clearDatabase(page)

  await startGameSession(page, sessionId)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await waitForStoredRecord(page, sessionHeadKey(sessionId))
  await openPauseMenu(page)

  // An autosave that read the old head before the replacement can save over the
  // newer one; every later save then succeeds. So the head is replaced again
  // until a save fails against it. Saves are serial and a failed save writes
  // nothing, so after that failure the newer head stays.
  await expect(async () => {
    await replaceStoredEnvelope(page, sessionHeadKey(sessionId), sealedAtNewerVersion)
    // One autosave interval (5 s) plus margin.
    await expect(page.locator('body')).toHaveAttribute('data-session-persistence', 'failed', { timeout: 7_000 })
  }).toPass({ timeout: 30_000 })
  expect((await requireStoredRecord(page, sessionHeadKey(sessionId))).envelope.version).toBe(NEWER_SESSION_FORMAT_VERSION)
  const saveQuitButton = page.getByTestId('save-quit-button')
  await clickSaveQuitRecordingErrors(page, false)

  await expect(saveQuitButton).not.toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('[data-pause-error]')).toHaveText(SESSION_SAVE_INCOMPATIBLE_MESSAGE)
  const written = await recordedPauseErrors(page)
  expect(written).not.toContain(GENERIC_SAVE_FAILURE_MESSAGE)
  expect(written.at(-1)).toBe(SESSION_SAVE_INCOMPATIBLE_MESSAGE)
  await expect(page).toHaveURL(new RegExp(`\\?session=${sessionId}$`, 'u'))
  // No save replaced the newer head while the test wrote it.
  expect((await requireStoredRecord(page, sessionHeadKey(sessionId))).envelope.version).toBe(NEWER_SESSION_FORMAT_VERSION)
  expect(faults.pageErrors).toEqual([])
})
