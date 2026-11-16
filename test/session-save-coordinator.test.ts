import { assert, describe, expect, it, vi } from 'vitest'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import {
  makeInMemoryStorage,
  SaveFormatName,
  SaveFormatVersion,
  SaveKey,
  sealSaveEnvelope,
  StorageError,
  StorageOperation,
  StoragePort,
  failingStorageLayer,
} from '@nerima-games/mc-save'
import {
  ChunkAxis,
  CHUNK_SIZE_XZ,
  chunkCoord,
  EntityHealthPoints,
  EntityKind,
  position,
  PositionAxis,
  WorldIdSchema,
} from '@nerima-games/mc-kernel'
import {
  CropSnapshotSchema,
  emptyBrewingState,
  EntitySerial,
  makeWorldCommitCoordinator,
  NETHER_WART_MATURITY_SECS,
  PlayerStorageSnapshotSchema,
} from '@nerima-games/mc-sim'
import {
  ChunkCapacity,
  CHUNK_VOLUME,
  generatedChunkSource,
  makeChunkStore,
  NoiseSeed,
  type ChunkWithBlockStates,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import {
  GAMEPLAY_CROPS_OWNER_ID,
  GAMEPLAY_ENTITIES_OWNER_ID,
  GAMEPLAY_PLAYER_OWNER_ID,
  GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  GAMEPLAY_VITALS_OWNER_ID,
  gameplayOwnerRegistrations,
  emptyStatusEffectState,
  hostileMobSnapshot,
  makeGeneratedWorld,
  mintEntityId,
  type MobBehaviour,
  type MobEntity,
} from '@nerima-games/mx-gameplay'

import {
  EMPTY_END_STATE,
  EMPTY_ENTITY_ROSTERS,
  EMPTY_VILLAGER_STATE,
  SESSION_FORMAT,
  SESSION_FORMAT_NAME,
  SESSION_FORMAT_VERSION,
  SessionIncompatibleError,
  saveSession,
  toStoredSessionState,
  type DimensionChunk,
  type SessionHead,
  type SessionState,
} from '../apps/web/session-persistence'
import { createDroppedItemLifetimeTracker } from '../apps/web/dropped-item-lifetime'
import { makeOwnerBackedHost } from '../apps/web/owner-backed-services'
import { initializeSessionWorld } from '../apps/web/session-world'
import { gameplayOwnerInitialState } from '../apps/web/session-restoration'
import { makeHostWorldWrite } from '../apps/web/world-write-port'

import {
  createSessionSaveCoordinator,
  sessionSaveFailureMessage,
  SessionSnapshotUnstableError,
  snapshotOwnedSessionState,
  type OwnedSessionState,
  type SessionSavePublication,
} from '../apps/web/session-save-coordinator'

const chunk = (cx: number, cz: number, marker: number): ChunkWithBlockStates => ({
  coord: chunkCoord(ChunkAxis(cx), ChunkAxis(cz)),
  blocks: new Uint16Array(CHUNK_VOLUME).fill(marker),
  blockStates: new Uint32Array(CHUNK_VOLUME),
  biomes: Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, () => 'PLAINS'),
})

const dimensionChunk = (
  dimension: Dimension,
  cx: number,
  cz: number,
  marker: number,
): DimensionChunk => ({ dimension, chunk: chunk(cx, cz, marker) })

const markerOf = (
  publication: SessionSavePublication<number>,
  dimension: Dimension,
  cx: number,
  cz: number,
): number =>
  publication.chunks.find(
    (candidate) =>
      candidate.dimension === dimension &&
      candidate.chunk.coord.cx === cx &&
      candidate.chunk.coord.cz === cz,
  )!.chunk.blocks[0]!

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('session save coordinator', () => {
  it('retains chunks after an aborted publication and drains the queued save independently', async () => {
    const publications: Array<SessionSavePublication<number>> = []
    const firstPublish = deferred<void>()
    const secondPublish = deferred<void>()
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    const failures: unknown[] = []
    const publishedGenerations: number[] = []
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [dimensionChunk('overworld', 0, 0, 1)],
      snapshotResidents: async () => [],
      currentGeneration: () => 4,
      snapshotState: async () => 1,
      publish: (publication) => {
        publications.push(publication)
        if (publications.length === 1) {
          firstStarted.resolve()
          return firstPublish.promise
        }
        secondStarted.resolve()
        return secondPublish.promise
      },
      onFailure: (error) => { failures.push(error) },
      onPublished: (generation) => { publishedGenerations.push(generation) },
    })
    coordinator.retainChunk(dimensionChunk('overworld', 3, 2, 8))
    const first = coordinator.requestSave()
    await firstStarted.promise
    let queuedSettled = false
    const queued = coordinator.requestSave().then(() => { queuedSettled = true })
    const abort = new DOMException('Publication interrupted', 'AbortError')
    const rejected = expect(first).rejects.toBe(abort)
    firstPublish.reject(abort)
    await rejected
    await secondStarted.promise

    expect(failures).toEqual([abort])
    expect(coordinator.knownChunkCount()).toBe(1)
    expect(coordinator.retainedChunkCount()).toBe(1)
    expect(queuedSettled).toBe(false)
    expect(publishedGenerations).toEqual([])
    expect(publications).toHaveLength(2)
    expect(markerOf(publications[1]!, 'overworld', 3, 2)).toBe(8)

    secondPublish.resolve()
    await queued
    expect(queuedSettled).toBe(true)
    expect(coordinator.retainedChunkCount()).toBe(0)
    expect(coordinator.knownChunkCount()).toBe(2)
    expect(publishedGenerations).toEqual([4])
  })

  it('settles requests made during a save from the following publication batch', async () => {
    const saves = [deferred<void>(), deferred<void>()]
    const publications: Array<SessionSavePublication<number>> = []
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [],
      snapshotResidents: async () => [],
      currentGeneration: () => 0,
      snapshotState: async () => publications.length,
      publish: (publication) => {
        publications.push(publication)
        return saves[publications.length - 1]!.promise
      },
    })

    let firstSettled = false
    let secondSettled = false
    const first = coordinator.requestSave().then(() => { firstSettled = true })
    await Promise.resolve()
    const second = coordinator.requestSave().then(() => { secondSettled = true })
    saves[0]!.resolve()
    await first

    expect(firstSettled).toBe(true)
    // The state snapshot is asynchronous, so the next batch publishes a few
    // promise turns after the first settles.
    await vi.waitFor(() => { expect(publications).toHaveLength(2) })
    expect(secondSettled).toBe(false)

    saves[1]!.resolve()
    await second
    expect(secondSettled).toBe(true)
  })

  it('keeps known and retained chunks after a failed publication', async () => {
    const publications: Array<SessionSavePublication<number>> = []
    let shouldFail = true
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [dimensionChunk('overworld', 0, 0, 1)],
      snapshotResidents: async () => [],
      currentGeneration: () => 0,
      snapshotState: async () => 1,
      publish: async (publication) => {
        publications.push(publication)
        if (shouldFail) throw new Error('storage unavailable')
      },
    })
    coordinator.retainChunk(dimensionChunk('overworld', 4, -3, 2))

    await expect(coordinator.requestSave()).rejects.toThrow('storage unavailable')
    expect(coordinator.knownChunkCount()).toBe(1)
    expect(coordinator.retainedChunkCount()).toBe(1)

    shouldFail = false
    await coordinator.requestSave()
    expect(publications[1]!.chunks).toHaveLength(2)
    expect(markerOf(publications[1]!, 'overworld', 0, 0)).toBe(1)
    expect(markerOf(publications[1]!, 'overworld', 4, -3)).toBe(2)
  })

  it('does not clear a retained chunk replaced while its older version saves', async () => {
    const firstSave = deferred<void>()
    const publications: Array<SessionSavePublication<number>> = []
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [],
      snapshotResidents: async () => [],
      currentGeneration: () => 0,
      snapshotState: async () => 1,
      publish: (publication) => {
        publications.push(publication)
        return publications.length === 1 ? firstSave.promise : Promise.resolve()
      },
    })
    coordinator.retainChunk(dimensionChunk('overworld', 7, 2, 3))
    const first = coordinator.requestSave()
    await vi.waitFor(() => { expect(publications).toHaveLength(1) })
    coordinator.retainChunk(dimensionChunk('overworld', 7, 2, 9))
    firstSave.resolve()
    await first

    expect(coordinator.retainedChunkCount()).toBe(1)
    await coordinator.requestSave()
    expect(markerOf(publications[1]!, 'overworld', 7, 2)).toBe(9)
    expect(coordinator.retainedChunkCount()).toBe(0)
  })

  it('retries instead of publishing a mixed cut when mutation occurs during resident snapshot', async () => {
    const firstResidents = deferred<ReadonlyArray<DimensionChunk>>()
    const publications: Array<SessionSavePublication<number>> = []
    let state = 1
    let residentMarker = 1
    let snapshotCount = 0
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [],
      snapshotResidents: () => {
        snapshotCount += 1
        return snapshotCount === 1
          ? firstResidents.promise
          : Promise.resolve([dimensionChunk('overworld', 0, 0, residentMarker)])
      },
      currentGeneration: () => state,
      snapshotState: async () => state,
      publish: async (publication) => { publications.push(publication) },
    })

    const save = coordinator.requestSave()
    await Promise.resolve()
    state = 2
    residentMarker = 2
    coordinator.retainChunk(dimensionChunk('overworld', 1, 0, 2))
    firstResidents.resolve([dimensionChunk('overworld', 0, 0, 1)])
    await save

    expect(snapshotCount).toBe(2)
    expect(publications).toHaveLength(1)
    expect(publications[0]!.state).toBe(2)
    expect(markerOf(publications[0]!, 'overworld', 0, 0)).toBe(2)
    expect(markerOf(publications[0]!, 'overworld', 1, 0)).toBe(2)
  })

  it('retries when only state changes during resident snapshot', async () => {
    const firstResidents = deferred<ReadonlyArray<DimensionChunk>>()
    const publications: Array<SessionSavePublication<number>> = []
    const publishedGenerations: number[] = []
    let state = 1
    let generation = 1
    let snapshotCount = 0
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [],
      snapshotResidents: () => {
        snapshotCount += 1
        return snapshotCount === 1 ? firstResidents.promise : Promise.resolve([])
      },
      currentGeneration: () => generation,
      snapshotState: async () => state,
      publish: async (publication) => { publications.push(publication) },
      onPublished: (publishedGeneration) => { publishedGenerations.push(publishedGeneration) },
    })

    const save = coordinator.requestSave()
    await Promise.resolve()
    state = 2
    generation += 1
    firstResidents.resolve([])
    await save

    expect(snapshotCount).toBe(2)
    expect(publications).toEqual([{ state: 2, chunks: [] }])
    expect(publishedGenerations).toEqual([2])
  })

  it('rejects after bounded snapshot retries and allows a later save', async () => {
    const publications: Array<SessionSavePublication<number>> = []
    let generation = 0
    let keepMutating = true
    let snapshotCount = 0
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [],
      snapshotResidents: async () => {
        snapshotCount += 1
        if (keepMutating) generation += 1
        return []
      },
      currentGeneration: () => generation,
      snapshotState: async () => generation,
      publish: async (publication) => { publications.push(publication) },
    })

    const rejection: unknown = await coordinator.requestSave().catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(SessionSnapshotUnstableError)
    expect(rejection).toMatchObject({ _tag: 'SessionSnapshotUnstableError', attempts: 8 })
    expect(snapshotCount).toBe(8)
    expect(publications).toHaveLength(0)

    keepMutating = false
    await coordinator.requestSave()

    expect(snapshotCount).toBe(9)
    expect(publications).toEqual([{ state: 8, chunks: [] }])
  })

  it('publishes the validated state without snapshotting it again', async () => {
    const publications: Array<SessionSavePublication<number>> = []
    let stateSnapshotCount = 0
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [],
      snapshotResidents: async () => [],
      currentGeneration: () => 4,
      snapshotState: async () => ++stateSnapshotCount,
      publish: async (publication) => { publications.push(publication) },
    })

    await coordinator.requestSave()

    expect(stateSnapshotCount).toBe(1)
    expect(publications).toEqual([{ state: 1, chunks: [] }])
  })

  it('carries an unloaded far chunk into the next save', async () => {
    const publications: Array<SessionSavePublication<number>> = []
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [],
      snapshotResidents: async () => [],
      currentGeneration: () => 0,
      snapshotState: async () => 1,
      publish: async (publication) => { publications.push(publication) },
    })
    coordinator.retainChunk(dimensionChunk('overworld', 120, -80, 6))

    await coordinator.requestSave()

    expect(markerOf(publications[0]!, 'overworld', 120, -80)).toBe(6)
  })

  it('merges known, retained, then resident chunks with resident priority', async () => {
    let publication: SessionSavePublication<number> | undefined
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [dimensionChunk('overworld', 1, 1, 1)],
      snapshotResidents: async () => [
        dimensionChunk('overworld', 1, 1, 8),
        dimensionChunk('overworld', 2, 2, 7),
      ],
      currentGeneration: () => 0,
      snapshotState: async () => 1,
      publish: async (saved) => { publication = saved },
    })
    coordinator.retainChunk(dimensionChunk('overworld', 1, 1, 4))

    await coordinator.requestSave()

    expect(markerOf(publication!, 'overworld', 1, 1)).toBe(8)
    expect(markerOf(publication!, 'overworld', 2, 2)).toBe(7)
  })

  it('retains equal coordinates independently across dimensions', async () => {
    let publication: SessionSavePublication<number> | undefined
    const coordinator = createSessionSaveCoordinator({
      initialKnownChunks: [dimensionChunk('overworld', 3, -4, 2)],
      snapshotResidents: async () => [dimensionChunk('nether', 3, -4, 8)],
      currentGeneration: () => 0,
      snapshotState: async () => 1,
      publish: async (saved) => { publication = saved },
    })

    await coordinator.requestSave()

    expect(publication!.chunks).toHaveLength(2)
    expect(markerOf(publication!, 'overworld', 3, -4)).toBe(2)
    expect(markerOf(publication!, 'nether', 3, -4)).toBe(8)
  })
})

describe('owner-backed save state', () => {
  const ownerIds = {
    player: GAMEPLAY_PLAYER_OWNER_ID,
    playerStorage: GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
    vitals: GAMEPLAY_VITALS_OWNER_ID,
    entities: GAMEPLAY_ENTITIES_OWNER_ID,
  }
  const zombieAt = (serial: number, dimension: Dimension): MobEntity => ({
    id: mintEntityId(EntityKind('zombie'), serial),
    kind: EntityKind('zombie'),
    feetPosition: position(PositionAxis(serial), PositionAxis(65), PositionAxis(0)),
    healthPoints: EntityHealthPoints(20),
    behaviour: hostileMobSnapshot(undefined),
    dimension,
  })

  it('round-trips growing and mature crops across dimensions through owner saves and the session schema', async () => {
    const generated = await Effect.runPromise(makeGeneratedWorld<MobBehaviour>({ dimension: 'overworld' }))
    const loaded: SessionState = {
      seed: 1,
      dimension: 'overworld',
      player: await Effect.runPromise(generated.player.pose),
      storage: await Effect.runPromise(generated.inventory.storageSnapshot),
      containerStorage: await Effect.runPromise(generated.inventory.containerStorageSnapshot),
      vitals: await Effect.runPromise(generated.vitals.snapshot),
      time: { ticks: 0, dayLengthTicks: 24_000 },
      weather: { weather: 'clear', remainingSecs: 120 },
      redstone: { levers: [] },
      furnaces: [],
      portals: [],
      crops: await Effect.runPromise(Schema.decodeUnknownEffect(CropSnapshotSchema)({
        crops: [
          { dimension: 'overworld', position: { x: 1, y: 65, z: 2 }, crop: 'potato_crop', growthSecs: 120 },
          { dimension: 'nether', position: { x: -3, y: 40, z: 4 }, crop: 'nether_wart_crop', growthSecs: NETHER_WART_MATURITY_SECS },
        ],
      })),
      entities: EMPTY_ENTITY_ROSTERS,
      villagers: EMPTY_VILLAGER_STATE,
      brewing: Result.getOrThrow(emptyBrewingState()),
      statusEffects: emptyStatusEffectState(),
      end: EMPTY_END_STATE,
    }
    const generatedState = {
      pose: await Effect.runPromise(generated.player.pose),
      dimension: await Effect.runPromise(generated.player.dimension),
      storage: await Effect.runPromise(generated.inventory.storageSnapshot),
      vitals: await Effect.runPromise(generated.vitals.snapshot),
    }
    const roster = { entities: [], nextSerial: EntitySerial(0) }
    const makeRestoredCoordinator = (state: SessionState) => Effect.gen(function* () {
      const initial = yield* Effect.fromResult(gameplayOwnerInitialState(state, generatedState, roster))
      const owners = yield* Effect.fromResult(gameplayOwnerRegistrations(initial))
      return yield* makeWorldCommitCoordinator({
        world: yield* Schema.decodeEffect(WorldIdSchema)('crop-roundtrip'),
        owners,
      })
    })
    const coordinator = await Effect.runPromise(makeRestoredCoordinator(loaded))
    const publication: Array<SessionSavePublication<SessionState>> = []
    const saves = createSessionSaveCoordinator<SessionState>({
      initialKnownChunks: [],
      snapshotResidents: async () => [],
      currentGeneration: () => 0,
      snapshotState: async () => {
        const owned = await Effect.runPromise(
          snapshotOwnedSessionState(coordinator, ownerIds, () => EMPTY_ENTITY_ROSTERS),
        )
        expect(owned.crops).toEqual(loaded.crops)
        return { ...loaded, ...owned }
      },
      publish: async (value) => { publication.push(value) },
    })
    await saves.requestSave()
    expect(publication).toHaveLength(1)
    const saved = publication[0]
    assert.isDefined(saved)
    expect(saved.state.crops).toEqual(loaded.crops)
    const head: SessionHead = {
      sessionId: 'crop-roundtrip',
      revision: 'crop-roundtrip-revision',
      metadata: { name: 'Crop roundtrip', mode: 'survival' },
      state: saved.state,
      chunks: [],
    }
    const encoded = await Effect.runPromise(Schema.encodeEffect(SESSION_FORMAT.schema)(head))
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(SESSION_FORMAT.schema)(encoded))
    expect(SESSION_FORMAT_VERSION).toBe(18)
    expect(decoded.state.crops).toEqual(loaded.crops)
    const restored = await Effect.runPromise(makeRestoredCoordinator(decoded.state))
    expect((await Effect.runPromise(restored.snapshot(GAMEPLAY_CROPS_OWNER_ID, CropSnapshotSchema))).state)
      .toEqual(loaded.crops)
  })

  it.each(['missing', 'invalid'] as const)('rejects a save when the crop owner is %s without publishing a fallback', async (kind) => {
    const registrations = gameplayOwnerRegistrations()
    const owners = kind === 'missing'
      ? registrations.filter(({ ownerId }) => ownerId !== GAMEPLAY_CROPS_OWNER_ID)
      : registrations.map((registration) => registration.ownerId === GAMEPLAY_CROPS_OWNER_ID
          ? { ...registration, schema: Schema.Unknown, initialState: { crops: 'invalid' } }
          : registration)
    const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
      world: await Effect.runPromise(Schema.decodeEffect(WorldIdSchema)('crop-save-failure')),
      owners,
    }))
    const snapshot = snapshotOwnedSessionState(coordinator, ownerIds, () => EMPTY_ENTITY_ROSTERS)
    const result = await Effect.runPromise(Effect.result(snapshot))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe(kind === 'missing' ? 'ReplicatedOwnerUnknown' : 'SchemaError')
    }
    const publish = vi.fn(async () => undefined)
    const onFailure = vi.fn()
    const saves = createSessionSaveCoordinator({
      initialKnownChunks: [],
      snapshotResidents: async () => [],
      currentGeneration: () => 0,
      snapshotState: () => Effect.runPromise(snapshot),
      publish,
      onFailure,
    })
    await expect(saves.requestSave()).rejects.toThrow()
    expect(publish).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledTimes(1)
  })

  it('publishes what the owners hold after view writes, with entities split per dimension', async () => {
    const generated = await Effect.runPromise(makeGeneratedWorld<MobBehaviour>({ dimension: 'overworld' }))
    const owners = Result.getOrThrow(gameplayOwnerRegistrations({
      playerPose: await Effect.runPromise(generated.player.pose),
      dimension: 'overworld',
      entities: { entities: [zombieAt(0, 'overworld'), zombieAt(1, 'nether')], nextSerial: EntitySerial(2) },
    }))
    const chunkStore = await Effect.runPromise(makeChunkStore(generatedChunkSource(NoiseSeed(1)), ChunkCapacity(4)))
    const { coordinator } = await Effect.runPromise(Effect.flatMap(
      Schema.decodeEffect(WorldIdSchema)('session-save-coordinator-test'),
      (world) => makeHostWorldWrite({ world, owners, chunkStores: { forDimension: () => chunkStore } }),
    ))
    const host = await Effect.runPromise(makeOwnerBackedHost({ coordinator, world: generated, ownerIds }))
    const sessionWorld = Result.getOrThrow(await initializeSessionWorld({
      loadedSession: Option.none(),
      initialDimension: 'overworld',
      worldSeed: 1,
      loadSavedChunks: async () => ({ chunks: [] }),
      makeWorld: async () => ({}),
      restoreEntities: () => undefined,
      snapshotEntities: () => ({ entities: [], nextSerial: EntitySerial(0) }),
      droppedItemLifetime: createDroppedItemLifetimeTracker(),
      droppedItemMetadata: new Map(),
      droppedItemMetadataKey: (dimension, entityId) => `${dimension}:${entityId}`,
      droppedItemMetadataFromBehaviour: () => ({}),
    }))

    const destination = position(PositionAxis(8.5), PositionAxis(72), PositionAxis(-1.5))
    await Effect.runPromise(host.views.player.moveTo(destination))
    await Effect.runPromise(host.views.inventory.add('stone', 5))
    const vitals = await Effect.runPromise(host.views.vitals.snapshot)
    await Effect.runPromise(host.views.vitals.restore({ ...vitals, healthPoints: EntityHealthPoints(9) }))
    const spawned = await Effect.runPromise(host.views.entities.spawn({
      kind: EntityKind('zombie'),
      feetPosition: position(PositionAxis(4), PositionAxis(65), PositionAxis(4)),
      healthPoints: EntityHealthPoints(20),
      behaviour: hostileMobSnapshot(undefined),
    }))

    const published: Array<SessionSavePublication<OwnedSessionState>> = []
    const saves = createSessionSaveCoordinator<OwnedSessionState>({
      initialKnownChunks: [],
      snapshotResidents: async () => [],
      currentGeneration: () => 0,
      snapshotState: () => Effect.runPromise(
        snapshotOwnedSessionState(coordinator, ownerIds, sessionWorld.snapshotEntityRosters),
      ),
      publish: async (publication) => { published.push(publication) },
    })
    await saves.requestSave()

    const state = published[0]?.state
    expect(state?.dimension).toBe('overworld')
    expect(state?.player).toEqual({ feetPosition: { x: 8.5, y: 72, z: -1.5 }, yawRadians: 0, pitchRadians: 0 })
    expect(state?.storage).toEqual(
      (await Effect.runPromise(coordinator.snapshot(GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema))).state,
    )
    expect(state?.storage.inventory.slots.find((slot) => slot?.item === 'stone')?.count).toBe(5)
    expect(state?.vitals.healthPoints).toBe(9)
    const idsOf = (dimension: Dimension) => state?.entities[dimension].entities.map(({ id }) => id)
    expect(idsOf('overworld')).toEqual([zombieAt(0, 'overworld').id, spawned.id])
    expect(idsOf('nether')).toEqual([zombieAt(1, 'nether').id])
    expect(idsOf('end')).toEqual([])
    expect(spawned.id).toBe(mintEntityId(EntityKind('zombie'), 2))
    const dimensions: ReadonlyArray<Dimension> = ['overworld', 'nether', 'end']
    for (const dimension of dimensions) {
      expect(state?.entities[dimension].nextSerial).toBe(3)
    }
  })
})

describe('session save failure messages', () => {
  const generatedSessionState = async (): Promise<SessionState> => {
    const generated = await Effect.runPromise(makeGeneratedWorld<MobBehaviour>({ dimension: 'overworld' }))
    return {
      seed: 1,
      dimension: 'overworld',
      player: await Effect.runPromise(generated.player.pose),
      storage: await Effect.runPromise(generated.inventory.storageSnapshot),
      containerStorage: await Effect.runPromise(generated.inventory.containerStorageSnapshot),
      vitals: await Effect.runPromise(generated.vitals.snapshot),
      time: { ticks: 0, dayLengthTicks: 24_000 },
      weather: { weather: 'clear', remainingSecs: 120 },
      redstone: { levers: [] },
      furnaces: [],
      portals: [],
      crops: await Effect.runPromise(Schema.decodeUnknownEffect(CropSnapshotSchema)({ crops: [] })),
      entities: EMPTY_ENTITY_ROSTERS,
      villagers: EMPTY_VILLAGER_STATE,
      brewing: Result.getOrThrow(emptyBrewingState()),
      statusEffects: emptyStatusEffectState(),
      end: EMPTY_END_STATE,
    }
  }

  // The host's publish: Effect.runPromise over saveSession, so a coordinator
  // rejection is whatever that promise rejects with.
  const rejectionOfHostSave = async (layer: Layer.Layer<StoragePort>): Promise<unknown> => {
    const state = await generatedSessionState()
    const failures: unknown[] = []
    const coordinator = createSessionSaveCoordinator<SessionState>({
      initialKnownChunks: [],
      snapshotResidents: async () => [dimensionChunk('overworld', 0, 0, 3)],
      currentGeneration: () => 0,
      snapshotState: async () => state,
      publish: ({ state: published, chunks }) =>
        Effect.runPromise(Effect.provide(saveSession({
          sessionId: 'host-world',
          revision: 'r2',
          metadata: { name: 'Host World', mode: 'survival' },
          state: published,
          chunks,
        }), layer)).then(() => undefined),
      onFailure: (error) => { failures.push(error) },
    })
    const rejection: unknown = await coordinator.requestSave().catch((error: unknown) => error)
    expect(failures).toEqual([rejection])
    return rejection
  }

  it('classifies a storage failure from a real save', async () => {
    const rejection = await rejectionOfHostSave(failingStorageLayer(StorageOperation('put')))

    expect(rejection).toBeInstanceOf(StorageError)
    expect(sessionSaveFailureMessage(rejection)).toBe(
      'The world could not be saved. Your progress since the last save is not stored yet.',
    )
  })

  it('classifies a save blocked by a newer build\'s session', async () => {
    const storage = await Effect.runPromise(makeInMemoryStorage)
    const state = await generatedSessionState()
    const futureHead = Result.getOrThrow(sealSaveEnvelope({
      format: SaveFormatName(SESSION_FORMAT_NAME),
      version: SaveFormatVersion(19),
      payload: {
        sessionId: 'host-world',
        revision: 'r1',
        metadata: { name: 'Host World', mode: 'survival' },
        state: Result.getOrThrow(toStoredSessionState(state)),
        chunks: [],
      },
    }))
    await Effect.runPromise(storage.put(SaveKey('mc-compose/session/host-world/head'), futureHead))

    const rejection = await rejectionOfHostSave(Layer.succeed(StoragePort, storage))

    expect(rejection).toBeInstanceOf(SessionIncompatibleError)
    expect(rejection).toMatchObject({ reason: 'future-version', storedVersion: 19, currentVersion: 18 })
    expect(sessionSaveFailureMessage(rejection)).toBe(
      'This world was saved by a newer version. Saving is blocked so it is not overwritten.',
    )
    expect(await Effect.runPromise(storage.get(SaveKey('mc-compose/session/host-world/head'))))
      .toEqual(Option.some(futureHead))
  })

  it('classifies a save blocked by a session version without a migration path', async () => {
    const storage = await Effect.runPromise(makeInMemoryStorage)
    const state = await generatedSessionState()
    await Effect.runPromise(storage.put(
      SaveKey('mc-compose/session/host-world/head'),
      Result.getOrThrow(sealSaveEnvelope({
        format: SaveFormatName(SESSION_FORMAT_NAME),
        version: SaveFormatVersion(16),
        payload: {
          sessionId: 'host-world',
          revision: 'r1',
          metadata: { name: 'Host World', mode: 'survival' },
          state: Result.getOrThrow(toStoredSessionState(state)),
          chunks: [],
        },
      })),
    ))

    const rejection = await rejectionOfHostSave(Layer.succeed(StoragePort, storage))

    expect(rejection).toMatchObject({ _tag: 'SessionIncompatibleError', reason: 'unsupported-version', storedVersion: 16 })
    expect(sessionSaveFailureMessage(rejection)).toBe(
      'This world was saved by an older version that can no longer be opened. Saving is blocked so it is not overwritten.',
    )
  })

  it('classifies unstable snapshots and falls back for any other rejection', () => {
    expect(sessionSaveFailureMessage(new SessionSnapshotUnstableError({ attempts: 8 }))).toBe(
      'The world kept changing while it was being saved. Your progress since the last save is not stored yet.',
    )
    expect(sessionSaveFailureMessage(new Error('publish aborted'))).toBe('The world could not be saved.')
    expect(sessionSaveFailureMessage('publish aborted')).toBe('The world could not be saved.')
  })
})
