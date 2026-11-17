import { AngleRadians, BlockAddressSchema, InterpolationFraction, SimulationTick, BlockAxis, BlockId, ClockPort, EntityId, EntityIdSchema, EpochMillis, fixedClock, blockIdOf, blockTypeOfId, blockPosition as kernelBlockPosition, ChunkAxis, chunkCoord as kernelChunkCoord, DeltaTimeSecs, itemStack, MonotonicTimeSecs, position, PositionAxis, SimulationTickSchema, StackCount, WorldId, MAX_PORTAL_WIDTH, WorldWriteChunkUnavailableSchema, WorldWriteConflict, WorldWriteInvalidBatch, type WorldWriteBatch, type WorldWritePort } from '@nerima-games/mc-kernel'
import {
  type InputSnapshot,
  defaultBindings,
  INITIAL_INPUT_SEQUENCE,
} from '@nerima-games/mc-render'
import { CropSnapshotSchema, DomainEventBus, DomainEventBusLayer, EventSubscriberCapacitySchema, PlayerServiceSnapshotSchema, PlayerStorageSnapshotSchema, WorldCommitCoordinator, makeBrewingService, makeTimeService, makeWeatherService, makeWorldCommitCoordinator, HungerPoints, POTATO_MATURITY_SECS, type CropSnapshot } from '@nerima-games/mc-sim'
import { CHUNK_SIZE_XZ, CHUNK_VOLUME, BIOMES, type ChunkSource } from '@nerima-games/mc-worldgen'
import { type ItemUseResult, type MobBehaviour } from '@nerima-games/mx-gameplay'
import { Context, Effect, Exit, Layer, Option, Ref, Result, Schema, Scope } from 'effect'
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
import { runFramePresentation, runTickPostFrameGameplay as runTickPostFrameGameplayEffect } from '../apps/web/tick/post-frame-gameplay'
import { initialProjectileRuntimeState, launchRuntimeProjectile } from '../apps/web/projectile-runtime'
import { BlocksPerSecond } from '@nerima-games/mc-physics'
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
  sequence: INITIAL_INPUT_SEQUENCE,
  bindings: defaultBindings(),
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
  selectedItem?: 'eye_of_ender' | 'ender_pearl' | 'fishing_rod' | 'stone' | 'flint_and_steel' | 'wooden_hoe' | 'potato' | 'blaze_powder' | 'potion_of_poison'
  brewingEventBusUnavailable?: boolean
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
  const brewingService = Effect.runSync(makeBrewingService(gameplay.GAMEPLAY_BREWING_OWNER_ID))
  const appScope = Effect.runSync(Scope.make())
  const eventBusContext = Effect.runSync(Layer.buildWithScope(
    DomainEventBusLayer(Schema.decodeUnknownSync(EventSubscriberCapacitySchema)(256)),
    appScope,
  ))
  const eventBus = Context.get(eventBusContext, DomainEventBus)
  const weatherBeforeFrame = Effect.runSync(weather.snapshot)
  const commit = {
    coordinator,
    playerOwnerId: gameplay.GAMEPLAY_PLAYER_OWNER_ID,
    playerStorageOwnerId: gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
    cropOwnerId: gameplay.GAMEPLAY_CROPS_OWNER_ID,
    droppedItemsOwnerId: gameplay.GAMEPLAY_DROPPED_ITEMS_OWNER_ID,
    vitalsOwnerId: gameplay.GAMEPLAY_VITALS_OWNER_ID,
    entitiesOwnerId: gameplay.GAMEPLAY_ENTITIES_OWNER_ID,
    brewingOwnerId: gameplay.GAMEPLAY_BREWING_OWNER_ID,
    brewingService,
    statusEffectsOwnerId: gameplay.GAMEPLAY_STATUS_EFFECTS_OWNER_ID,
    ...(options.brewingEventBusUnavailable === true ? {} : { eventBus }),
  }
  const interactions = Option.getOrThrow(Option.fromNullishOr(gameplay.gameplayStages(
    gameplayState, world.chunkStore, world.entities, world.inventory, world.player,
    time, undefined, {}, commit,
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
  // The stand recorded when the brewing stand opens, which a multiplayer open command names.
  const brewingOpenCalls: Array<{ readonly open: boolean; readonly standAt: SessionPosition | undefined }> = []
  const fishingResults: string[] = []
  const streamCalls: Array<{ readonly dimension: string; readonly x: number; readonly z: number }> = []
  const damageCalls: Array<unknown> = []
  const endAudioCalls: Array<{ readonly cue: string; readonly position: SessionPosition }> = []
  const endFeatureCalls = cell(0)
  const playerUiCalls = cell(0)
  const crosshairCalls: Array<MonotonicTimeSecs> = []
  const syncRenderedEntitiesCalls = cell(0)
  const weatherPresentations: Array<{ readonly weather: string; readonly nowSecs: MonotonicTimeSecs }> = []
  const captionRenders = cell(0)
  const debugOverlayUpdates: Array<number | undefined> = []
  const fpsValue = { textContent: '' }
  const projectileHud = { textContent: '', hidden: true }
  const launchArrow = (state: ReturnType<typeof initialProjectileRuntimeState>, dimension: 'overworld' | 'nether') =>
    launchRuntimeProjectile(state, {
      dimension,
      position: position(PositionAxis(0), PositionAxis(65), PositionAxis(0)),
      yawRadians: AngleRadians(0),
      pitchRadians: AngleRadians(0),
      speed: BlocksPerSecond(10),
      damage: 5,
      knockback: 1,
      shooterId: EntityId('player'),
    })
  const projectileRuntimeState = cell(launchArrow(launchArrow(initialProjectileRuntimeState(), 'overworld'), 'nether'))
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
    setBrewingOpen: (open: boolean) => brewingOpenCalls.push({ open, standAt: state.activeBrewingStandAt.get() }),
    setFishingResult: (result: string) => fishingResults.push(result),
    markSessionDirty: () => undefined,
    sendVitalsCommand: () => undefined,
    renderCrosshair: (nowSecs: MonotonicTimeSecs) => { crosshairCalls.push(nowSecs) },
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
      projectileRuntimeState: projectileRuntimeState.state,
    },
    projectileHud,
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
    brewingService,
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
    presentWeatherRuntime: (state: { readonly weather: string }, _pose: unknown, nowSecs: MonotonicTimeSecs) => Effect.sync(() => {
      weatherPresentations.push({ weather: state.weather, nowSecs })
    }),
    syncRenderedEntities: () => Effect.sync(() => syncRenderedEntitiesCalls.state.set(syncRenderedEntitiesCalls.get() + 1)),
    registerPortal: () => false,
    requiredSleepRatio: 1,
    sleepHud: { textContent: '', hidden: true },
    endDragonSnapshot: () => Effect.runSync(gameplayState.enderDragonEncounter.snapshot),
    adapters,
    uiFrameState,
    fpsValue,
    captionsParent: { replaceChildren: () => captionRenders.state.set(captionRenders.get() + 1) },
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
  const presentationContext = {
    ...context,
    updateDebugOverlay: (rawDeltaSecs: number | undefined) => Effect.sync(() => { debugOverlayUpdates.push(rawDeltaSecs) }),
  }

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: makeDocument(attributes),
  })

  const restoreDocument = (): void => {
    Effect.runSync(Scope.close(appScope, Exit.void))
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
    brewingOpenCalls,
    fishingResults,
    streamCalls,
    endAudioCalls,
    endFeatureCalls,
    playerUiCalls,
    crosshairCalls,
    syncRenderedEntitiesCalls,
    weatherPresentations,
    captionRenders,
    debugOverlayUpdates,
    fpsValue,
    projectileHud,
    projectileRuntimeState,
    presentationContext,
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

const presentationFrame = {
  partialTick: InterpolationFraction(0),
  simulationTick: SimulationTick(0),
  raw: DeltaTimeSecs(0.016),
  nowSecs: MonotonicTimeSecs(2),
}

describe('tick post-frame gameplay processing', () => {
  it('collects a queued brewing bottle through the stage and presents the result', async () => {
    await withHarness({}, (harness) => {
      const state = harness.context.h5a.gameplayState
      const stand = blockPosition(0, 64, 1)
      Effect.runSync(harness.world.chunkStore.load(chunkCoord(0, 0)))
      Effect.runSync(harness.world.chunkStore.setBlock(stand, Option.getOrThrow(blockIdOf('brewing_stand'))))
      Effect.runSync(harness.context.services.brewingService.setBottle(
        0, Result.getOrThrow(itemStack('potion_of_poison', StackCount(1))),
      ).pipe(Effect.provideService(WorldCommitCoordinator, harness.coordinator)))
      Effect.runSync(gameplay.collectBrewingPotion(state, {
        requestId: 'brewing-collect-1',
        actor: Schema.decodeUnknownSync(EntityIdSchema)('mx-gameplay:player-avatar'),
        tick: Schema.decodeUnknownSync(SimulationTickSchema)(Effect.runSync(Ref.get(state.tickCount))),
        address: Schema.decodeUnknownSync(BlockAddressSchema)({ dimension: 'overworld', position: stand }),
        bottleIndex: 0,
      }))
      harness.context.services.pendingItemUses.set('brewing-collect-1', { kind: 'brewing', action: 'collect' })

      Effect.runSync(harness.runInteractions())

      expect({
        results: Effect.runSync(Ref.get(state.itemUseResults)),
        faults: Effect.runSync(gameplay.drainGameplayEntityStageFaults(state)),
        unsupported: Effect.runSync(Ref.get(state.unsupportedOperations)),
      }).toEqual({
        results: [{ action: 'CollectBrewingBottle', requestId: 'brewing-collect-1', success: true, outcome: { _tag: 'Collected', item: 'potion_of_poison', count: 1, remainingCount: 0 } }],
        faults: [],
        unsupported: [],
      })
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state.inventory.slots[0]?.item).toBe('potion_of_poison')
      expect(Effect.runSync(harness.context.services.brewingService.snapshot.pipe(Effect.provideService(WorldCommitCoordinator, harness.coordinator))).bottles[0]).toBeUndefined()

      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(harness.context.state.brewingStatus.get()).toBe('Collected potion_of_poison')
      expect(harness.context.services.pendingItemUses.has('brewing-collect-1')).toBe(false)
    })
  })

  it('advances an active brew by one frame delta', async () => {
    await withHarness({}, (harness) => {
      const service = harness.context.services.brewingService
      Effect.runSync(service.restore({
        bottles: [Result.getOrThrow(itemStack('water_bottle', StackCount(1))), undefined, undefined],
        ingredient: Result.getOrThrow(itemStack('nether_wart', StackCount(1))),
        fuel: undefined,
        fuelCharges: 2,
        brewProgressSecs: 5,
      }).pipe(Effect.provideService(WorldCommitCoordinator, harness.coordinator)))

      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      const brewing = Effect.runSync(service.snapshot.pipe(Effect.provideService(WorldCommitCoordinator, harness.coordinator)))
      expect(brewing.brewProgressSecs).toBeCloseTo(5.05)
      expect(brewing.fuelCharges).toBe(2)
      expect(brewing.bottles[0]?.item).toBe('water_bottle')
    })
  })

  it('drinks a queued potion through the stage and commits its storage and effect together', async () => {
    await withHarness({ selectedItem: 'potion_of_poison' }, (harness) => {
      const state = harness.context.h5a.gameplayState
      const revision = Effect.runSync(harness.coordinator.revision)
      Effect.runSync(gameplay.useBrewingPotion(state, {
        requestId: 'brewing-drink-1',
        actor: Schema.decodeUnknownSync(EntityIdSchema)('mx-gameplay:player-avatar'),
        tick: Schema.decodeUnknownSync(SimulationTickSchema)(Effect.runSync(Ref.get(state.tickCount))),
        slotIndex: 0,
      }))
      harness.context.services.pendingItemUses.set('brewing-drink-1', { kind: 'brewing', action: 'drink' })

      Effect.runSync(harness.runInteractions())

      expect(Effect.runSync(Ref.get(state.itemUseResults))).toMatchObject([
        { action: 'DrinkPotion', requestId: 'brewing-drink-1', success: true, outcome: { _tag: 'Consumed', item: 'potion_of_poison' } },
      ])
      const storage = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema))
      const effects = Effect.runSync(gameplay.snapshotStatusEffects(state, {
        coordinator: harness.coordinator,
        playerOwnerId: gameplay.GAMEPLAY_PLAYER_OWNER_ID,
        playerStorageOwnerId: gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
        statusEffectsOwnerId: gameplay.GAMEPLAY_STATUS_EFFECTS_OWNER_ID,
      }))
      expect(storage.revision).toBe(revision + 1)
      expect(storage.state.inventory.slots[0]).toMatchObject({ item: 'glass_bottle', count: 1 })
      expect(effects.effects).toMatchObject([{ type: 'poison', remainingSecs: 45 }])
      expect(Effect.runSync(gameplay.drainGameplayEntityStageFaults(state))).toEqual([])
      expect(Effect.runSync(Ref.get(state.unsupportedOperations))).toEqual([])

      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(harness.context.state.brewingStatus.get()).toBe('Drank potion_of_poison')
      expect(harness.context.services.pendingItemUses.has('brewing-drink-1')).toBe(false)
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema))).toEqual(storage)
    })
  })

  it('settles an unsupported brewing request without draining other request ids', async () => {
    await withHarness({ brewingEventBusUnavailable: true }, (harness) => {
      const state = harness.context.h5a.gameplayState
      const stand = blockPosition(0, 64, 1)
      Effect.runSync(harness.world.chunkStore.load(chunkCoord(0, 0)))
      Effect.runSync(harness.world.chunkStore.setBlock(stand, Option.getOrThrow(blockIdOf('brewing_stand'))))
      Effect.runSync(harness.context.services.brewingService.setBottle(
        0, Result.getOrThrow(itemStack('potion_of_poison', StackCount(1))),
      ).pipe(Effect.provideService(WorldCommitCoordinator, harness.coordinator)))
      const storage = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema))
      Effect.runSync(gameplay.collectBrewingPotion(state, {
        requestId: 'brewing-unsupported-1',
        actor: Schema.decodeUnknownSync(EntityIdSchema)('mx-gameplay:player-avatar'),
        tick: Schema.decodeUnknownSync(SimulationTickSchema)(Effect.runSync(Ref.get(state.tickCount))),
        address: Schema.decodeUnknownSync(BlockAddressSchema)({ dimension: 'overworld', position: stand }),
        bottleIndex: 0,
      }))
      harness.context.services.pendingItemUses.set('brewing-unsupported-1', { kind: 'brewing', action: 'collect' })
      harness.context.services.pendingItemUses.set('harvest-unsupported', { kind: 'harvest', dimension: 'overworld', position: stand })
      type UnsupportedOperation = typeof state.unsupportedOperations extends Ref.Ref<ReadonlyArray<infer Operation>> ? Operation : never
      const unrelated: UnsupportedOperation = {
        _tag: 'Unsupported', action: 'Brewing', requestId: 'unmatched', reason: 'WorldCommitCoordinatorUnavailable',
      }
      const harvest: UnsupportedOperation = {
        _tag: 'Unsupported', action: 'HarvestPotato', requestId: 'harvest-unsupported', reason: 'WorldCommitCoordinatorUnavailable',
      }

      Effect.runSync(harness.runInteractions())
      expect(Effect.runSync(Ref.get(state.unsupportedOperations))).toEqual([
        { _tag: 'Unsupported', action: 'CollectBrewingBottle', requestId: 'brewing-unsupported-1', reason: 'OwnerRegistrationUnavailable' },
      ])
      Effect.runSync(Ref.update(state.unsupportedOperations, (operations) => [...operations, unrelated, harvest]))

      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(harness.context.state.brewingStatus.get()).toBe('Cannot collect brewing item: OwnerRegistrationUnavailable')
      expect(harness.context.services.pendingItemUses.has('brewing-unsupported-1')).toBe(false)
      expect(harness.context.services.pendingItemUses.has('harvest-unsupported')).toBe(true)
      expect(Effect.runSync(Ref.get(state.unsupportedOperations))).toEqual([unrelated, harvest])
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema))).toEqual(storage)
      expect(Effect.runSync(harness.context.services.brewingService.snapshot.pipe(Effect.provideService(WorldCommitCoordinator, harness.coordinator))).bottles[0]?.item).toBe('potion_of_poison')
    })
  })

  it('drains a queued brewing fuel result without consuming storage twice', async () => {
    await withHarness({ selectedItem: 'blaze_powder' }, (harness) => {
      const state = harness.context.h5a.gameplayState
      harness.context.services.pendingItemUses.set('brewing-fuel-1', { kind: 'brewing', action: 'insert', item: 'blaze_powder' })
      Effect.runSync(gameplay.insertBrewingFuel(state, 'brewing-fuel-1'))
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state.inventory.slots[0]?.count).toBe(1)
      expect(harness.context.state.brewingStatus.get()).toBe('closed')

      Effect.runSync(harness.runInteractions())

      expect(Effect.runSync(Ref.get(state.itemUseResults))).toEqual([
        { action: 'InsertBrewingFuel', requestId: 'brewing-fuel-1', success: true, outcome: undefined },
      ])
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state.inventory.slots[0]).toBeUndefined()
      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(harness.context.state.brewingStatus.get()).toBe('Inserted blaze_powder')
      expect(harness.context.services.pendingItemUses.has('brewing-fuel-1')).toBe(false)
      expect(Effect.runSync(Ref.get(state.itemUseResults))).toEqual([])
      expect(harness.playerUiCalls.get()).toBe(1)
      const committedStorage = Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state

      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(harness.context.state.brewingStatus.get()).toBe('Inserted blaze_powder')
      expect(harness.playerUiCalls.get()).toBe(1)
      expect(Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state).toEqual(committedStorage)
    })
  })

  const brewingResults: ReadonlyArray<{
    readonly name: string
    readonly pending: Extract<H5cTickContext['services']['pendingItemUses'] extends Map<string, infer Pending> ? Pending : never, { kind: 'brewing' }>
    readonly result: ItemUseResult
    readonly status: string
  }> = [
    {
      name: 'missing insertion item',
      pending: { kind: 'brewing', action: 'insert', item: 'water_bottle' },
      result: { action: 'InsertBrewingBottle', requestId: 'brewing-1', success: false, failure: 'MissingItem' },
      status: 'Cannot insert item: MissingItem',
    },
    {
      name: 'collected bottle',
      pending: { kind: 'brewing', action: 'collect' },
      result: { action: 'CollectBrewingBottle', requestId: 'brewing-1', success: true, outcome: { _tag: 'Collected', item: 'awkward_potion', count: 1, remainingCount: 0 } },
      status: 'Collected awkward_potion',
    },
    {
      name: 'full collection inventory',
      pending: { kind: 'brewing', action: 'collect' },
      result: { action: 'CollectBrewingBottle', requestId: 'brewing-1', success: false, outcome: { _tag: 'InventoryFull', item: 'awkward_potion', count: 1 } },
      status: 'Inventory is full',
    },
    {
      name: 'empty collection slot',
      pending: { kind: 'brewing', action: 'collect' },
      result: { action: 'CollectBrewingBottle', requestId: 'brewing-1', success: false, outcome: { _tag: 'Empty' } },
      status: 'Cannot collect bottle: Empty',
    },
    {
      name: 'drunk potion',
      pending: { kind: 'brewing', action: 'drink' },
      result: { action: 'DrinkPotion', requestId: 'brewing-1', success: true, outcome: { _tag: 'ConsumedWithoutEffect', item: 'awkward_potion' } },
      status: 'Drank awkward_potion',
    },
    {
      name: 'dead player',
      pending: { kind: 'brewing', action: 'insert', item: 'water_bottle' },
      result: { requestId: 'brewing-1', success: false, outcome: 'PlayerDead' },
      status: 'Cannot insert brewing item: PlayerDead',
    },
  ]

  it.each(brewingResults)('updates brewing status for $name by request id', async ({ pending, result, status }) => {
    await withHarness({}, (harness) => {
      harness.context.services.pendingItemUses.set('brewing-1', pending)
      harness.context.services.pendingItemUses.set('brewing-2', { kind: 'brewing', action: 'insert', item: 'sugar' })
      Effect.runSync(Ref.set(harness.context.h5a.gameplayState.itemUseResults, [result]))

      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(harness.context.state.brewingStatus.get()).toBe(status)
      expect(harness.context.services.pendingItemUses.has('brewing-1')).toBe(false)
      expect(harness.context.services.pendingItemUses.has('brewing-2')).toBe(true)
      expect(Effect.runSync(Ref.get(harness.context.h5a.gameplayState.itemUseResults))).toEqual([])
    })
  })

  it('ignores brewing results without a matching pending request', async () => {
    await withHarness({}, (harness) => {
      harness.context.services.pendingItemUses.set('brewing-1', { kind: 'brewing', action: 'insert', item: 'blaze_powder' })
      Effect.runSync(Ref.set(harness.context.h5a.gameplayState.itemUseResults, [
        { action: 'InsertBrewingFuel', requestId: 'unrelated', success: true, outcome: undefined },
      ]))

      runTickPostFrameGameplay(harness.context, { frame: harness.frame, movement: harness.movement, postFrame: harness.postFrame, nowSecs: MonotonicTimeSecs(2) })

      expect(harness.context.state.brewingStatus.get()).toBe('closed')
      expect(harness.context.services.pendingItemUses.has('brewing-1')).toBe(true)
    })
  })

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

  it('publishes fixed player pose and grounded state', async () => {
    await withHarness({}, (harness) => {
      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.canvasAttributes.get('data-player-feet')).toBe('12.35,64.23,-7.89')
      expect(harness.canvasAttributes.get('data-player-grounded')).toBe('true')
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
      expect(harness.playerUiCalls.get()).toBe(1)
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

  it('records the targeted brewing stand before opening it', async () => {
    const target = {
      position: position(PositionAxis(4), PositionAxis(64), PositionAxis(-6)),
      adjacentPosition: position(PositionAxis(4), PositionAxis(65), PositionAxis(-6)),
      block: Option.getOrThrow(blockIdOf('brewing_stand')),
    }
    await withHarness({ useTriggered: true, targetedBlock: target }, (harness) => {
      runTickPostFrameGameplay(harness.context, {
        frame: harness.frame,
        movement: harness.movement,
        postFrame: harness.postFrame,
        nowSecs: MonotonicTimeSecs(2),
      })

      expect(harness.brewingOpenCalls).toEqual([{ open: true, standAt: { x: 4, y: 64, z: -6 } }])
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

  it('drains block-state rule results every frame and reports only failures', async () => {
    await withHarness({}, (harness) => {
      const state = harness.context.h5a.gameplayState
      const failed: gameplay.BlockStateRuleResult = {
        requestId: 'crop-growth:overworld:1:64:1:1',
        outcome: { _tag: 'Unsupported', operation: 'writeState', position: blockPosition(1, 64, 1) },
      }
      Effect.runSync(Ref.set(state.blockStateRuleResults, [
        { requestId: 'applied', outcome: { _tag: 'Applied', edits: [] } },
        { requestId: 'no-change', outcome: { _tag: 'NoChange', reason: 'mature' } },
        { requestId: 'not-applicable', outcome: { _tag: 'NotApplicable', block: 'stone' } },
        failed,
      ]))
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        runTickPostFrameGameplay(harness.context, {
          frame: harness.frame,
          movement: harness.movement,
          postFrame: harness.postFrame,
          nowSecs: MonotonicTimeSecs(2),
        })

        expect(warning.mock.calls).toStrictEqual([['Unable to apply block-state rule', failed]])
        expect(Effect.runSync(Ref.get(state.blockStateRuleResults))).toStrictEqual([])
      } finally {
        warning.mockRestore()
      }
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
      const context = {
        ...harness.presentationContext,
        services: { ...harness.presentationContext.services, presentWeatherRuntime: () => Effect.fail(rejected.failure) },
      }

      const result = Effect.runSync(Effect.result(runFramePresentation(context, presentationFrame)))

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

describe('frame presentation split from the tick', () => {
  const runTick = (harness: Harness) => runTickPostFrameGameplay(harness.context, {
    frame: harness.frame,
    movement: harness.movement,
    postFrame: harness.postFrame,
    nowSecs: MonotonicTimeSecs(2),
  })
  const simulationSnapshot = (harness: Harness) => ({
    revision: Effect.runSync(harness.coordinator.revision),
    playerOwner: Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema)),
    storageOwner: Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)),
    vitalsOwner: Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_VITALS_OWNER_ID, gameplay.ExperienceOrbVitalsOwnerSnapshotSchema)),
    cropsOwner: Effect.runSync(harness.coordinator.snapshot(gameplay.GAMEPLAY_CROPS_OWNER_ID, CropSnapshotSchema)),
    pose: Effect.runSync(harness.world.player.pose),
    dimension: Effect.runSync(harness.world.player.dimension),
    storage: Effect.runSync(harness.world.inventory.storageSnapshot),
    vitals: Effect.runSync(harness.world.vitals.snapshot),
    entities: Effect.runSync(harness.world.entities.snapshot),
    time: Effect.runSync(harness.context.services.time.snapshot),
    weather: Effect.runSync(harness.context.services.weather.snapshot),
    projectiles: harness.projectileRuntimeState.get(),
    sleep: harness.context.state.sleepRuntimeState.get(),
  })

  it('leaves entity sync, the final player UI, crosshair, captions, weather display and the frame count out of the tick', async () => {
    await withHarness({}, (harness) => {
      runTick(harness)

      expect(harness.syncRenderedEntitiesCalls.get()).toBe(0)
      expect(harness.playerUiCalls.get()).toBe(0)
      expect(harness.crosshairCalls).toEqual([])
      expect(harness.captionRenders.get()).toBe(0)
      expect(harness.weatherPresentations).toEqual([])
      expect(harness.context.state.framesTotal.get()).toBe(41)
      expect(harness.attributes.has('data-frames')).toBe(false)
      expect(harness.fpsValue.textContent).toBe('')
      expect(harness.projectileHud).toEqual({ textContent: '', hidden: true })
      expect(harness.debugOverlayUpdates).toEqual([])
    })
  })

  it('presents each per-frame output exactly once', async () => {
    await withHarness({}, (harness) => {
      Effect.runSync(runFramePresentation(harness.presentationContext, presentationFrame))

      expect(harness.syncRenderedEntitiesCalls.get()).toBe(1)
      expect(harness.playerUiCalls.get()).toBe(1)
      expect(harness.crosshairCalls).toEqual([MonotonicTimeSecs(2)])
      expect(harness.captionRenders.get()).toBe(1)
      expect(harness.weatherPresentations).toEqual([{
        weather: Effect.runSync(harness.context.services.weather.snapshot).weather,
        nowSecs: MonotonicTimeSecs(2),
      }])
      expect(harness.context.state.framesTotal.get()).toBe(42)
      expect(harness.attributes.get('data-frames')).toBe('42')
      expect(harness.fpsValue.textContent).toMatch(/^\d+$/)
      // One arrow is in the player's dimension; the nether one is not counted.
      expect(harness.projectileHud).toEqual({ textContent: 'Arrows 1', hidden: false })
      expect(harness.debugOverlayUpdates).toEqual([0.016])
    })
  })

  it('gives the debug overlay no timing on the first counted frame', async () => {
    await withHarness({}, (harness) => {
      harness.context.state.framesTotal.set(0)

      Effect.runSync(runFramePresentation(harness.presentationContext, presentationFrame))

      expect(harness.debugOverlayUpdates).toEqual([undefined])
    })
  })

  it('does not change simulation state', async () => {
    await withHarness({}, (harness) => {
      runTick(harness)
      const before = simulationSnapshot(harness)

      Effect.runSync(runFramePresentation(harness.presentationContext, presentationFrame))

      expect(simulationSnapshot(harness)).toEqual(before)
    })
  })
})
