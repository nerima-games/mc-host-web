import { AngleRadians, BlockAxis, BlockId, ClockPort, EpochMillis, fixedClock, blockIdOf, blockTypeOfId, blockPosition as kernelBlockPosition, ChunkAxis, chunkCoord as kernelChunkCoord, DeltaTimeSecs, MonotonicTimeSecs, position, PositionAxis, WorldId, MAX_PORTAL_WIDTH, WorldWriteChunkUnavailableSchema, WorldWriteConflict, WorldWriteInvalidBatch, type WorldWriteBatch, type WorldWritePort } from '@nerima-games/mc-kernel'
import { type InputSnapshot } from '@nerima-games/mc-render'
import { CropSnapshotSchema, PlayerServiceSnapshotSchema, PlayerStorageSnapshotSchema, makeTimeService, makeWeatherService, makeWorldCommitCoordinator, HungerPoints, POTATO_MATURITY_SECS, type CropSnapshot } from '@nerima-games/mc-sim'
import { CHUNK_SIZE_XZ, CHUNK_VOLUME, BIOMES, type ChunkSource } from '@nerima-games/mc-worldgen'
import { type ItemUseResult, type MobBehaviour } from '@nerima-games/mx-gameplay'
import { Effect, Option, Ref, Result, Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import * as gameplay from '@nerima-games/mx-gameplay'
import { makeUiFrameState } from '@nerima-games/mx-ui'

import { DEFAULT_PLAYER_SETTINGS } from '../apps/web/settings'
import { IDLE_BOW_USE } from '../apps/web/bow-use'
import { enterSleep, initialSleepRuntimeState, type BedRespawnLocation, type SleepLocation } from '../apps/web/sleep-runtime'
import { initialSleepClientState } from '@nerima-games/mc-server/shared'
import type { PersistedVillager, SessionPosition } from '../apps/web/session-persistence'
import { mutableState, type H5aFrameInputResult, type H5aMovementResult, type H5aTickContext } from '../apps/web/tick/h5a-context'
import type { H5bPostFrameResult } from '../apps/web/tick/h5b-context'
import type { H5cTickContext } from '../apps/web/tick/h5c-context'
import { runTickPostFrameGameplay as runTickPostFrameGameplayEffect } from '../apps/web/tick/post-frame-gameplay'
import { type ChunkStreamingFailure, type DimensionChunkContext } from '../apps/web/chunk-streaming'

const blockPosition = (x: number, y: number, z: number) => kernelBlockPosition(BlockAxis(x), BlockAxis(y), BlockAxis(z))
const chunkCoord = (cx: number, cz: number) => kernelChunkCoord(ChunkAxis(cx), ChunkAxis(cz))

const runTickPostFrameGameplay = (...args: Parameters<typeof runTickPostFrameGameplayEffect>) => Effect.runSync(runTickPostFrameGameplayEffect(...args))

const allAirChunkSource: ChunkSource = (coord) => Effect.succeed({
  coord,
  blocks: new Uint16Array(CHUNK_VOLUME).fill(Option.getOrThrow(blockIdOf('air'))),
  biomes: Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, () => BIOMES[0]),
})

const cell = <Value,>(initial: Value) => {
  let value = initial
  return {
    state: mutableState(() => value, (next) => { value = next }),
    get: () => value,
  }
}

const inputSnapshot: InputSnapshot = {
  pressed: new Set(),
  justPressed: new Set(),
  uiClicks: new Set(),
  uiClickLandings: [],
  pointerDelta: { x: 0, y: 0 },
  wheelNotches: 0,
  wheelSteps: 0,
  pointerLocked: false,
  pointerLockState: 'unlocked',
  keyboardFocus: undefined,
  gamepadAxes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
}

const makeDocument = (attributes: Map<string, string>): Document => ({
  body: {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  },
  createElement: () => ({
    className: '',
    dataset: {},
    setAttribute: () => undefined,
    textContent: '',
  }),
} as unknown as Document)

type HarnessOptions = Readonly<{
  useTriggered?: boolean
  selectedItem?: 'eye_of_ender' | 'ender_pearl' | 'fishing_rod' | 'stone' | 'flint_and_steel' | 'wooden_hoe' | 'potato'
  nearbyVillager?: PersistedVillager
  endFeatureResult?: boolean
  deadAfterFrame?: boolean
  targetedBlock?: Effect.Success<ReturnType<H5cTickContext['services']['targetedBlock']>>
  fishingHasWater?: boolean
  fullInventory?: boolean
  hungry?: boolean
  crops?: CropSnapshot
  lampTransitions?: ReadonlyArray<{
    readonly dimension: string
    readonly position: SessionPosition
    readonly lit: boolean
  }>
  dimension?: 'overworld' | 'end'
}>

const makeHarness = async (options: HarnessOptions = {}) => {
  const world = await Effect.runPromise(gameplay.makeGeneratedWorld<MobBehaviour>({
    dimension: options.dimension ?? 'overworld',
    chunkSource: allAirChunkSource,
  }))
  if (options.fullInventory) {
    const slots = Effect.runSync(world.inventory.snapshot).slots.length
    expect(Effect.runSync(world.inventory.add('stone', slots * 64))).toBe(0)
  }
  if (options.selectedItem !== undefined) {
    Effect.runSync(world.inventory.add(options.selectedItem, 1))
  }
  if (options.hungry) Effect.runSync(world.vitals.restore({
    ...Effect.runSync(world.vitals.snapshot), hungerPoints: HungerPoints(10),
  }))
  const owners = await Effect.runPromise(Effect.fromResult(gameplay.gameplayOwnerRegistrations({
    playerPose: Effect.runSync(world.player.pose),
    dimension: options.dimension ?? 'overworld',
    playerStorage: Effect.runSync(world.inventory.storageSnapshot),
    vitals: Effect.runSync(world.vitals.snapshot),
    entities: Effect.runSync(world.entities.snapshot),
    crops: options.crops ?? { crops: [] },
  })))
  const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
    world: WorldId('tick-post-frame-gameplay-test'),
    owners,
    dimensions: ['overworld', 'nether', 'end'],
    chunkStores: { forDimension: () => world.chunkStore },
  }))
  const worldWriteBatches: Array<WorldWriteBatch> = []
  const worldWrite: WorldWritePort['Service'] = {
    applyBatch: (batch) => Effect.sync(() => {
      worldWriteBatches.push(batch)
      // This harness exercises the actual coordinator publication; adapter failure mapping is covered separately.
      const committed = Effect.runSync(coordinator.commit({
        expectedRevision: batch.expectedWorldRevision,
        expectedDimensions: [{ dimension: batch.dimension, expectedRevision: batch.expectedDimensionRevision }],
        changes: [],
        blockWrite: batch,
      }))
      return { worldRevision: committed.revision, dimensionRevision: Effect.runSync(coordinator.dimensionRevision(batch.dimension)) }
    }),
  }
  const targeting = {
    coordinator,
    playerOwnerId: gameplay.GAMEPLAY_PLAYER_OWNER_ID,
    entitiesOwnerId: gameplay.GAMEPLAY_ENTITIES_OWNER_ID,
  }
  const gameplayState = await Effect.runPromise(gameplay.makeGameplayFrameState)
  const time = await Effect.runPromise(makeTimeService())
  const weather = await Effect.runPromise(makeWeatherService())
  const weatherBeforeFrame = Effect.runSync(weather.snapshot)
  const commit = {
    coordinator,
    playerOwnerId: gameplay.GAMEPLAY_PLAYER_OWNER_ID,
    playerStorageOwnerId: gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
    cropOwnerId: gameplay.GAMEPLAY_CROPS_OWNER_ID,
    droppedItemsOwnerId: gameplay.GAMEPLAY_DROPPED_ITEMS_OWNER_ID,
    vitalsOwnerId: gameplay.GAMEPLAY_VITALS_OWNER_ID,
    entitiesOwnerId: gameplay.GAMEPLAY_ENTITIES_OWNER_ID,
  }
  const interactions = Option.getOrThrow(Option.fromNullishOr(gameplay.gameplayStages(
    gameplayState, world.chunkStore, world.entities, world.inventory, world.player,
    time, undefined, undefined, {}, commit,
  ).find((stage) => String(stage.id) === 'gameplay:interactions')))
  const runInteractions = () => Effect.provideService(
    interactions.run(DeltaTimeSecs(0.05)),
    ClockPort,
    fixedClock({ monotonicSecs: MonotonicTimeSecs(2), wallClockEpochMillis: EpochMillis(2000) }),
  )
  const syncPlayerOwner = () => Effect.gen(function* () {
    const registrations = yield* Effect.fromResult(gameplay.gameplayOwnerRegistrations({
      playerPose: yield* world.player.pose,
      dimension: yield* world.player.dimension,
    }))
    const player = Option.getOrThrow(Option.fromNullishOr(registrations.find(
      (entry) => entry.ownerId === gameplay.GAMEPLAY_PLAYER_OWNER_ID,
    )))
    yield* coordinator.commit({
      expectedRevision: yield* coordinator.revision,
      expectedDimensions: [],
      changes: [{ ownerId: player.ownerId, state: player.initialState }],
    })
  })
  const uiFrameState = Effect.runSync(makeUiFrameState)
  const attributes = new Map<string, string>()
  const canvasAttributes = new Map<string, string>()
  const tradeOpenCalls: Array<{ readonly open: boolean; readonly villagerId?: string }> = []
  const fishingResults: string[] = []
  const streamCalls: Array<{ readonly dimension: string; readonly x: number; readonly z: number }> = []
  const damageCalls: Array<unknown> = []
  const endAudioCalls: Array<{ readonly cue: string; readonly position: SessionPosition }> = []
  const endFeatureCalls = cell(0)
  const playerUiCalls = cell(0)
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

  const currentChunkContext = {
    dimension: options.dimension ?? 'overworld',
    chunkStore: world.chunkStore,
  } as DimensionChunkContext
  const pose = {
    feetPosition: position(PositionAxis(12.346), PositionAxis(64.234), PositionAxis(-7.891)),
    yawRadians: AngleRadians(0.25),
    pitchRadians: AngleRadians(-0.1),
  }
  const frame: H5aFrameInputResult = {
    nowSecs: MonotonicTimeSecs(2),
    raw: 0.05,
    deltaSecs: DeltaTimeSecs(0.05),
    walk: inputSnapshot,
    dead: false,
    held: () => 0,
    attackTriggered: false,
    attackHeld: false,
    canUse: false,
    useTriggered: options.useTriggered ?? false,
    useHeld: false,
    looked: false,
  }
  const movement: H5aMovementResult = {
    poseBeforeFrame: pose,
    groundedBeforeFrame: true,
    dimensionBeforeFrame: 'overworld',
    weatherBeforeFrame,
    sprinting: false,
  }
  const postFrame: H5bPostFrameResult = {
    deadAfterFrame: options.deadAfterFrame ?? false,
    dimensionChanged: false,
    postFramePose: pose,
    dimensionAfterFrame: options.dimension ?? 'overworld',
    bowAdvance: { state: IDLE_BOW_USE, release: null, capturedUse: false },
    groundedAfterFrame: true,
    playerHeals: [],
  }
  const h5aState = {
    simulationElapsedSecs: cell(0).state,
    redstoneDirty: cell(false).state,
    inventoryOpen: cell(false).state,
    brewingOpen: cell(false).state,
    selectedHotbarIndex: cell(0).state,
    nextItemUseRequestId: cell(0).state,
    fishingSession: cell(undefined).state,
    fishingWater: cell(undefined).state,
    multiplayerHandshakeComplete: cell(false).state,
  }
  const h5a = {
    world,
    entityManager: world.entities,
    targeting,
    playerApi: world.player,
    eyeLevelOffset: 1.62,
    currentChunkStore: world.chunkStore,
    blockPosition,
    blockTypeOfId,
    gameplayState,
    multiplayer: undefined,
    isCreativeMode: false,
    survivalHunger: gameplayState.survivalHunger,
    setInventoryOpen: () => undefined,
    setBrewingOpen: () => undefined,
    setFishingResult: (result: string) => fishingResults.push(result),
    markSessionDirty: () => undefined,
    sendVitalsCommand: () => undefined,
    renderCrosshair: () => undefined,
    playerSettings: { ...DEFAULT_PLAYER_SETTINGS, captionsEnabled: false },
    currentChunkContext: () => currentChunkContext,
    canvas: {
      setAttribute: (name: string, value: string) => canvasAttributes.set(name, value),
    },
    state: h5aState,
  } as unknown as H5aTickContext
  const h5b = {
    state: {
      activeChestId: cell<string | undefined>(undefined).state,
      activeFurnaceKey: cell<string | undefined>(undefined).state,
      witherRuntimeState: cell((await import('@nerima-games/mc-server/shared')).initialWitherRuntimeState()).state,
    },
    inventoryMode: () => 'player',
    applyPlayerDamage: (damage: unknown) => { damageCalls.push(damage) },
    applyWorldExplosion: () => Result.succeed(undefined),
    endDragonPosition: () => ({ x: 0, y: 64, z: 0 }),
    spawnDroppedItems: gameplay.spawnDroppedItems,
    spawnMobDrops: () => Effect.void,
    containerIdAt: () => '',
    furnaceKeyOf: () => '',
    drainPlayerHeals: gameplay.drainPlayerHeals,
    renderPlayerUi: () => playerUiCalls.state.set(playerUiCalls.get() + 1),
    dimensionContexts: new Map([[options.dimension ?? 'overworld', currentChunkContext]]),
    isLegacyGameplayItemType: (item: string) => item === 'flint_and_steel',
  } as unknown as H5cTickContext['h5b']
  const emptyEvents = Effect.succeed([])
  const adapters = {
    audio: { visible: () => [] },
    endAudio: { update: () => undefined },
    getReadAudioListenerForward: () => ({ x: 0, y: 0, z: -1 }),
    drainEndAudioEvents: () => [],
    queueEndAudio: (cue: string, position: SessionPosition) => endAudioCalls.push({ cue, position }),
    placementAudio: { request: () => undefined, confirm: () => undefined },
  }
  const services = {
    nearestVillagerForTrade: () => options.nearbyVillager,
    setTradeOpen: (open: boolean, villagerId?: string) => tradeOpenCalls.push({
      open,
      ...(villagerId === undefined ? {} : { villagerId }),
    }),
    targetedBlock: () => Effect.succeed(options.targetedBlock),
    fishingEnvironmentAt: () => Effect.succeed({
      hasWater: options.fishingHasWater ?? false,
      hasSkyAccess: false,
      isRaining: false,
      isOpenWater: false,
    }),
    networkFishingPhase: () => 'idle',
    vehicleService: {},
    vehicleList: () => [],
    localVehicleOccupant: 'player',
    replaceVehicle: () => undefined,
    multiplayerClient: {},
    playerSettings: () => ({ ...DEFAULT_PLAYER_SETTINGS, captionsEnabled: false }),
    endPortalComplete: () => false,
    useEndFeature: () => {
      endFeatureCalls.state.set(endFeatureCalls.get() + 1)
      return Effect.succeed(options.endFeatureResult ?? false)
    },
    renderBrewingUi: () => undefined,
    time,
    weather,
    redstoneContainerRuntime: {
      containerIdForStorageBlock: () => undefined,
      applyHopperTransfer: () => undefined,
      applyDispenserTrigger: () => undefined,
      applyDropperTrigger: () => undefined,
      applyPoweredPistonTransition: () => undefined,
    },
    redstoneRuntime: {
      drainLampTransitions: Effect.succeed(options.lampTransitions ?? []),
      drainPistonTransitions: emptyEvents,
      drainTriggerEvents: emptyEvents,
      drainHopperTransferEvents: emptyEvents,
      drainPoweredComponentTransitions: emptyEvents,
    },
    leverKeyOf: () => '',
    asBlockPosition: (position: SessionPosition) => blockPosition(position.x, position.y, position.z),
    worldWrite,
    streamAround: (context: DimensionChunkContext, x: number, z: number) => {
      streamCalls.push({ dimension: context.dimension, x, z })
      return Effect.void
    },
    presentWeather: () => undefined,
    presentWeatherRuntime: () => Effect.void,
    syncRenderedEntities: () => Effect.void,
    registerPortal: () => false,
    requiredSleepRatio: 1,
    sleepHud: { textContent: '', hidden: true },
    endDragonSnapshot: () => Effect.runSync(gameplayState.enderDragonEncounter.snapshot),
    adapters,
    uiFrameState,
    fpsValue: { textContent: '' },
    captionsParent: { replaceChildren: () => undefined },
    pendingItemUses: new Map(),
    pendingBlockUses: new Map(),
    pendingBlockPlacements: new Map(),
    pendingWitherSummonChecks: [],
    leverStates: new Map(),
    comparatorModes: new Map(),
    poweredRails: new Set(),
    redstoneLampTransitionLog: new Map(),
    isGameplayUseItemType: (item: string) => item === 'flint_and_steel',
    isGameplayHoeItem: () => false,
    isGameplayIgnitionItem: (item: string) => item === 'flint_and_steel',
    isPlaceableGameplayItem: (item: string) => item === 'stone',
  } as unknown as H5cTickContext['services']
  const state: H5cTickContext['state'] = {
    framesTotal: cell(41).state,
    renderedCaptionSignature: cell<string | undefined>(undefined).state,
    nextFishingRoll: cell(0).state,
    mountedVehicleId: cell<string | undefined>(undefined).state,
    activeBrewingStandAt: cell<SessionPosition | undefined>(undefined).state,
    brewingStatus: cell('closed').state,
    sleepRuntimeState: cell(initialSleepRuntimeState()).state,
    respawnLocation: cell<BedRespawnLocation | null>(null).state,
    networkSleepState: cell(initialSleepClientState()).state,
    nextSleepRequest: cell(0).state,
    appliedNightSkipRevision: cell<number | null>(null).state,
    multiplayerRejection: cell('').state,
    nextBlockUseRequestId: cell(0).state,
    nextBlockPlacementRequestId: cell(0).state,
    placementsRequested: cell(0).state,
    dragonEggRewarded: cell(false).state,
    exitPortalMaterialized: cell(false).state,
    nextMobDropId: cell(0).state,
    lastObservedItemUse: cell<ItemUseResult | undefined>(undefined).state,
  }
  const context = { h5a, h5b, services, state } as H5cTickContext

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: makeDocument(attributes),
  })

  const restoreDocument = (): void => {
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, 'document')
    } else {
      Object.defineProperty(globalThis, 'document', previousDocument)
    }
  }

  return {
    context,
    coordinator,
    worldWriteBatches,
    runInteractions,
    syncPlayerOwner,
    damageCalls,
    frame,
    movement,
    postFrame,
    world,
    attributes,
    canvasAttributes,
    tradeOpenCalls,
    fishingResults,
    streamCalls,
    endAudioCalls,
    endFeatureCalls,
    playerUiCalls,
    restoreDocument,
  }
}

type Harness = Awaited<ReturnType<typeof makeHarness>>

const withHarness = async (
  options: HarnessOptions,
  run: (harness: Harness) => void,
): Promise<void> => {
  const harness = await makeHarness(options)
  try {
    run(harness)
  } finally {
    harness.restoreDocument()
  }
}

describe('tick post-frame gameplay processing', () => {
  it.each([false, true])('settles mature harvest once with full inventory %s', async (fullInventory) => {
    const cropPosition = blockPosition(0, 64, 1)
    await withHarness({
      fullInventory,
      crops: { crops: [{ dimension: 'overworld', position: cropPosition, crop: 'potato_crop', growthSecs: POTATO_MATURITY_SECS }] },
    }, (harness) => {
      Effect.runSync(harness.world.chunkStore.load(chunkCoord(0, 0)))
      Effect.runSync(harness.world.chunkStore.setBlock(cropPosition, Option.getOrThrow(blockIdOf('potato_crop'))))
      const revision = Effect.runSync(harness.coordinator.revision)
      Effect.runSync(gameplay.requestPotatoHarvest(harness.context.h5a.gameplayState, 'harvest-1', cropPosition, 0.25))
      harness.context.services.pendingItemUses.set('harvest-1', { kind: 'harvest', dimension: 'overworld', position: cropPosition })
      expect(Effect.runSync(harness.world.chunkStore.getBlock(cropPosition))).toMatchObject({
        _tag: 'Block', block: Option.getOrThrow(blockIdOf('potato_crop')),
      })
      expect(Effect.runSync(harness.coordinator.revision)).toBe(revision)

      Effect.runSync(harness.runInteractions())

      const storage = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema))
      const crops = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_CROPS_OWNER_ID, CropSnapshotSchema))
      const dropped = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_DROPPED_ITEMS_OWNER_ID, gameplay.DroppedItemOwnerSnapshotSchema))
      expect(crops.state.crops).toEqual([])
      expect(Effect.runSync(harness.world.chunkStore.getBlock(cropPosition))).toMatchObject({
        _tag: 'Block', block: Option.getOrThrow(blockIdOf('air')),
      })
      expect(storage.state.inventory.slots.filter((stack) => stack?.item === 'potato').reduce((total, stack) => total + (stack?.count ?? 0), 0)).toBe(fullInventory ? 0 : 3)
      expect(dropped.state.items).toHaveLength(fullInventory ? 1 : 0)
      if (fullInventory) expect(dropped.state.items[0]?.behaviour).toMatchObject({ item: 'potato', count: 3 })
      expect(Effect.runSync(gameplay.drainGameplayEntityStageFaults(harness.context.h5a.gameplayState))).toEqual([])
      const committedRevision = Effect.runSync(harness.coordinator.revision)
      const liveStorage = Effect.runSync(harness.world.inventory.storageSnapshot)
      const liveEntities = Effect.runSync(harness.world.entities.snapshot)

      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })
      Effect.runSync(harness.runInteractions())
      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(Effect.runSync(harness.coordinator.revision)).toBe(committedRevision)
      expect(Effect.runSync(harness.world.inventory.storageSnapshot)).toEqual(liveStorage)
      expect(Effect.runSync(harness.world.entities.snapshot)).toEqual(liveEntities)
      expect(harness.context.services.pendingItemUses.size).toBe(0)
    })
  })

  it.each(['till', 'plant', 'eat', 'ignite'])('does not repeat committed %s item-use effects', async (action) => {
    const selectedItem = action === 'till' ? 'wooden_hoe' : action === 'ignite' ? 'flint_and_steel' : 'potato'
    await withHarness({ selectedItem, hungry: action === 'eat' }, (harness) => {
      const ground = blockPosition(0, 64, 1)
      const above = blockPosition(0, 65, 1)
      Effect.runSync(harness.world.chunkStore.load(chunkCoord(0, 0)))
      Effect.runSync(harness.world.chunkStore.setBlock(ground, Option.getOrThrow(blockIdOf(action === 'plant' ? 'farmland' : 'dirt'))))
      const state = harness.context.h5a.gameplayState
      if (action === 'till') {
        Effect.runSync(gameplay.requestSoilTill(state, 'item-1', ground, 'wooden_hoe'))
        harness.context.services.pendingItemUses.set('item-1', { kind: 'till', slotIndex: 0, heldItem: 'wooden_hoe' })
      } else if (action === 'plant') {
        Effect.runSync(gameplay.requestPotatoPlanting(state, 'item-1', ground))
        harness.context.services.pendingItemUses.set('item-1', { kind: 'plant', slotIndex: 0, dimension: 'overworld' })
      } else if (action === 'eat') {
        Effect.runSync(gameplay.requestPotatoFoodUse(state, 'item-1', Effect.runSync(harness.world.vitals.snapshot)))
        harness.context.services.pendingItemUses.set('item-1', { kind: 'eat', slotIndex: 0 })
      } else {
        for (const chunk of gameplay.chunkCoordsAround(above, MAX_PORTAL_WIDTH + 1)) {
          Effect.runSync(harness.world.chunkStore.load(chunk))
        }
        Effect.runSync(gameplay.requestItemUse(state, 'item-1', above, 'flint_and_steel'))
        harness.context.services.pendingItemUses.set('item-1', { kind: 'ignition', slotIndex: 0, heldItem: 'flint_and_steel', dimension: 'overworld' })
      }
      const revision = Effect.runSync(harness.coordinator.revision)

      Effect.runSync(harness.runInteractions())

      expect(Effect.runSync(Ref.get(state.itemUseResults))).toEqual([
        expect.objectContaining({ requestId: 'item-1', success: true }),
      ])
      expect(Effect.runSync(harness.coordinator.revision)).toBeGreaterThan(revision)
      expect(Effect.runSync(gameplay.drainGameplayEntityStageFaults(state))).toEqual([])
      const committedStorage = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema))
      const committedCrops = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_CROPS_OWNER_ID, CropSnapshotSchema))
      const committedVitals = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_VITALS_OWNER_ID, gameplay.ExperienceOrbVitalsOwnerSnapshotSchema))
      const liveStorage = Effect.runSync(harness.world.inventory.storageSnapshot)
      const liveVitals = Effect.runSync(harness.world.vitals.snapshot)
      const committedRevision = Effect.runSync(harness.coordinator.revision)

      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })
      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(Effect.runSync(harness.coordinator.revision)).toBe(committedRevision)
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema))).toEqual(committedStorage)
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_CROPS_OWNER_ID, CropSnapshotSchema))).toEqual(committedCrops)
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_VITALS_OWNER_ID, gameplay.ExperienceOrbVitalsOwnerSnapshotSchema))).toEqual(committedVitals)
      expect(Effect.runSync(harness.world.inventory.storageSnapshot)).toEqual(liveStorage)
      expect(Effect.runSync(harness.world.vitals.snapshot)).toEqual(liveVitals)
      expect(harness.context.state.lastObservedItemUse.get()).toMatchObject({ requestId: 'item-1', success: true })
      expect(harness.context.services.pendingItemUses.size).toBe(0)
    })
  })

  it('settles a pearl consumption, displacement, and damage once', async () => {
    await withHarness({ useTriggered: true, selectedItem: 'ender_pearl' }, (harness) => {
      const playerBefore = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema))
      const vitalsBefore = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_VITALS_OWNER_ID, gameplay.ExperienceOrbVitalsOwnerSnapshotSchema))
      const revision = Effect.runSync(harness.coordinator.revision)
      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })
      expect(Effect.runSync(harness.coordinator.revision)).toBe(revision)
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state.inventory.slots[0]?.count).toBe(1)

      Effect.runSync(harness.runInteractions())

      const playerAfter = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema))
      const vitalsAfter = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_VITALS_OWNER_ID, gameplay.ExperienceOrbVitalsOwnerSnapshotSchema))
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state.inventory.slots[0]).toBeUndefined()
      expect(playerAfter.state.pose.feetPosition).not.toEqual(playerBefore.state.pose.feetPosition)
      expect(vitalsAfter.state.vitals.healthPoints).toBe(vitalsBefore.state.vitals.healthPoints - gameplay.ENDER_PEARL_DAMAGE)
      expect(Effect.runSync(gameplay.drainGameplayEntityStageFaults(harness.context.h5a.gameplayState))).toEqual([])
      const committedRevision = Effect.runSync(harness.coordinator.revision)
      const livePose = Effect.runSync(harness.world.player.pose)
      const liveStorage = Effect.runSync(harness.world.inventory.storageSnapshot)
      const frame = { ...harness.frame, useTriggered: false }

      runTickPostFrameGameplay(harness.context, { frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })
      Effect.runSync(harness.runInteractions())
      runTickPostFrameGameplay(harness.context, { frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(Effect.runSync(harness.coordinator.revision)).toBe(committedRevision)
      expect(Effect.runSync(harness.world.player.pose)).toEqual(livePose)
      expect(Effect.runSync(harness.world.inventory.storageSnapshot)).toEqual(liveStorage)
      expect(harness.damageCalls).toEqual([])
    })
  })

  it('publishes fixed player pose, grounded state, and frame count', async () => {
    await withHarness({}, (harness) => {
      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.canvasAttributes.get('data-player-feet')).toBe('12.35,64.23,-7.89')
      expect(harness.canvasAttributes.get('data-player-grounded')).toBe('true')
      expect(harness.attributes.get('data-frames')).toBe('42')
    })
  })

  it('uses the end feature for an eye of ender and renders its UI route', async () => {
    await withHarness({
      useTriggered: true,
      selectedItem: 'eye_of_ender',
      endFeatureResult: true,
    }, (harness) => {
      expect(harness.frame.useTriggered).toBe(true)
      expect(Effect.runSync(harness.world.inventory.snapshot).slots[0]?.item).toBe('eye_of_ender')

      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.endFeatureCalls.get()).toBe(1)
      expect(harness.playerUiCalls.get()).toBe(2)
    })
  })

  it('opens the nearby villager trade on a use trigger', async () => {
    const villager: PersistedVillager = {
      id: 'villager-7',
      profession: 'farmer',
      dimension: 'overworld',
      feetPosition: position(PositionAxis(12.346), PositionAxis(64.234), PositionAxis(-7.891)),
    }

    await withHarness({
      useTriggered: true,
      nearbyVillager: villager,
    }, (harness) => {
      expect(harness.frame.useTriggered).toBe(true)

      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.tradeOpenCalls).toEqual([{ open: true, villagerId: 'villager-7' }])
    })
  })

  it('casts a local fishing rod into water and records the fishing session', async () => {
    const target = {
      position: position(PositionAxis(2), PositionAxis(64), PositionAxis(-3)),
      adjacentPosition: position(PositionAxis(2), PositionAxis(65), PositionAxis(-3)),
      block: Option.getOrThrow(blockIdOf('water')),
    }
    await withHarness({
      useTriggered: true,
      selectedItem: 'fishing_rod',
      targetedBlock: target,
      fishingHasWater: true,
    }, (harness) => {
      expect(harness.frame.useTriggered).toBe(true)
      expect(Effect.runSync(harness.world.inventory.snapshot).slots[0]?.item).toBe('fishing_rod')

      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.fishingResults).toEqual(['cast'])
      expect(harness.context.h5a.state.fishingWater.get()).toEqual({
        dimension: 'overworld',
        position: target.position,
      })
    })
  })

  it('requests stone placement at the cell adjacent to the targeted block', async () => {
    await withHarness({ useTriggered: true, selectedItem: 'stone' }, (harness) => {
      const supportPosition = blockPosition(0, 65, -2)
      Effect.runSync(harness.world.worldgenChunkStore.load(chunkCoord(0, -1)))
      Effect.runSync(harness.world.player.restore({
        feetPosition: position(PositionAxis(0.5), PositionAxis(64), PositionAxis(0.5)),
        yawRadians: AngleRadians(0),
        pitchRadians: AngleRadians(0),
      }, 'overworld'))
      Effect.runSync(harness.syncPlayerOwner())
      Effect.runSync(harness.world.chunkStore.setBlock(supportPosition, Option.getOrThrow(blockIdOf('stone'))))
      expect(harness.frame.useTriggered).toBe(true)
      expect(Effect.runSync(harness.world.inventory.snapshot).slots[0]?.item).toBe('stone')
      expect(Effect.runSync(harness.world.chunkStore.getBlock(supportPosition))).toMatchObject({
        _tag: 'Block',
        block: Option.getOrThrow(blockIdOf('stone')),
      })

      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect([...harness.context.services.pendingBlockPlacements.values()]).toEqual([{
        dimension: 'overworld',
        item: 'stone',
        position: { x: 0, y: 65, z: -1 },
      }])
      expect(harness.context.state.placementsRequested.get()).toBe(1)
    })
  })

  it('queues flint-and-steel use at the targeted block cell', async () => {
    await withHarness({ useTriggered: true, selectedItem: 'flint_and_steel' }, (harness) => {
      const supportPosition = blockPosition(0, 65, -2)
      Effect.runSync(harness.world.worldgenChunkStore.load(chunkCoord(0, -1)))
      Effect.runSync(harness.world.player.restore({
        feetPosition: position(PositionAxis(0.5), PositionAxis(64), PositionAxis(0.5)),
        yawRadians: AngleRadians(0),
        pitchRadians: AngleRadians(0),
      }, 'overworld'))
      Effect.runSync(harness.syncPlayerOwner())
      Effect.runSync(harness.world.chunkStore.setBlock(supportPosition, Option.getOrThrow(blockIdOf('stone'))))
      expect(harness.frame.useTriggered).toBe(true)
      expect(Effect.runSync(harness.world.inventory.snapshot).slots[0]?.item).toBe('flint_and_steel')

      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect([...harness.context.services.pendingItemUses.entries()]).toEqual([['item-use-1', {
        kind: 'ignition',
        slotIndex: 0,
        heldItem: 'flint_and_steel',
        dimension: 'overworld',
      }]])
      expect(Effect.runSync(Ref.get(harness.context.h5a.gameplayState.pendingItemUses))).toEqual([{
        requestId: 'item-use-1',
        positionKey: '0,65,-1',
        heldItem: 'flint_and_steel',
      }])
    })
  })

  it('writes a lit redstone lamp transition into the active chunk store', async () => {
    const position = { x: 4, y: 70, z: -2 }
    await withHarness({
      lampTransitions: [{ dimension: 'overworld', position, lit: true }],
    }, (harness) => {
      Effect.runSync(harness.world.worldgenChunkStore.load(chunkCoord(0, -1)))
      const initialRevision = Effect.runSync(harness.coordinator.revision)
      const initialDimensionRevision = Effect.runSync(harness.coordinator.dimensionRevision('overworld'))
      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.worldWriteBatches).toEqual([{
        world: harness.coordinator.worldId,
        expectedWorldRevision: initialRevision,
        dimension: 'overworld',
        expectedDimensionRevision: initialDimensionRevision,
        edits: [{ position: blockPosition(position.x, position.y, position.z), block: Option.getOrThrow(blockIdOf('redstone_lamp_lit')) }],
      }])
      expect(Effect.runSync(harness.coordinator.revision)).toBe(initialRevision + 1)
      expect(Effect.runSync(harness.world.chunkStore.getBlock(blockPosition(position.x, position.y, position.z)))).toMatchObject({
        _tag: 'Block',
        block: Option.getOrThrow(blockIdOf('redstone_lamp_lit')),
      })
    })
  })

  it.each(['target', 'environment'])('propagates a fishing %s failure before casting', async (stage) => {
    await withHarness({
      useTriggered: true,
      selectedItem: 'fishing_rod',
      targetedBlock: {
        position: position(PositionAxis(2), PositionAxis(64), PositionAxis(-3)),
        adjacentPosition: position(PositionAxis(2), PositionAxis(65), PositionAxis(-3)),
        block: Option.getOrThrow(blockIdOf('water')),
      },
    }, (harness) => {
      const failure = {
        _tag: 'CoordinateConversionFailure', reason: 'block-axis-out-of-range', axis: 'x', kind: 'RangeError',
      } as const
      const context: H5cTickContext = {
        ...harness.context,
        services: {
          ...harness.context.services,
          ...(stage === 'target'
            ? { targetedBlock: () => Effect.fail(failure) }
            : { fishingEnvironmentAt: () => Effect.fail(failure) }),
        },
      }
      const result = Effect.runSync(Effect.result(runTickPostFrameGameplayEffect(context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(failure)
      expect(harness.fishingResults).toEqual([])
      expect(context.h5a.state.fishingSession.get()).toBeUndefined()
      expect(harness.streamCalls).toEqual([])
    })
  })

  it('reports an End feature failure and stops later use routing', async () => {
    await withHarness({ useTriggered: true, selectedItem: 'eye_of_ender' }, (harness) => {
      const failure = new RangeError('fixture End feature rejection')
      const context: H5cTickContext = {
        ...harness.context,
        services: { ...harness.context.services, useEndFeature: () => Effect.fail(failure) },
      }
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const result = Effect.runSync(Effect.result(runTickPostFrameGameplayEffect(context, {
          frame: harness.frame,
          movement: harness.movement,
          postFrame: harness.postFrame,
          nowSecs: MonotonicTimeSecs(2),
        })))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure).toBe(failure)
        expect(warning).toHaveBeenCalledWith('Unable to use End feature', failure)
        expect(harness.playerUiCalls.get()).toBe(0)
        expect(harness.streamCalls).toEqual([])
      } finally {
        warning.mockRestore()
      }
    })
  })

  it('reports a bed explosion failure before announcing its completion', async () => {
    await withHarness({ useTriggered: true, dimension: 'end' }, (harness) => {
      Effect.runSync(harness.world.chunkStore.load(chunkCoord(0, -1)))
      const failure = { _tag: 'ExplosionValidationFailure', path: 'power', reason: 'fixture rejection' } as const
      const context: H5cTickContext = {
        ...harness.context,
        h5a: {
          ...harness.context.h5a,
          currentChunkStore: {
            ...harness.world.chunkStore,
            getBlock: () => Effect.succeed({ _tag: 'Block', block: Option.getOrThrow(blockIdOf('bed')) }),
          },
        },
        h5b: { ...harness.context.h5b, applyWorldExplosion: () => Result.fail(failure) },
      }
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const result = Effect.runSync(Effect.result(runTickPostFrameGameplayEffect(context, {
          frame: harness.frame,
          movement: harness.movement,
          postFrame: harness.postFrame,
          nowSecs: MonotonicTimeSecs(2),
        })))

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure).toBe(failure)
        expect(warning).toHaveBeenCalledWith('Unable to apply bed explosion', failure)
        expect(harness.worldWriteBatches).toHaveLength(1)
        expect(harness.attributes.has('data-bed-explosion-request')).toBe(false)
        expect(harness.attributes.has('data-sleep-result')).toBe(false)
        expect(harness.streamCalls).toEqual([])
      } finally {
        warning.mockRestore()
      }
    })
  })

  it('returns an invalid targeted block registry entry as a typed failure', async () => {
    await withHarness({ useTriggered: true }, (harness) => {
      const context: H5cTickContext = {
        ...harness.context,
        h5a: {
          ...harness.context.h5a,
          currentChunkStore: {
            ...harness.world.chunkStore,
            getBlock: () => Effect.succeed({ _tag: 'Block', block: BlockId(65535) }),
          },
        },
      }
      const result = Effect.runSync(Effect.result(runTickPostFrameGameplayEffect(context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })))

      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'UnknownTargetBlockId', blockId: 65535 } })
      expect(harness.streamCalls).toEqual([])
    })
  })

  it.each(['conflict', 'invalid', 'unavailable'])('propagates a %s port failure before confirming a lamp', async (kind) => {
    const at = blockPosition(4, 70, -2)
    await withHarness({ lampTransitions: [{ dimension: 'overworld', position: at, lit: true }] }, (harness) => {
      Effect.runSync(harness.world.worldgenChunkStore.load(chunkCoord(0, -1)))
      const worldRevision = Effect.runSync(harness.coordinator.revision)
      const dimensionRevision = Effect.runSync(harness.coordinator.dimensionRevision('overworld'))
      const failure = kind === 'conflict'
        ? new WorldWriteConflict({
          expectedWorldRevision: worldRevision, currentWorldRevision: worldRevision,
          expectedDimensionRevision: dimensionRevision, currentDimensionRevision: dimensionRevision,
        })
        : kind === 'invalid'
          ? Schema.decodeUnknownSync(WorldWriteInvalidBatch)({ _tag: 'WorldWriteInvalidBatch', reason: 'empty' })
          : Schema.decodeUnknownSync(WorldWriteChunkUnavailableSchema)({
            _tag: 'WorldWriteChunkUnavailable', dimension: 'overworld', chunk: '0,-1',
          })
      const context: H5cTickContext = {
        ...harness.context,
        services: { ...harness.context.services, worldWrite: { applyBatch: () => Effect.fail(failure) } },
      }
      const result = Effect.runSync(Effect.result(runTickPostFrameGameplayEffect(context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })))

      expect(result).toMatchObject({ _tag: 'Failure', failure })
      expect(Effect.runSync(harness.world.chunkStore.getBlock(at))).toMatchObject({
        _tag: 'Block', block: Option.getOrThrow(blockIdOf('air')),
      })
      expect(Effect.runSync(harness.coordinator.revision)).toBe(worldRevision)
      expect(context.services.redstoneLampTransitionLog.size).toBe(0)
      expect(harness.streamCalls).toEqual([])
    })
  })

  it.each([
    { kind: 'owner', failure: { _tag: 'WorldCommitCoordinatorInvalidOptions', value: 'stream failure' } },
    { kind: 'chunk store', failure: { _tag: 'DirtyChunkEvictionError', coord: chunkCoord(0, 0) } },
  ] satisfies ReadonlyArray<{ kind: string; failure: ChunkStreamingFailure }>)('propagates streaming $kind failures before presenting the frame', async ({ failure }) => {
    await withHarness({}, (harness) => {
      const context: H5cTickContext = {
        ...harness.context,
        services: { ...harness.context.services, streamAround: () => Effect.fail(failure) },
      }
      const result = Effect.runSync(Effect.result(runTickPostFrameGameplayEffect(context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })))

      expect(result).toEqual(Result.fail(failure))
      expect(harness.canvasAttributes.has('data-player-feet')).toBe(false)
    })
  })

  it('streams chunks around the post-frame player position', async () => {
    await withHarness({}, (harness) => {
      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.streamCalls).toEqual([{ dimension: 'overworld', x: 12.346, z: -7.891 }])
    })
  })

  it('returns a weather presentation failure as the frame failure', async () => {
    await withHarness({}, (harness) => {
      const rejected = PositionAxis.result(Number.NaN)
      if (Result.isSuccess(rejected)) throw new Error('PositionAxis accepted NaN')
      const context: H5cTickContext = {
        ...harness.context,
        services: { ...harness.context.services, presentWeatherRuntime: () => Effect.fail(rejected.failure) },
      }

      const result = Effect.runSync(Effect.result(runTickPostFrameGameplayEffect(context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(rejected.failure)
    })
  })

  it('removes the local sleeper after a death frame', async () => {
    const bed: SleepLocation = {
      dimension: 'overworld',
      position: { x: 3, y: 64, z: 3 },
      bedPosition: { x: 3, y: 64, z: 3 },
    }
    await withHarness({ deadAfterFrame: true }, (harness) => {
      harness.context.state.sleepRuntimeState.set(enterSleep(initialSleepRuntimeState(), 'local', bed))
      expect(harness.context.state.sleepRuntimeState.get().sleepers).toHaveLength(1)
      expect(harness.postFrame.deadAfterFrame).toBe(true)

      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.context.state.sleepRuntimeState.get().sleepers).toEqual([])
      expect(harness.attributes.get('data-sleeping-players')).toBe('0')
    })
  })

  it('applies the dragon defeat events to the portal and reward state', async () => {
    await withHarness({ dimension: 'end' }, (harness) => {
      for (const cx of [-1, 0]) {
        for (const cz of [-1, 0]) Effect.runSync(harness.world.worldgenChunkStore.load(chunkCoord(cx, cz)))
      }
      const damage = Effect.runSync(harness.context.h5a.gameplayState.enderDragonEncounter.damageByPlayer(200))
      expect(damage).toMatchObject({ _tag: 'Applied', state: { phase: 'dead', health: 0 } })

      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.context.state.dragonEggRewarded.get()).toBe(true)
      expect(harness.context.state.exitPortalMaterialized.get()).toBe(true)
      expect(harness.worldWriteBatches).toHaveLength(1)
      expect(harness.worldWriteBatches[0]?.edits).toHaveLength(9)
      for (let x = -1; x <= 1; x += 1) {
        for (let z = -1; z <= 1; z += 1) {
          expect(Effect.runSync(harness.world.chunkStore.getBlock(blockPosition(x, 64, z)))).toMatchObject({
            _tag: 'Block', block: Option.getOrThrow(blockIdOf('end_portal')),
          })
        }
      }
      expect(harness.canvasAttributes.get('data-end-dragon-phase')).toBe('dead')
      expect(Effect.runSync(harness.world.chunkStore.getBlock(blockPosition(0, 64, 0)))).toMatchObject({
        _tag: 'Block',
        block: Option.getOrThrow(blockIdOf('end_portal')),
      })
      expect(harness.endAudioCalls.map(({ cue }) => cue)).toEqual(['dragonHurt', 'dragonReward', 'exitPortal'])
    })
  })
})
