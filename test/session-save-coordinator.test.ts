import { describe, expect, it } from 'vitest'
import { Effect, Option, Result, Schema } from 'effect'
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
import { EntitySerial, PlayerStorageSnapshotSchema } from '@nerima-games/mc-sim'
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
  GAMEPLAY_ENTITIES_OWNER_ID,
  GAMEPLAY_PLAYER_OWNER_ID,
  GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  GAMEPLAY_VITALS_OWNER_ID,
  gameplayOwnerRegistrations,
  hostileMobSnapshot,
  makeGeneratedWorld,
  mintEntityId,
  type MobBehaviour,
  type MobEntity,
} from '@nerima-games/mx-gameplay'

import type { DimensionChunk } from '../apps/web/session-persistence'
import { createDroppedItemLifetimeTracker } from '../apps/web/dropped-item-lifetime'
import { makeOwnerBackedHost } from '../apps/web/owner-backed-services'
import { initializeSessionWorld } from '../apps/web/session-world'
import { makeHostWorldWrite } from '../apps/web/world-write-port'

import {
  createSessionSaveCoordinator,
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
      snapshotState: () => 1,
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
      snapshotState: () => publications.length,
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
    expect(secondSettled).toBe(false)
    expect(publications).toHaveLength(2)

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
      snapshotState: () => 1,
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
      snapshotState: () => 1,
      publish: (publication) => {
        publications.push(publication)
        return publications.length === 1 ? firstSave.promise : Promise.resolve()
      },
    })
    coordinator.retainChunk(dimensionChunk('overworld', 7, 2, 3))
    const first = coordinator.requestSave()
    await Promise.resolve()
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
      snapshotState: () => state,
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
      snapshotState: () => state,
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
      snapshotState: () => generation,
      publish: async (publication) => { publications.push(publication) },
    })

    await expect(coordinator.requestSave()).rejects.toThrow(
      'Unable to capture a consistent save snapshot after 8 attempts',
    )
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
      snapshotState: () => ++stateSnapshotCount,
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
      snapshotState: () => 1,
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
      snapshotState: () => 1,
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
      snapshotState: () => 1,
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
      snapshotState: () => Effect.runSync(
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
