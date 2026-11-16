import { AngleRadians, AttackRangeDistance, BlockAxis, blockIdOf, blockPosition, blockPositionKeyOf, blockTypeOfId, ChunkAxis, chunkCoord, DeltaTimeSecs, EntityHealthPoints, EntityId, FixedDurationSecs, MonotonicTimeSecs, position, PositionAxis, WorldId } from '@nerima-games/mc-kernel'
import { makeChunkStoreLightColor, makeChunkStoreMesher, type InputAction, type InputSnapshot } from '@nerima-games/mc-render'
import {
  makeSimFrameState,
  makeWorldCommitCoordinator,
  makeWeatherService,
  maxStackCountForItem,
  witherSkullProjectile,
  itemStack,
  EntityKind,
  type ItemStack,
} from '@nerima-games/mc-sim'
import {
  CHUNK_SIZE_XZ,
  CHUNK_VOLUME,
  type ChunkSource,
} from '@nerima-games/mc-worldgen'
import {
  type EnvironmentalContactDamageState,
  type MobBehaviour,
} from '@nerima-games/mx-gameplay'
import * as gameplay from '@nerima-games/mx-gameplay'
import { Effect, Option, Ref, Result } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { BlocksPerSecond } from '@nerima-games/mc-physics'
import { makeBudgetedDirtySource } from '../apps/web/chunk-sync-budget'
import { trackChunkLightColor } from '../apps/web/render-lighting'
import { isDroppedItemPickupEligible } from '../apps/web/dropped-item-pickup'
import { droppedItemMetadataFromBehaviour } from '../apps/web/dropped-item-metadata'
import { IDLE_BOW_USE, advanceBowUse } from '../apps/web/bow-use'
import { advanceEyeOfEnderRuntime, initialEyeOfEnderRuntimeState } from '../apps/web/eye-of-ender-runtime'
import { advanceFootstepRuntime, initialFootstepRuntimeState } from '../apps/web/footstep-runtime'
import { EMPTY_BLOCK_BREAK_COUNTERS, observeBlockBreakCompletion, recordBlockBreakRequest } from '../apps/web/mining-completion'
import { projectEnchantedItem } from '../apps/web/enchanted-item-state'
import {
  advanceProjectileRuntime,
  initialProjectileRuntimeState,
  launchRuntimeProjectile,
  recoverProjectile,
} from '../apps/web/projectile-runtime'
import { makeSurvivalHungerCoordinator } from '../apps/web/survival-hunger-runtime'
import { initialPlayerSwimmingRuntimeState } from '../apps/web/player-swimming-runtime'
import { type DimensionChunkContext } from '../apps/web/chunk-streaming'
import { mutableState, type H5aFrameInputResult, type H5aMovementResult } from '../apps/web/tick/h5a-context'
import { type H5bPostFrameContext } from '../apps/web/tick/h5b-context'
import { runTickPostFrame as runTickPostFrameEffect } from '../apps/web/tick/post-frame'
import {
  advanceWitherRuntime,
  damageRuntimeWither,
  initialWitherRuntimeState,
} from '@nerima-games/mc-server/shared'

type LegacyGameplayItemType = Exclude<ItemStack['item'], 'arrow' | 'bow'>

const runTickPostFrame = (...args: Parameters<typeof runTickPostFrameEffect>) => Effect.runSync(runTickPostFrameEffect(...args))

const allAirChunkSource: ChunkSource = (coord) => Effect.succeed({
  coord,
  blocks: new Uint16Array(CHUNK_VOLUME).fill(Option.getOrThrow(blockIdOf('air'))),
  biomes: Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, () => 'PLAINS'),
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

const isLegacyGameplayItemType = (
  item: ItemStack['item'],
): item is LegacyGameplayItemType => item !== 'arrow' && item !== 'bow'

const isSwordItem = (
  item: ItemStack['item'],
): item is 'wooden_sword' | 'stone_sword' | 'iron_sword' | 'diamond_sword' =>
  item === 'wooden_sword' || item === 'stone_sword' || item === 'iron_sword' || item === 'diamond_sword'

const makeContext = async (primaryAttackConsumed: ReturnType<typeof cell<boolean>>) => {
  const world = await Effect.runPromise(gameplay.makeGeneratedWorld<MobBehaviour>({
    dimension: 'overworld',
    chunkSource: allAirChunkSource,
  }))
  const owners = await Effect.runPromise(Effect.fromResult(gameplay.gameplayOwnerRegistrations({
    playerPose: Effect.runSync(world.player.pose),
    dimension: 'overworld',
    playerStorage: Effect.runSync(world.inventory.storageSnapshot),
    vitals: Effect.runSync(world.vitals.snapshot),
    entities: Effect.runSync(world.entities.snapshot),
  })))
  const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
    world: WorldId('tick-post-frame-test'),
    owners,
    dimensions: ['overworld', 'nether', 'end'],
    chunkStores: { forDimension: () => world.chunkStore },
  }))
  const targeting = {
    coordinator,
    playerOwnerId: gameplay.GAMEPLAY_PLAYER_OWNER_ID,
    entitiesOwnerId: gameplay.GAMEPLAY_ENTITIES_OWNER_ID,
  }
  const gameplayState = await Effect.runPromise(gameplay.makeGameplayFrameState)
  const simState = await Effect.runPromise(makeSimFrameState)
  const weatherService = await Effect.runPromise(makeWeatherService())
  const weatherBeforeFrame = Effect.runSync(weatherService.snapshot)
  const playerApi: typeof world.player = {
    ...world.player,
    dimension: Effect.succeed('nether'),
  }
  const lighting = trackChunkLightColor((chunk, quads) =>
    makeChunkStoreLightColor(world.worldgenChunkStore, chunk, quads),
  )
  const currentChunkContext: DimensionChunkContext = {
    dimension: 'overworld',
    chunkStore: world.chunkStore,
    worldgenChunkStore: world.worldgenChunkStore,
    dirtyChunks: makeBudgetedDirtySource(
      { drain: Effect.succeed({ changed: [], removed: [] }) },
      4,
    ),
    queueLoadedChunk: () => undefined,
    streamLoaded: new Set(),
    meshChunkFromStore: makeChunkStoreMesher(world.worldgenChunkStore),
    colorForChunk: lighting.colorForChunk,
    lightingSnapshot: lighting.snapshot,
  }
  const environmentalContactDamageState = cell<EnvironmentalContactDamageState>({ lastDamageElapsedSecs: 3 })
  const miningProgress = cell<gameplay.MiningProgressState | null>(null)
  const environmentalContactDamageInitial = gameplay.INITIAL_ENVIRONMENTAL_CONTACT_DAMAGE_STATE
  const bowUseState = cell(IDLE_BOW_USE)
  const droppedItemMetadata = new Map<string, { readonly customName?: string; readonly enchantedItem?: gameplay.EnchantedItem }>()
  const customNames = new Map<string, string>()
  const enchantedItems = new Map<string, gameplay.EnchantedItem>()
  const inventoryOpenEvents: Array<boolean> = []
  const canvasAttributes = new Map<string, string>()
  let sessionDirtyCount = 0

  const h5a = {
    world,
    targeting,
    playerApi,
    simState,
    currentChunkContext: () => currentChunkContext,
    currentChunkStore: world.chunkStore,
    blockPosition: (x, y, z) => blockPosition(BlockAxis(x), BlockAxis(y), BlockAxis(z)),
    blockTypeOfId,
    gameplayState,
    multiplayer: undefined,
    isCreativeMode: false,
    survivalHunger: makeSurvivalHungerCoordinator({
      snapshot: world.vitals.snapshot,
      restore: world.vitals.restore,
    }),
    playerIsDead: () => false,
    setInventoryOpen: (open) => { inventoryOpenEvents.push(open) },
    markSessionDirty: () => { sessionDirtyCount += 1 },
    syncTouchControls: () => undefined,
    droppedItemMetadata,
    droppedItemMetadataKey: (dimension, entityId) => `${dimension}:${entityId}`,
    isDroppedItemBehaviour: gameplay.isDroppedItemBehaviour,
    canvas: { setAttribute: (name, value) => { canvasAttributes.set(name, value) } },
    resetPrimaryAttackGesture: () => {
      primaryAttackConsumed.state.set(false)
      miningProgress.state.set(null)
    },
    eyeLevelOffset: 1.62,
    furnaceStates: new Map(),
    pendingFurnaceAdvances: new Map(),
    state: {
      simulationElapsedSecs: cell(4).state,
      redstoneDirty: cell(false).state,
      inventoryOpen: cell(false).state,
      selectedHotbarIndex: cell(0).state,
      multiplayerHandshakeComplete: cell(false).state,
      nextItemUseRequestId: cell(0).state,
      swimmingState: cell(initialPlayerSwimmingRuntimeState()).state,
    },
  } satisfies H5bPostFrameContext['h5a']

  const context: H5bPostFrameContext = {
    h5a,
    state: {
      blockBreakCounters: cell(EMPTY_BLOCK_BREAK_COUNTERS).state,
      environmentalContactDamageState: environmentalContactDamageState.state,
      witherRuntimeState: cell(initialWitherRuntimeState()).state,
      projectileRuntimeState: cell(launchRuntimeProjectile(initialProjectileRuntimeState(), {
        dimension: 'overworld',
        position: position(PositionAxis(0), PositionAxis(65), PositionAxis(0)),
        yawRadians: AngleRadians(0),
        pitchRadians: AngleRadians(0),
        speed: BlocksPerSecond(10),
        damage: 5,
        knockback: 1,
        shooterId: EntityId('player'),
      })).state,
      eyeOfEnderRuntimeState: cell(initialEyeOfEnderRuntimeState()).state,
      bowUseState: bowUseState.state,
      footstepRuntimeState: cell(initialFootstepRuntimeState()).state,
      nextWitherCommand: cell(0).state,
      nextEnderDragonCommand: cell(0).state,
      nextMeleeAttackRequestId: cell(0).state,
      miningProgress: miningProgress.state,
      primaryAttackGestureConsumed: primaryAttackConsumed.state,
      activeChestId: cell<string | undefined>(undefined).state,
      activeFurnaceKey: cell<string | undefined>(undefined).state,
      tradeStatus: cell('closed').state,
    },
    inventoryMode: () => 'player',
    activeVillagerId: () => undefined,
    sendVitalsCommand: () => undefined,
    multiplayerEntities: new Map(),
    dimensionContexts: new Map(),
    pendingBlockBreakConfirmations: [],
    pendingMiningToolDamage: [],
    customNames,
    enchantedItems,
    containerMetadataKey: (containerId, slot) => `${containerId}:${String(slot)}`,
    deleteContainerMetadata: () => undefined,
    containerIdAt: () => '',
    furnaceKeyOf: () => '',
    isDroppedItemPickupEligible,
    droppedItemMetadataFromBehaviour,
    maxStackCountForItem,
    itemStack,
    observeBlockBreakCompletion,
    recordBlockBreakRequest,
    drainVillagerTradeResults: () => Effect.succeed([]),
    drainPlayerDamages: gameplay.drainPlayerDamages,
    drainPlayerHeals: gameplay.drainPlayerHeals,
    villagerTradeStatus: () => 'closed',
    renderPlayerUi: () => undefined,
    renderTradeUi: () => undefined,
    enqueueMultiplayerPlayerMove: () => undefined,
    sendEntityCommand: () => undefined,
    applyPortalTravels: () => Effect.void,
    applyPlayerDamage: () => undefined,
    settleMeleeAttackResults: () => undefined,
    alignActiveDimension: () => true,
    resetSimState: () => {
      environmentalContactDamageState.state.set(environmentalContactDamageInitial)
      bowUseState.state.set(IDLE_BOW_USE)
    },
    resolveFallDamage: gameplay.resolveFallDamage,
    isStandingOnCell: () => false,
    pressurePlateOccupancy: new Map(),
    environmentalContactsForPose: () => [],
    isGameplayBlockSolid: () => Result.succeed(false),
    applyWorldExplosion: () => Result.succeed(undefined),
    resetBowUse: () => bowUseState.state.set(IDLE_BOW_USE),
    projectileHud: { textContent: '', hidden: true },
    projectedInventoryEnchantedItem: () => null,
    durabilityWearWithEnchantments: gameplay.durabilityWearWithEnchantments,
    witherRevision: () => 0,
    enderDragonRevision: () => 0,
    endDragonPosition: () => ({ x: 0, y: 64, z: 0 }),
    inventoryMeleeDamage: () => 1,
    requestIdFor: (scope, sequence) => `${scope}:${String(sequence)}`,
    canFireBow: gameplay.canFireBow,
    bowCharge: gameplay.bowCharge,
    bowDamage: gameplay.bowDamage,
    bowDamageWithEnchantments: gameplay.bowDamageWithEnchantments,
    advanceFootstepRuntime,
    audio: { play: () => undefined },
    advanceWitherRuntime,
    damageRuntimeWither,
    advanceProjectileRuntime,
    initialProjectileRuntimeState,
    launchRuntimeProjectile,
    recoverProjectile,
    advanceEyeOfEnderRuntime,
    initialEyeOfEnderRuntimeState,
    advanceBowUse,
    resolveBowHits: gameplay.resolveBowHits,
    resolveTargetedPrimaryAttack: gameplay.resolveTargetedPrimaryAttack,
    advanceMiningProgress: gameplay.advanceMiningProgress,
    isLegacyGameplayItemType,
    isSwordItem,
    pendingMeleeAttacks: new Map(),
    projectEnchantedItem,
    miningLootContextForItem: gameplay.miningLootContextForItem,
    requestMeleeAttack: gameplay.requestMeleeAttack,
    requestBlockBreak: gameplay.requestBlockBreak,
    requestPotatoHarvest: gameplay.requestPotatoHarvest,
    pendingItemUses: new Map(),
    spawnDroppedItems: gameplay.spawnDroppedItems,
  }

  const poseBeforeFrame = Effect.runSync(world.player.pose)
  const input: H5aFrameInputResult = {
    nowSecs: MonotonicTimeSecs(1),
    raw: 0.05,
    deltaSecs: DeltaTimeSecs(0.05),
    walk: inputSnapshot,
    dead: false,
    held: (_action: InputAction) => 0,
    attackTriggered: false,
    attackHeld: false,
    canUse: false,
    useTriggered: false,
    useHeld: false,
    looked: false,
  }
  const movement: H5aMovementResult = {
    poseBeforeFrame,
    groundedBeforeFrame: false,
    dimensionBeforeFrame: 'overworld',
    weatherBeforeFrame,
    sprinting: false,
  }

  return {
    context,
    input,
    movement,
    environmentalContactDamageState,
    primaryAttackConsumed,
    bowUseState,
    customNames,
    enchantedItems,
    droppedItemMetadata,
    inventoryOpenEvents,
    canvasAttributes,
    sessionDirtyCount: () => sessionDirtyCount,
  }
}

const inOverworld = (context: H5bPostFrameContext): H5bPostFrameContext => ({
  ...context,
  h5a: {
    ...context.h5a,
    playerApi: {
      ...context.h5a.playerApi,
      dimension: Effect.succeed('overworld'),
    },
  },
})

const inOverworldMovement = (movement: H5aMovementResult): H5aMovementResult => ({
  ...movement,
  dimensionBeforeFrame: 'overworld',
})

describe('tick post-frame processing', () => {
  it('keeps dimension-change resets when post-frame locals are committed', async () => {
    const primaryAttackConsumed = cell(true)
    const harness = await makeContext(primaryAttackConsumed)

    const result = runTickPostFrame(harness.context, {
      frame: harness.input,
      movement: harness.movement,
      framesTotal: 5,
    })

    expect(result.dimensionChanged).toBe(true)
    expect(harness.primaryAttackConsumed.get()).toBe(false)
    expect(harness.environmentalContactDamageState.get()).toEqual({ lastDamageElapsedSecs: undefined })
  })

  it('clears projectile output when a frame ends with the player dead', async () => {
    const harness = await makeContext(cell(false))
    const context: H5bPostFrameContext = {
      ...harness.context,
      h5a: {
        ...harness.context.h5a,
        playerApi: {
          ...harness.context.h5a.playerApi,
          dimension: Effect.succeed('overworld'),
        },
        playerIsDead: () => true,
      },
      projectileHud: { textContent: 'Arrows 1', hidden: false },
    }

    expect(context.state.projectileRuntimeState.get().projectiles).toHaveLength(1)
    const result = runTickPostFrame(context, {
      frame: { ...harness.input, dead: false },
      movement: { ...harness.movement, dimensionBeforeFrame: 'overworld' },
      framesTotal: 5,
    })

    expect(result.dimensionChanged).toBe(false)
    expect(result.deadAfterFrame).toBe(true)
    expect(context.projectileHud.textContent).toBe('Arrows 0')
    expect(context.projectileHud.hidden).toBe(true)
  })

  it('picks up a nearby local drop and transfers its metadata to the inventory slot', async () => {
    const harness = await makeContext(cell(false))
    const world = harness.context.h5a.world
    const position = Effect.runSync(harness.context.h5a.playerApi.pose).feetPosition
    const inventoryBefore = Effect.runSync(world.inventory.storageSnapshot).inventory.slots
    const appleCountBefore = inventoryBefore.reduce(
      (count, stack) => count + (stack?.item === 'apple' ? stack.count : 0),
      0,
    )
    const spawned = Effect.runSync(gameplay.spawnDroppedItems(world.entities, [{
      item: 'apple',
      count: 2,
      at: position,
    }]))
    const dropped = spawned[0]
    if (dropped === undefined) throw new Error('expected one dropped item')
    const metadataKey = `overworld:${String(dropped.id)}`
    harness.droppedItemMetadata.set(metadataKey, { customName: 'Field apples' })

    const result = runTickPostFrame(inOverworld(harness.context), {
      frame: harness.input,
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })

    const inventoryAfter = Effect.runSync(world.inventory.storageSnapshot).inventory.slots
    const appleCountAfter = inventoryAfter.reduce(
      (count, stack) => count + (stack?.item === 'apple' ? stack.count : 0),
      0,
    )
    const appleSlot = inventoryAfter.findIndex((stack) => stack?.item === 'apple')
    const remainingDropIds = Effect.runSync(world.entities.entities)
      .filter((entity) => String(entity.id) === String(dropped.id))
      .map((entity) => String(entity.id))

    expect(result.deadAfterFrame).toBe(false)
    expect(appleCountAfter).toBe(appleCountBefore + 2)
    expect(harness.customNames.get(String(appleSlot))).toBe('Field apples')
    expect(harness.droppedItemMetadata.has(metadataKey)).toBe(false)
    expect(remainingDropIds).toEqual([])
    expect(harness.sessionDirtyCount()).toBe(1)
  })

  it('reconciles a completed trade for the active villager', async () => {
    const harness = await makeContext(cell(false))
    const tradeResult = {
      _tag: 'Traded' as const,
      requestId: 'trade-7',
      villagerId: 'villager-1',
      offerId: 'bread-for-emeralds',
    }
    let renderedTradeUi = 0
    const base = inOverworld(harness.context)
    const context: H5bPostFrameContext = {
      ...base,
      activeVillagerId: () => 'villager-1',
      drainVillagerTradeResults: () => Effect.succeed([tradeResult]),
      villagerTradeStatus: () => 'Trade complete',
      renderTradeUi: () => { renderedTradeUi += 1 },
    }

    runTickPostFrame(context, {
      frame: harness.input,
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })

    expect(context.state.tradeStatus.get()).toBe('Trade complete')
    expect(renderedTradeUi).toBe(1)
    expect(harness.sessionDirtyCount()).toBe(1)
  })

  it('applies portal completion before aligning the destination dimension', async () => {
    const harness = await makeContext(cell(true))
    const base = inOverworld(harness.context)
    let dimension: 'overworld' | 'nether' = 'overworld'
    let portalTravelCount = 0
    const alignedDimensions: Array<string> = []
    const context: H5bPostFrameContext = {
      ...base,
      h5a: {
        ...base.h5a,
        playerApi: {
          ...base.h5a.playerApi,
          dimension: Effect.sync(() => dimension),
        },
      },
      applyPortalTravels: () => Effect.sync(() => {
        portalTravelCount += 1
        dimension = 'nether'
      }),
      alignActiveDimension: (nextDimension) => {
        alignedDimensions.push(nextDimension)
        return true
      },
    }

    const result = runTickPostFrame(context, {
      frame: harness.input,
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })

    expect(portalTravelCount).toBe(1)
    expect(result.dimensionChanged).toBe(true)
    expect(result.dimensionAfterFrame).toBe('nether')
    expect(alignedDimensions).toEqual(['nether'])
    expect(harness.primaryAttackConsumed.get()).toBe(false)
  })

  it('applies queued player damage and closes inventory on death', async () => {
    const harness = await makeContext(cell(false))
    const world = harness.context.h5a.world
    const startingVitals = Effect.runSync(world.vitals.snapshot)
    await Effect.runPromise(world.vitals.restore({ ...startingVitals, healthPoints: EntityHealthPoints(5), lastDamageCause: undefined }))
    const damageEvent = {
      _tag: 'FireContact' as const,
      at: position(PositionAxis(0.5), PositionAxis(64), PositionAxis(0.5)),
      damage: { amount: 6, cause: 'in_fire' as const },
    }
    Effect.runSync(Ref.set(harness.context.h5a.gameplayState.playerDamages, [damageEvent]))

    const applied: Array<{ readonly amount: number; readonly cause: string; readonly minimumHealthPoints: number }> = []
    const base = inOverworld(harness.context)
    const context: H5bPostFrameContext = {
      ...base,
      h5a: {
        ...base.h5a,
        playerIsDead: () => Effect.runSync(world.vitals.view).healthPoints === 0,
      },
      applyPlayerDamage: (damage, minimumHealthPoints = EntityHealthPoints(0)) => {
        applied.push({ ...damage, minimumHealthPoints })
        Effect.runSync(world.vitals.damage(damage))
      },
    }

    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { pointerLockElement: null } })
    let result: ReturnType<typeof runTickPostFrame> | undefined
    try {
      result = runTickPostFrame(context, {
        frame: harness.input,
        movement: inOverworldMovement(harness.movement),
        framesTotal: 5,
      })
    } finally {
      if (priorDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
      else Object.defineProperty(globalThis, 'document', priorDocument)
    }

    expect(applied).toEqual([{ amount: 6, cause: 'in_fire', minimumHealthPoints: 0 }])
    expect(Effect.runSync(world.vitals.snapshot)).toMatchObject({ healthPoints: 0, lastDamageCause: 'in_fire' })
    expect(harness.inventoryOpenEvents).toEqual([false])
    expect(harness.sessionDirtyCount()).toBe(1)
    expect(result?.deadAfterFrame).toBe(true)
  })

  it('reports a wither explosion failure and stops later explosions', async () => {
    const harness = await makeContext(cell(false))
    const failure = { _tag: 'ExplosionValidationFailure', path: 'power', reason: 'fixture rejection' } as const
    const advanced = initialWitherRuntimeState()
    const explosion = { position: { x: 0, y: 64, z: 0 }, power: 5, destroysResistantBlocks: false }
    let calls = 0
    const context: H5bPostFrameContext = {
      ...inOverworld(harness.context),
      advanceWitherRuntime: () => ({ state: advanced, meleeDamage: 0, explosions: [explosion, explosion] }),
      applyWorldExplosion: () => { calls += 1; return Result.fail(failure) },
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const result = Effect.runSync(Effect.result(runTickPostFrameEffect(context, {
        frame: harness.input,
        movement: inOverworldMovement(harness.movement),
        framesTotal: 5,
      })))

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(failure)
      expect(warning).toHaveBeenCalledWith('Unable to apply wither explosion', failure)
      expect(calls).toBe(1)
      expect(context.state.witherRuntimeState.get()).toBe(advanced)
    } finally {
      warning.mockRestore()
    }
  })

  it('persists advanced projectile state when targeting fails with a typed error', async () => {
    const harness = await makeContext(cell(false))
    const advanced = initialProjectileRuntimeState()
    const failure = new RangeError('fixture targeting failure')
    const context: H5bPostFrameContext = {
      ...inOverworld(harness.context),
      advanceProjectileRuntime: () => ({ state: advanced, impacts: [] }),
      resolveTargetedPrimaryAttack: () => Effect.fail(failure),
    }
    expect(context.state.projectileRuntimeState.get()).not.toBe(advanced)

    const result = Effect.runSync(Effect.result(runTickPostFrameEffect(context, {
      frame: { ...harness.input, attackTriggered: true, attackHeld: true },
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBe(failure)
    expect(context.state.projectileRuntimeState.get()).toBe(advanced)
  })

  it('fails the frame with a wither solidity read failure before committing the advance', async () => {
    const harness = await makeContext(cell(false))
    const failure = { _tag: 'EntityWorldWindowUnavailable', cell: { x: BlockAxis(0), y: BlockAxis(64), z: BlockAxis(0) } } as const
    const before = harness.context.state.witherRuntimeState.get()
    const advanced = initialWitherRuntimeState()
    const skullOrigin = position(PositionAxis(0), PositionAxis(70), PositionAxis(0))
    const skull = {
      id: 'skull-fixture',
      ownerId: 'wither-fixture',
      dimension: 'overworld',
      descriptor: witherSkullProjectile(skullOrigin, position(PositionAxis(0), PositionAxis(64), PositionAxis(0)), 'normal'),
      position: skullOrigin,
      ageSecs: 0,
    }
    const answers: boolean[] = []
    const context: H5bPostFrameContext = {
      ...inOverworld(harness.context),
      isGameplayBlockSolid: () => Result.fail(failure),
      advanceWitherRuntime: (_state, _dimension, _target, _deltaSecs, skullHitsWorld) => {
        answers.push(skullHitsWorld(skull, { x: 0.5, y: 64.5, z: 0.5 }))
        return { state: advanced, meleeDamage: 0, explosions: [] }
      },
    }

    const result = Effect.runSync(Effect.result(runTickPostFrameEffect(context, {
      frame: harness.input,
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBe(failure)
    expect(answers).toEqual([true])
    expect(context.state.witherRuntimeState.get()).toBe(before)
  })

  it('fails the frame with a projectile solidity read failure before committing the advance', async () => {
    const harness = await makeContext(cell(false))
    const failure = { _tag: 'EntityWorldWindowUnavailable', cell: { x: BlockAxis(0), y: BlockAxis(64), z: BlockAxis(0) } } as const
    const before = harness.context.state.projectileRuntimeState.get()
    const advanced = initialProjectileRuntimeState()
    const context: H5bPostFrameContext = {
      ...inOverworld(harness.context),
      isGameplayBlockSolid: () => Result.fail(failure),
      advanceProjectileRuntime: (_state, world) => {
        const point = position(PositionAxis(0.5), PositionAxis(64.5), PositionAxis(0.5))
        expect(world.blockBounds(point, point)).toHaveLength(1)
        return { state: advanced, impacts: [] }
      },
    }

    const result = Effect.runSync(Effect.result(runTickPostFrameEffect(context, {
      frame: harness.input,
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBe(failure)
    expect(context.state.projectileRuntimeState.get()).toBe(before)
  })

  it('preserves the bow reset when the reset callback mutates state and throws', async () => {
    const harness = await makeContext(cell(false))
    harness.bowUseState.state.set({ _tag: 'Drawing', bowSlotIndex: 0, chargeSecs: 0.4 })
    const context: H5bPostFrameContext = {
      ...harness.context,
      resetBowUse: () => {
        harness.context.resetBowUse()
        throw new Error('bow reset failed')
      },
    }

    expect(() => runTickPostFrame(context, {
      frame: harness.input,
      movement: harness.movement,
      framesTotal: 5,
    })).toThrow('bow reset failed')
    expect(harness.bowUseState.get()).toEqual(IDLE_BOW_USE)
  })

  it('preserves environmental reset state when resetSimState mutates and throws', async () => {
    const harness = await makeContext(cell(false))
    const context: H5bPostFrameContext = {
      ...harness.context,
      resetSimState: (physicsEnabled) => {
        harness.context.resetSimState(physicsEnabled)
        throw new Error('simulation reset failed')
      },
    }

    expect(() => runTickPostFrame(context, {
      frame: harness.input,
      movement: harness.movement,
      framesTotal: 5,
    })).toThrow('simulation reset failed')
    expect(harness.environmentalContactDamageState.get()).toEqual({ lastDamageElapsedSecs: undefined })
  })

  it('releases a quarter-second bow charge with five damage and consumes one arrow', async () => {
    const harness = await makeContext(cell(false))
    const { world } = harness.context.h5a
    Effect.runSync(world.inventory.add('bow', 1))
    Effect.runSync(world.inventory.add('arrow', 1))
    harness.context.state.projectileRuntimeState.set(initialProjectileRuntimeState())
    const context = inOverworld(harness.context)

    runTickPostFrame(context, {
      frame: { ...harness.input, raw: 0.25, useTriggered: true, useHeld: true },
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })
    const result = runTickPostFrame(context, {
      frame: { ...harness.input, raw: 0.05, useTriggered: false, useHeld: false },
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })

    const projectile = context.state.projectileRuntimeState.get().projectiles[0]
    const slots = Effect.runSync(world.inventory.storageSnapshot).inventory.slots
    const arrowCount = slots.reduce((count, slot) => count + (slot?.item === 'arrow' ? slot.count : 0), 0)
    expect(result.bowAdvance.release).toEqual({ bowSlotIndex: 0, chargeSecs: 0.25 })
    expect(projectile).toMatchObject({
      id: 'arrow-1',
      dimension: 'overworld',
      damage: 5,
      knockback: 0.5125,
    })
    expect(arrowCount).toBe(0)
  })

  it('queues a fixed melee request and remembers the selected sword for settlement', async () => {
    const harness = await makeContext(cell(false))
    const world = harness.context.h5a.world
    Effect.runSync(world.inventory.add('wooden_sword', 1))
    const target = Effect.runSync(world.entities.spawn({
      kind: EntityKind('zombie'),
      feetPosition: position(PositionAxis(0.5), PositionAxis(64), PositionAxis(-2)),
      healthPoints: EntityHealthPoints(10),
      behaviour: gameplay.hostileMobSnapshot(undefined),
    }))
    const request = {
      origin: position(PositionAxis(0.5), PositionAxis(65.62), PositionAxis(0.5)),
      direction: position(PositionAxis(0), PositionAxis(0), PositionAxis(-1)),
      reach: AttackRangeDistance(3),
      damage: 4,
    }
    const context: H5bPostFrameContext = {
      ...inOverworld(harness.context),
      resolveTargetedPrimaryAttack: () => Effect.succeed({
        _tag: 'Melee',
        target: { id: target.id, distance: 2 },
        request,
      }),
    }

    runTickPostFrame(context, {
      frame: { ...harness.input, attackTriggered: true, attackHeld: true },
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })

    expect(Effect.runSync(Ref.get(harness.context.h5a.gameplayState.pendingMeleeAttacks))).toEqual([
      { ...request, requestId: 'melee-attack-1' },
    ])
    expect(context.pendingMeleeAttacks.get('melee-attack-1')).toEqual({ slotIndex: 0, item: 'wooden_sword' })
    expect(context.state.primaryAttackGestureConsumed.get()).toBe(true)
  })

  it('queues a crop harvest before changing its block', async () => {
    const harness = await makeContext(cell(false))
    const world = harness.context.h5a.world
    const at = blockPosition(BlockAxis(0), BlockAxis(64), BlockAxis(1))
    Effect.runSync(world.chunkStore.load(chunkCoord(ChunkAxis(0), ChunkAxis(0))))
    Effect.runSync(world.chunkStore.setBlock(at, Option.getOrThrow(blockIdOf('potato_crop'))))
    const harvestRequests = new Map<string, Parameters<H5bPostFrameContext['pendingItemUses']['set']>[1]>()
    const context: H5bPostFrameContext = {
      ...inOverworld(harness.context),
      h5a: { ...inOverworld(harness.context).h5a, isCreativeMode: true },
      resolveTargetedPrimaryAttack: () => Effect.succeed({
        _tag: 'Block',
        target: { position: position(PositionAxis(at.x), PositionAxis(at.y), PositionAxis(at.z)), adjacentPosition: position(PositionAxis(at.x), PositionAxis(at.y), PositionAxis(at.z)), distance: 1 },
      }),
      pendingItemUses: harvestRequests,
      requestPotatoHarvest: (state, requestId, position) => gameplay.requestPotatoHarvest(state, requestId, position, 0.25),
    }
    harness.canvasAttributes.set('data-breaks-completed', '0')

    runTickPostFrame(context, {
      frame: { ...harness.input, attackTriggered: true, attackHeld: true },
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })

    expect(Effect.runSync(world.chunkStore.getBlock(at))).toMatchObject({ _tag: 'Block', block: Option.getOrThrow(blockIdOf('potato_crop')) })
    expect(harvestRequests.get('item-use-1')).toMatchObject({ kind: 'harvest', dimension: 'overworld', position: at })
    expect(context.state.blockBreakCounters.get().completed).toBe(0)
    expect(context.pendingBlockBreakConfirmations).toHaveLength(1)
    expect(Effect.runSync(Ref.get(context.h5a.gameplayState.pendingItemUses))).toEqual([
      expect.objectContaining({ action: 'HarvestPotato', requestId: 'item-use-1', positionKey: blockPositionKeyOf(at), roll: 0.25 }),
    ])
    expect(harness.canvasAttributes.get('data-breaks-completed')).toBe('0')
  })

  it('retains a retried harvest confirmation until the committed block is air', async () => {
    const harness = await makeContext(cell(false))
    const world = harness.context.h5a.world
    const at = blockPosition(BlockAxis(0), BlockAxis(64), BlockAxis(1))
    const crop = Option.getOrThrow(blockIdOf('potato_crop'))
    Effect.runSync(world.chunkStore.load(chunkCoord(ChunkAxis(0), ChunkAxis(0))))
    Effect.runSync(world.chunkStore.setBlock(at, crop))
    const context: H5bPostFrameContext = {
      ...inOverworld(harness.context),
      dimensionContexts: new Map([['overworld', harness.context.h5a.currentChunkContext()]]),
    }
    context.pendingBlockBreakConfirmations.push({ dimension: 'overworld', position: at, blockId: crop })
    Effect.runSync(gameplay.requestPotatoHarvest(context.h5a.gameplayState, 'retry-harvest', at, 0.25))
    const frame = { frame: harness.input, movement: inOverworldMovement(harness.movement), framesTotal: 5 }

    runTickPostFrame(context, frame)
    runTickPostFrame(context, frame)

    expect(context.pendingBlockBreakConfirmations).toHaveLength(1)
    expect(context.state.blockBreakCounters.get().completed).toBe(0)
    expect(Effect.runSync(world.chunkStore.getBlock(at))).toMatchObject({ _tag: 'Block', block: crop })
    Effect.runSync(Ref.set(context.h5a.gameplayState.pendingItemUses, []))
    Effect.runSync(world.chunkStore.setBlock(at, Option.getOrThrow(blockIdOf('air'))))

    runTickPostFrame(context, frame)
    runTickPostFrame(context, frame)

    expect(context.pendingBlockBreakConfirmations).toEqual([])
    expect(context.state.blockBreakCounters.get().completed).toBe(1)
    expect(harness.canvasAttributes.get('data-breaks-completed')).toBe('1')
  })

  it('records and completes a fixed creative block-break request', async () => {
    const harness = await makeContext(cell(false))
    const world = harness.context.h5a.world
    const position = blockPosition(BlockAxis(0), BlockAxis(64), BlockAxis(1))
    await Effect.runPromise(world.worldgenChunkStore.load(chunkCoord(ChunkAxis(0), ChunkAxis(0))))
    await Effect.runPromise(world.chunkStore.load(chunkCoord(ChunkAxis(0), ChunkAxis(0))))
    await Effect.runPromise(world.worldgenChunkStore.setBlock(position, Option.getOrThrow(blockIdOf('stone'))))
    await Effect.runPromise(world.chunkStore.setBlock(position, Option.getOrThrow(blockIdOf('stone'))))
    const currentChunkContext = harness.context.h5a.currentChunkContext()
    const context: H5bPostFrameContext = {
      ...inOverworld(harness.context),
      h5a: { ...inOverworld(harness.context).h5a, isCreativeMode: true },
      dimensionContexts: new Map([['overworld', currentChunkContext] as const]),
      resolveTargetedPrimaryAttack: () => Effect.succeed({
        _tag: 'Block',
        target: {
          position: { x: PositionAxis(position.x), y: PositionAxis(position.y), z: PositionAxis(position.z) },
          adjacentPosition: { x: PositionAxis(position.x), y: PositionAxis(position.y), z: PositionAxis(position.z) },
          distance: 1,
        },
      }),
    }

    runTickPostFrame(context, {
      frame: { ...harness.input, attackTriggered: true, attackHeld: true },
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })
    expect(Effect.runSync(Ref.get(harness.context.h5a.gameplayState.pendingBreaks))).toEqual([
      blockPositionKeyOf(position),
    ])
    expect(harness.canvasAttributes.get('data-breaks-requested')).toBe('1')
    expect(context.pendingBlockBreakConfirmations).toHaveLength(1)
    expect(context.h5a.state.redstoneDirty.get()).toBe(true)

    await Effect.runPromise(world.worldgenChunkStore.setBlock(position, Option.getOrThrow(blockIdOf('air'))))
    await Effect.runPromise(world.chunkStore.setBlock(position, Option.getOrThrow(blockIdOf('air'))))
    runTickPostFrame(context, {
      frame: { ...harness.input, attackTriggered: false, attackHeld: false },
      movement: inOverworldMovement(harness.movement),
      framesTotal: 6,
    })
    expect(harness.canvasAttributes.get('data-breaks-completed')).toBe('1')
  })

  it('applies a projectile impact with fixed entity damage and knockback', async () => {
    const harness = await makeContext(cell(false))
    const world = harness.context.h5a.world
    const target = Effect.runSync(world.entities.spawn({
      kind: EntityKind('zombie'),
      feetPosition: position(PositionAxis(2), PositionAxis(64), PositionAxis(-2)),
      healthPoints: EntityHealthPoints(10),
      behaviour: gameplay.hostileMobSnapshot(undefined),
    }))
    harness.context.state.projectileRuntimeState.set(initialProjectileRuntimeState())
    const context: H5bPostFrameContext = {
      ...inOverworld(harness.context),
      advanceProjectileRuntime: (state) => ({
        state,
        impacts: [{
          projectileId: 'arrow-fixture',
          hit: {
            kind: 'entity',
            entityId: target.id,
            point: position(PositionAxis(2), PositionAxis(65), PositionAxis(-2)),
            normal: position(PositionAxis(0), PositionAxis(0), PositionAxis(1)),
            flightTimeSeconds: FixedDurationSecs(0.05),
          },
          damage: 4,
          knockback: 2,
          velocity: { x: 3, y: 0, z: 4 },
        }],
      }),
    }

    runTickPostFrame(context, {
      frame: harness.input,
      movement: inOverworldMovement(harness.movement),
      framesTotal: 5,
    })

    const targetAfter = Effect.runSync(world.entities.find(target.id))
    expect(targetAfter?.healthPoints).toBe(6)
    expect(targetAfter?.feetPosition).toMatchObject({ x: 3.2, y: 64 })
    expect(targetAfter?.feetPosition.z).toBeCloseTo(-0.4, 12)
    expect(harness.sessionDirtyCount()).toBe(1)
  })
})
