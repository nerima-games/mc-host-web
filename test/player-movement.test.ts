import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Ref, Result, Schema } from 'effect'

import { AngleRadians, BlockAxis, blockIdOf, blockPosition, blockTypeOfId, ChunkAxis, chunkCoord, DeltaTimeSecs, itemStack, InterpolationFraction, MonotonicTimeSecs, position, PositionAxis, StackCount, VehicleVelocityComponent } from '@nerima-games/mc-kernel'
import { BlockLength, PLAYER_HALF_HEIGHT, PLAYER_HALF_WIDTH } from '@nerima-games/mc-physics'
import type { InputAction } from '@nerima-games/mc-render'
import { emptyFurnaceState, makeSimFrameState, makeWeatherService, VehicleId, type FurnaceState, type SimPhysicsConfig, type Vehicle } from '@nerima-games/mc-sim'
import { BIOMES, CHUNK_SIZE_XZ, CHUNK_VOLUME, type ChunkSource } from '@nerima-games/mc-worldgen'
import { advanceFishing, cancelFishing, castFishing, enderPearlDisplacement, EnderPearlOutcomeSchema, isDroppedItemBehaviour, makeGameplayFrameState, makeGeneratedWorld, spawnDroppedItems, type FishingSession, type MobBehaviour } from '@nerima-games/mx-gameplay'
import { PlayerId, PlayerName, WorldId } from '@nerima-games/mx-multiplayer'

import { ChunkRenderFailure } from '../apps/web/chunk-streaming'
import { createDroppedItemLifetimeTracker, DROPPED_ITEM_LIFETIME_SECS } from '../apps/web/dropped-item-lifetime'
import { movementInput, runTickPlayerMovement as runTickPlayerMovementEffect } from '../apps/web/tick/player-movement'
import {
  mutableState,
  type H5aFishingWater,
  type H5aLastPlayerMove,
  type H5aMovementContext,
  type H5aMovementFrameInput,
} from '../apps/web/tick/h5a-context'
import {
  advancePlayerSwimmingRuntime,
  initialPlayerSwimmingRuntimeState,
} from '../apps/web/player-swimming-runtime'

const runTickPlayerMovement = (...args: Parameters<typeof runTickPlayerMovementEffect>) => Effect.runSync(runTickPlayerMovementEffect(...args))

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

const makeFrame = (deltaSecs = 0.025): H5aMovementFrameInput => ({
  nowSecs: MonotonicTimeSecs(12),
  deltaSecs: DeltaTimeSecs(deltaSecs),
  dead: false,
  held: () => 0,
})

const makeMultiplayer = (transportState: 'connecting' | 'open' | 'closed') => {
  const transitions: Array<unknown> = []
  const outbound: Array<unknown> = []
  const player = PlayerId.make('alice')
  const name = PlayerName.make('Alice')
  const runtime = {
    query: { url: 'ws://example.test', player, name },
    host: {
      transitionConnection: (event: unknown) => Effect.sync(() => { transitions.push(event) }),
      enqueueOutbound: (message: unknown) => Effect.sync(() => { outbound.push(message) }),
    },
    transport: {
      state: () => transportState,
      isAuthenticated: () => true,
    },
    players: new Map(),
  } as unknown as NonNullable<H5aMovementContext['multiplayer']>
  return { runtime, transitions, outbound, player, name }
}

const makeHarness = async (multiplayer?: H5aMovementContext['multiplayer']) => {
  const world = await Effect.runPromise(makeGeneratedWorld<MobBehaviour>({
    dimension: 'overworld',
    chunkSource: allAirChunkSource,
  }))
  const simState = await Effect.runPromise(makeSimFrameState)
  const gameplayState = await Effect.runPromise(makeGameplayFrameState)
  const weatherService = await Effect.runPromise(makeWeatherService())
  const weather = Effect.runSync(weatherService.snapshot)
  Effect.runSync(Ref.set(simState.isGrounded, true))

  const pose = {
    feetPosition: position(PositionAxis(1.2), PositionAxis(64.3), PositionAxis(-2.1)),
    yawRadians: 0,
    pitchRadians: 0,
  }
  const swimmingState = cell(initialPlayerSwimmingRuntimeState())
  const fishingSession = cell<FishingSession | undefined>(undefined)
  const fishingWater = cell<H5aFishingWater | undefined>(undefined)
  const selectedHotbarIndex = cell(0)
  const multiplayerHandshakeComplete = cell(false)
  const multiplayerClosed = cell(false)
  const lastPlayerMoveSent = cell<H5aLastPlayerMove | undefined>(undefined)
  const lastPlayerMoveSentAt = cell(Number.NEGATIVE_INFINITY)
  const nextItemUseRequestId = cell(0)
  const inventorySlots: Array<Readonly<{ item: string; count: number }> | undefined> = []
  const canvasAttributes = new Map<string, string>()
  const drainOrder: Array<string> = []
  const damageEvents: Array<{ readonly amount: number; readonly cause: 'generic' }> = []
  const failureEvents: Array<{ readonly message: string; readonly error: unknown }> = []
  const moveToCalls: Array<{ readonly x: number; readonly y: number; readonly z: number }> = []
  const fishingResults: Array<string> = []
  const furnaceRequests: Array<{ readonly requestId: string; readonly state: FurnaceState; readonly deltaSecs: number }> = []
  const droppedItemMetadata = new Map<string, unknown>()
  const droppedItemLifetime = createDroppedItemLifetimeTracker()
  const furnaceStates = new Map<string, { readonly dimension: 'overworld'; readonly position: { readonly x: number; readonly y: number; readonly z: number }; readonly state: FurnaceState }>()
  const deferredFurnaceAdvanceSecs = new Map<string, number>()
  const pendingFurnaceAdvances = new Map<string, string>()
  const multiplayerStatus = { textContent: 'idle', hidden: true }
  const simPhysicsConfig: SimPhysicsConfig = {
    resolve: {
      blockPropertiesAt: () => Result.succeed(null),
      environment: { blockAt: () => Result.succeed(null) },
      halfWidth: PLAYER_HALF_WIDTH,
      halfHeight: PLAYER_HALF_HEIGHT,
      stepHeight: BlockLength(0.6),
    },
    walkSpeed: 2,
    jumpSpeed: 1,
  }

  let mountedVehicleId: string | undefined
  let vehicle: Vehicle | undefined
  let frameRunner: H5aMovementContext['runFrame'] = () => Effect.void
  let chunkRenderFaults: H5aMovementContext['drainChunkRenderFaults'] = () => Effect.void
  let dirtyCount = 0
  let presentedSwimmingStateCount = 0
  let pumpedDamageCount = 0

  const context: H5aMovementContext = {
    state: {
      swimmingState: swimmingState.state,
      fishingSession: fishingSession.state,
      fishingWater: fishingWater.state,
      selectedHotbarIndex: selectedHotbarIndex.state,
      multiplayerHandshakeComplete: multiplayerHandshakeComplete.state,
      multiplayerClosed: multiplayerClosed.state,
      lastPlayerMoveSent: lastPlayerMoveSent.state,
      lastPlayerMoveSentAt: lastPlayerMoveSentAt.state,
      nextItemUseRequestId: nextItemUseRequestId.state,
    },
    mountedVehicleId: () => mountedVehicleId,
    vehicleById: (id) => vehicle !== undefined && String(vehicle.id) === id ? vehicle : undefined,
    playerApi: {
      pose: Effect.succeed(pose),
      dimension: Effect.succeed('overworld'),
      moveTo: (position) => Effect.sync(() => { moveToCalls.push(position) }),
    },
    simState,
    currentChunkStore: world.chunkStore,
    blockPosition: (x, y, z) => blockPosition(BlockAxis(x), BlockAxis(y), BlockAxis(z)),
    eyeLevelOffset: 1.62,
    blockTypeOfId,
    advanceSwimming: advancePlayerSwimmingRuntime,
    presentSwimmingState: () => { presentedSwimmingStateCount += 1 },
    simPhysicsConfig,
    sprintSpeedMPerSec: 5.612,
    getPlayerMovementSpeedMultiplier: () => Effect.succeed(1.5),
    gameplayState,
    time: world.time,
    weather: { snapshot: Effect.succeed(weather) },
    syncPortalCandidateSnapshots: () => Effect.void,
    setFishingResult: (result) => fishingResults.push(result),
    getOrCreateDimensionChunkContext: () => ({ chunkStore: world.chunkStore }),
    advanceFishing,
    cancelFishing,
    multiplayer,
    multiplayerStatus,
    pumpPlayerDamage: () => { pumpedDamageCount += 1 },
    furnaceStates,
    deferredFurnaceAdvanceSecs,
    pendingFurnaceAdvances,
    requestFurnaceAdvance: (_state, requestId, state, deltaSecs) => Effect.sync(() => {
      furnaceRequests.push({ requestId, state, deltaSecs })
    }),
    drainMultiplayerInbound: () => drainOrder.push('multiplayer'),
    drainCraftingInbound: () => drainOrder.push('crafting'),
    drainBrewingInbound: () => drainOrder.push('brewing'),
    drainAnvilInbound: () => drainOrder.push('anvil'),
    drainEnchantingInbound: () => drainOrder.push('enchanting'),
    drainPlayerDamageInbound: () => drainOrder.push('player-damage'),
    runFrame: (deltaSecs) => {
      return Effect.flatMap(frameRunner(deltaSecs), () => Effect.void)
    },
    drainChunkRenderFaults: () => chunkRenderFaults(),
    applyPlayerDamage: (damage) => damageEvents.push(damage),
    failBoot: (message, error) => failureEvents.push({ message, error }),
    markSessionDirty: () => { dirtyCount += 1 },
    canvas: { setAttribute: (name, value) => { canvasAttributes.set(name, value) } },
    world: {
      inventory: { storageSnapshot: Effect.succeed({ inventory: { slots: inventorySlots } }) },
      entities: world.entities,
    },
    currentChunkContext: () => ({ dimension: 'overworld' }),
    droppedItemLifetime,
    droppedItemMetadata,
    droppedItemMetadataKey: (dimension, entityId) => `${dimension}:${entityId}`,
    isDroppedItemBehaviour,
  }

  return {
    context,
    world,
    simState,
    pose,
    swimmingState,
    fishingSession,
    fishingWater,
    selectedHotbarIndex,
    multiplayerHandshakeComplete,
    multiplayerClosed,
    lastPlayerMoveSent,
    lastPlayerMoveSentAt,
    nextItemUseRequestId,
    inventorySlots,
    canvasAttributes,
    drainOrder,
    damageEvents,
    failureEvents,
    moveToCalls,
    fishingResults,
    furnaceRequests,
    droppedItemMetadata,
    droppedItemLifetime,
    furnaceStates,
    deferredFurnaceAdvanceSecs,
    pendingFurnaceAdvances,
    multiplayerStatus,
    setMountedVehicleId: (value: string | undefined) => { mountedVehicleId = value },
    setVehicle: (value: Vehicle | undefined) => { vehicle = value },
    setFrameRunner: (value: H5aMovementContext['runFrame']) => { frameRunner = value },
    setChunkRenderFaults: (value: H5aMovementContext['drainChunkRenderFaults']) => { chunkRenderFaults = value },
    dirtyCount: () => dirtyCount,
    presentedSwimmingStateCount: () => presentedSwimmingStateCount,
    pumpedDamageCount: () => pumpedDamageCount,
  }
}

describe('tick player movement input', () => {
  it('keeps forward and strafe axes independent', () => {
    const pressed: Partial<Record<InputAction, number>> = {
      moveForward: 1,
      moveBackward: 0,
      moveRight: 0,
      moveLeft: 1,
    }

    expect(movementInput(false, (action) => pressed[action] ?? 0)).toEqual({ forward: 1, strafe: -1 })
  })

  it('suppresses walking input while mounted', () => {
    expect(movementInput(true, () => 1)).toEqual({ forward: 0, strafe: 0 })
  })
})

describe('tick player movement branches', () => {
  it('propagates an invalid time fraction before running the frame', async () => {
    const harness = await makeHarness()
    let framesRun = 0
    harness.setFrameRunner(() => Effect.sync(() => { framesRun += 1 }))
    const invalidTime = InterpolationFraction.result(6000)
    expect(Result.isFailure(invalidTime)).toBe(true)
    const result = Effect.runSync(Effect.result(runTickPlayerMovementEffect({
      ...harness.context,
      time: { timeOfDay: Effect.fromResult(invalidTime) },
    }, makeFrame())))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result) && Result.isFailure(invalidTime)) {
      expect(result.failure).toBe(invalidTime.failure)
    }
    expect(framesRun).toBe(0)
  })

  it('swims while submerged and applies fixed drowning damage', async () => {
    const harness = await makeHarness()
    const { world, pose, swimmingState, context, simState } = harness
    swimmingState.state.set({
      ...initialPlayerSwimmingRuntimeState(),
      oxygenSecs: 0.5,
      drowningElapsedSecs: 0.75,
    })
    await Effect.runPromise(world.worldgenChunkStore.load(chunkCoord(ChunkAxis(0), ChunkAxis(-1))))
    for (const y of [64, 65]) {
      const position = blockPosition(BlockAxis(1), BlockAxis(y), BlockAxis(-3))
      await Effect.runPromise(world.worldgenChunkStore.setBlock(position, Option.getOrThrow(blockIdOf('water'))))
      await Effect.runPromise(world.chunkStore.setBlock(position, Option.getOrThrow(blockIdOf('water'))))
    }

    runTickPlayerMovement(context, makeFrame(1))

    expect(swimmingState.get()).toMatchObject({
      active: true,
      fullySubmerged: true,
      oxygenSecs: 0,
      drowningElapsedSecs: 0.75,
    })
    expect(Effect.runSync(Ref.get(simState.movementIntent))).toEqual({ forward: 0, strafe: 0 })
    expect(harness.damageEvents).toEqual([{ amount: 2, cause: 'generic' }])
    expect(harness.dirtyCount()).toBe(1)
    expect(harness.presentedSwimmingStateCount()).toBe(1)
    expect(pose.feetPosition).toEqual({ x: 1.2, y: 64.3, z: -2.1 })
  })

  it.each(['swimming', 'mounted'])('preserves a pearl destination committed during a %s frame', async (mode) => {
    const harness = await makeHarness()
    const displacement = enderPearlDisplacement(0, 0, -1, 8)
    expect(displacement).toBeDefined()
    const pearl = Schema.decodeUnknownSync(EnderPearlOutcomeSchema)({ displacement, damage: undefined })
    const destination = position(
      PositionAxis(harness.pose.feetPosition.x + pearl.displacement.x),
      PositionAxis(harness.pose.feetPosition.y + pearl.displacement.y),
      PositionAxis(harness.pose.feetPosition.z + pearl.displacement.z),
    )
    let currentPose = harness.pose
    const overlayMoves: Array<typeof destination> = []
    const context: H5aMovementContext = {
      ...harness.context,
      playerApi: {
        ...harness.context.playerApi,
        pose: Effect.sync(() => currentPose),
        moveTo: (feetPosition) => Effect.sync(() => {
          overlayMoves.push(feetPosition)
          currentPose = { ...currentPose, feetPosition }
        }),
      },
    }
    if (mode === 'swimming') {
      Effect.runSync(harness.world.chunkStore.load(chunkCoord(ChunkAxis(0), ChunkAxis(-1))))
      for (const y of [64, 65]) {
        Effect.runSync(harness.world.chunkStore.setBlock(blockPosition(BlockAxis(1), BlockAxis(y), BlockAxis(-3)), Option.getOrThrow(blockIdOf('water'))))
      }
    } else {
      harness.setMountedVehicleId('v:1')
      harness.setVehicle({
        id: VehicleId('v:1'), type: 'boat', dimension: 'overworld',
        position: position(PositionAxis(4.5), PositionAxis(66), PositionAxis(-3.25)),
        velocity: { x: VehicleVelocityComponent(0), y: VehicleVelocityComponent(0), z: VehicleVelocityComponent(0) },
        yawRadians: AngleRadians(0),
      })
    }
    harness.setFrameRunner(() => Effect.gen(function* () {
      currentPose = { ...currentPose, feetPosition: destination }
      yield* Ref.update(harness.context.gameplayState.enderPearlOutcomes, (outcomes) => [...outcomes, pearl])
    }))

    runTickPlayerMovement(context, makeFrame())

    expect(Effect.runSync(context.playerApi.pose).feetPosition).toEqual(destination)
    expect(overlayMoves).toEqual([])
    expect(Effect.runSync(Ref.get(harness.context.gameplayState.enderPearlOutcomes))).toEqual([pearl])
    if (mode === 'swimming') expect(harness.swimmingState.get().active).toBe(true)
  })

  it.each(['swimming', 'mounted'])('keeps normal %s movement when a pearl outcome is stale', async (mode) => {
    const harness = await makeHarness()
    const displacement = enderPearlDisplacement(0, 0, -1, 8)
    const stale = Schema.decodeUnknownSync(EnderPearlOutcomeSchema)({ displacement, damage: undefined })
    Effect.runSync(Ref.set(harness.context.gameplayState.enderPearlOutcomes, [stale]))
    const vehiclePosition = position(PositionAxis(4.5), PositionAxis(66), PositionAxis(-3.25))
    if (mode === 'swimming') {
      Effect.runSync(harness.world.chunkStore.load(chunkCoord(ChunkAxis(0), ChunkAxis(-1))))
      for (const y of [64, 65]) {
        Effect.runSync(harness.world.chunkStore.setBlock(blockPosition(BlockAxis(1), BlockAxis(y), BlockAxis(-3)), Option.getOrThrow(blockIdOf('water'))))
      }
    } else {
      harness.setMountedVehicleId('v:1')
      harness.setVehicle({
        id: VehicleId('v:1'), type: 'boat', dimension: 'overworld', position: vehiclePosition,
        velocity: { x: VehicleVelocityComponent(0), y: VehicleVelocityComponent(0), z: VehicleVelocityComponent(0) },
        yawRadians: AngleRadians(0),
      })
    }

    runTickPlayerMovement(harness.context, makeFrame())

    expect(harness.moveToCalls).toHaveLength(1)
    if (mode === 'mounted') expect(harness.moveToCalls[0]).toEqual(vehiclePosition)
    expect(Effect.runSync(Ref.get(harness.context.gameplayState.enderPearlOutcomes))).toEqual([stale])
  })

  it('clears a fishing session with the fixed lost-water result', async () => {
    const harness = await makeHarness()
    const cast = castFishing({
      ...Result.getOrThrow(itemStack('fishing_rod', StackCount(1))),
      durability: { current: 64, max: 64 },
    }, { hasWater: true, hasSkyAccess: true, isRaining: false, isOpenWater: true }, {
      wait: 0.25,
      category: 0.5,
      item: 0.75,
    })
    expect(cast._tag).toBe('Cast')
    if (cast._tag !== 'Cast') return
    harness.inventorySlots.push({ item: 'fishing_rod', count: 1 })
    harness.fishingSession.state.set(cast.session)
    harness.fishingWater.state.set({
      dimension: 'overworld',
      position: { x: 8, y: 64, z: 8 },
    })

    runTickPlayerMovement(harness.context, makeFrame(0.25))

    expect(harness.fishingSession.get()).toBeUndefined()
    expect(harness.fishingWater.get()).toBeUndefined()
    expect(harness.fishingResults).toEqual(['lost-water'])
  })

  it('completes the multiplayer handshake and emits the fixed join state', async () => {
    const multiplayer = makeMultiplayer('open')
    const harness = await makeHarness(multiplayer.runtime)

    runTickPlayerMovement(harness.context, makeFrame(0.025))

    const worldId = WorldId.make('overworld')
    expect(multiplayer.transitions).toEqual([{
      _tag: 'HandshakeSucceeded',
      player: multiplayer.player,
      world: worldId,
    }])
    expect(multiplayer.outbound).toEqual([{
      _tag: 'PlayerJoin',
      player: multiplayer.player,
      name: multiplayer.name,
      at: { x: 1.2, y: 64.3, z: -2.1 },
    }])
    expect(harness.multiplayerHandshakeComplete.get()).toBe(true)
    expect(harness.canvasAttributes.get('data-multiplayer-connection')).toBe('connected')
    expect(harness.canvasAttributes.get('data-multiplayer-player-count')).toBe('1')
    expect(harness.multiplayerStatus).toEqual({ textContent: 'Connected as Alice', hidden: false })
    expect(harness.lastPlayerMoveSent.get()).toEqual({
      world: worldId,
      at: { x: 1.2, y: 64.3, z: -2.1 },
      facing: { yawRadians: 0, pitchRadians: 0 },
    })
    expect(harness.lastPlayerMoveSentAt.get()).toBe(12)
    expect(harness.pumpedDamageCount()).toBe(1)
  })

  it('records a closed multiplayer peer and drains inbound work in fixed order', async () => {
    const multiplayer = makeMultiplayer('closed')
    const harness = await makeHarness(multiplayer.runtime)

    runTickPlayerMovement(harness.context, makeFrame())

    expect(multiplayer.transitions).toEqual([{ _tag: 'PeerClosed' }])
    expect(harness.multiplayerClosed.get()).toBe(true)
    expect(harness.canvasAttributes.get('data-multiplayer-connection')).toBe('closed')
    expect(harness.multiplayerStatus).toEqual({ textContent: 'Multiplayer connection closed.', hidden: false })
    expect(harness.drainOrder).toEqual(['multiplayer', 'crafting', 'brewing', 'anvil', 'enchanting', 'player-damage'])
  })

  it('requests furnace progress with deferred time and a stable request id', async () => {
    const harness = await makeHarness()
    const key = 'overworld:0,64,0'
    const state = Result.getOrThrow(emptyFurnaceState())
    harness.furnaceStates.set(key, { dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, state })
    harness.deferredFurnaceAdvanceSecs.set(key, 0.125)

    runTickPlayerMovement(harness.context, makeFrame(0.375))

    expect(harness.furnaceRequests).toEqual([{ requestId: 'furnace-advance-1', state, deltaSecs: 0.5 }])
    expect(harness.nextItemUseRequestId.get()).toBe(1)
    expect(harness.pendingFurnaceAdvances.get('furnace-advance-1')).toBe(key)
    expect(harness.deferredFurnaceAdvanceSecs.has(key)).toBe(false)
  })

  it('reports a frame defect and stops before returning a movement result', async () => {
    const harness = await makeHarness()
    harness.setFrameRunner(() => Effect.die(new Error('fixture frame defect')))

    const result = runTickPlayerMovement(harness.context, makeFrame())

    expect(result).toBeUndefined()
    expect(harness.failureEvents).toHaveLength(1)
    expect(harness.failureEvents[0]?.message).toBe('a frame stage defected')
    expect(harness.failureEvents[0]?.error).toMatchObject({ reasons: [{ _tag: 'Die', defect: { message: 'fixture frame defect' } }] })
  })

  it('returns chunk render faults drained after the frame as a typed failure', async () => {
    const harness = await makeHarness()
    const events: Array<string> = []
    const failure = new ChunkRenderFailure({
      faults: [{
        dimension: 'overworld',
        fault: {
          _tag: 'ChunkRenderFault',
          chunk: chunkCoord(ChunkAxis(0), ChunkAxis(0)),
          error: { _tag: 'ChunkMeshGeometryInputFailure', field: 'fluids' },
          occurrences: 1,
        },
      }],
    })
    harness.setFrameRunner(() => Effect.sync(() => { events.push('frame') }))
    harness.setChunkRenderFaults(() => Effect.andThen(Effect.sync(() => { events.push('drain') }), Effect.fail(failure)))

    const result = Effect.runSync(Effect.result(runTickPlayerMovementEffect(harness.context, makeFrame())))

    expect(result).toEqual(Result.fail(failure))
    expect(events).toEqual(['frame', 'drain'])
    expect(harness.failureEvents).toEqual([])
  })

  it('repositions a mounted player from the vehicle pose after the frame', async () => {
    const harness = await makeHarness()
    const vehicleId = VehicleId('v:1')
    const before: Vehicle = {
      id: vehicleId,
      type: 'boat',
      dimension: 'overworld',
      position: position(PositionAxis(0), PositionAxis(64), PositionAxis(0)),
      velocity: { x: VehicleVelocityComponent(0), y: VehicleVelocityComponent(0), z: VehicleVelocityComponent(0) },
      yawRadians: AngleRadians(0),
    }
    const after: Vehicle = {
      ...before,
      position: position(PositionAxis(4.5), PositionAxis(66), PositionAxis(-3.25)),
    }
    harness.setMountedVehicleId('v:1')
    harness.setVehicle(before)
    harness.setFrameRunner(() => {
      harness.setVehicle(after)
      return Effect.void
    })

    runTickPlayerMovement(harness.context, makeFrame())

    expect(harness.moveToCalls).toEqual([{ x: 4.5, y: 66, z: -3.25 }])
    expect(Effect.runSync(Ref.get(harness.simState.movementIntent))).toEqual({ forward: 0, strafe: 0 })
    expect(Effect.runSync(Ref.get(harness.simState.jumpIntent))).toBe(false)
    expect(Option.isNone(Effect.runSync(Ref.get(harness.simState.physicsConfig)))).toBe(true)
  })

  it('despawns a dropped item at its fixed lifetime and removes metadata', async () => {
    const harness = await makeHarness()
    const spawned = await Effect.runPromise(spawnDroppedItems(harness.world.entities, [{
      item: 'stone',
      count: 1,
      at: harness.pose.feetPosition,
    }]))
    const entity = spawned[0]
    expect(entity).toBeDefined()
    if (entity === undefined) return
    const entityId = String(entity.id)
    const metadataKey = `overworld:${entityId}`
    harness.droppedItemMetadata.set(metadataKey, { customName: 'test item' })
    harness.droppedItemLifetime.restore('overworld', [{ entityId, elapsedSecs: 0 }])

    runTickPlayerMovement(harness.context, makeFrame(DROPPED_ITEM_LIFETIME_SECS))

    expect(Effect.runSync(harness.world.entities.entities)).toEqual([])
    expect(harness.droppedItemMetadata.has(metadataKey)).toBe(false)
    expect(harness.dirtyCount()).toBe(1)
    expect(harness.droppedItemLifetime.elapsed('overworld', entityId)).toBe(0)
  })
})
