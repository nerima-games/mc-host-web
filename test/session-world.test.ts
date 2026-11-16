import { beforeAll, describe, expect, it } from '@effect/vitest'
import { Effect, Option, Result } from 'effect'
import { ChunkAxis, chunkCoord, WorldId } from '@nerima-games/mc-kernel'
import { EntitySerial, makeWorldCommitCoordinator } from '@nerima-games/mc-sim'
import { gameplayOwnerRegistrations } from '@nerima-games/mx-gameplay'
import {
  ChunkCapacity,
  chunkSnapshotOf,
  generatedDimensionChunkSource,
  makeChunkStore,
  NoiseSeed,
  type Chunk,
  type ChunkWithBlockStates,
  type Dimension,
} from '@nerima-games/mc-worldgen'

import { createDroppedItemLifetimeTracker } from '../apps/web/dropped-item-lifetime'
import { makeChunkStreaming } from '../apps/web/chunk-streaming'
import type { DimensionChunk } from '../apps/web/session-persistence'
import { initializeSessionWorld } from '../apps/web/session-world'

const seed = NoiseSeed(81)
const coord = chunkCoord(ChunkAxis(0), ChunkAxis(0))
const materialize = async (chunk: Chunk): Promise<ChunkWithBlockStates> => {
  const store = await Effect.runPromise(makeChunkStore(() => Effect.succeed(chunk), ChunkCapacity(1)))
  await Effect.runPromise(store.load(chunk.coord))
  return Option.getOrThrow(Option.fromUndefinedOr(await Effect.runPromise(store.snapshot(chunk.coord))))
}
const terrainFixtures = new Map<Dimension, { generated: Chunk; snapshot: ChunkWithBlockStates }>()
beforeAll(async () => {
  for (const dimension of ['overworld', 'nether', 'end'] satisfies ReadonlyArray<Dimension>) {
    const generated = await Effect.runPromise(generatedDimensionChunkSource(seed, dimension)(coord))
    terrainFixtures.set(dimension, { generated, snapshot: await materialize(generated) })
  }
})
const terrainFixture = (dimension: Dimension): { generated: Chunk; snapshot: ChunkWithBlockStates } =>
  Option.getOrThrow(Option.fromUndefinedOr(terrainFixtures.get(dimension)))
const legacyChunk = async (): Promise<ChunkWithBlockStates> =>
  chunkSnapshotOf(terrainFixture('overworld').snapshot)

describe('dimension terrain initialization', () => {
  it('initializes all saved chunks while only one is resident and retains edits across reloads', async () => {
    const saved = await legacyChunk()
    const edited = chunkSnapshotOf(saved)
    edited.blocks[edited.blocks.length - 1] = 1
    const records: Array<DimensionChunk> = [
      { dimension: 'overworld', chunk: saved },
      { dimension: 'nether', chunk: chunkSnapshotOf(saved) },
      { dimension: 'end', chunk: edited },
    ]
    const initialized = await initializeSessionWorld({
      loadedSession: Option.some({ state: {
        seed,
        entities: {
          overworld: { entities: [], nextSerial: EntitySerial(0) },
          nether: { entities: [], nextSerial: EntitySerial(0) },
          end: { entities: [], nextSerial: EntitySerial(0) },
        },
      } }),
      initialDimension: 'overworld',
      worldSeed: 42,
      loadSavedChunks: async () => ({ chunks: records }),
      makeWorld: async ({ chunkSource }) => {
        const store = await Effect.runPromise(makeChunkStore(chunkSource, ChunkCapacity(2)))
        await Effect.runPromise(store.load(coord))
        return store
      },
      restoreEntities: () => {},
      snapshotEntities: () => ({ entities: [], nextSerial: EntitySerial(0) }),
      droppedItemLifetime: createDroppedItemLifetimeTracker(),
      droppedItemMetadata: new Map(),
      droppedItemMetadataKey: (dimension, entityId) => `${dimension}:${entityId}`,
      droppedItemMetadataFromBehaviour: () => ({}),
    })
    const world = Result.getOrThrow(initialized)
    expect(world.activeSeed).toBe(81)
    expect(world.initialKnownChunks).toHaveLength(3)
    expect(world.restored?.chunks).toEqual(world.initialKnownChunks)
    expect(world.initialKnownChunks).toEqual(records)
    const nether = await Effect.runPromise(makeChunkStore(world.chunkSourceFor('nether'), ChunkCapacity(2)))
    const end = await Effect.runPromise(makeChunkStore(world.chunkSourceFor('end'), ChunkCapacity(2)))
    const streaming = makeChunkStreaming({
      streamRadiusChunks: 0,
      activeSeed: world.activeSeed,
      coordinator: await Effect.runPromise(makeWorldCommitCoordinator({
        world: WorldId('dimension-terrain-streaming'),
        owners: gameplayOwnerRegistrations(),
      })),
      canvas: { setAttribute: () => {} },
      villagerResidents: new Map(),
      saveCoordinator: { retainChunk: () => {} },
      getMarkSessionDirty: () => () => {},
      markRedstoneDirty: () => {},
      getChunksStreamedIn: () => 0,
      setChunksStreamedIn: () => {},
      getChunksDropped: () => 0,
      setChunksDropped: () => {},
    })
    for (const [dimension, store] of [['nether', nether], ['end', end]] satisfies ReadonlyArray<readonly [Dimension, typeof nether]>) {
      await Effect.runPromise(streaming.streamAround({
        dimension,
        chunkStore: store,
        worldgenChunkStore: store,
        streamLoaded: new Set(),
      }, 0, 0))
    }
    expect(await Effect.runPromise(nether.snapshot(coord))).toEqual(
      chunkSnapshotOf(saved),
    )
    expect(await Effect.runPromise(end.snapshot(coord))).toEqual(edited)
    await Effect.runPromise(end.unload(coord))
    await Effect.runPromise(end.load(coord))
    expect(await Effect.runPromise(end.snapshot(coord))).toEqual(edited)

    const unseen = chunkCoord(ChunkAxis(2), ChunkAxis(-1))
    for (const dimension of ['overworld', 'nether', 'end'] satisfies ReadonlyArray<Dimension>) {
      expect(await Effect.runPromise(world.chunkSourceFor(dimension)(unseen))).toEqual(
        await Effect.runPromise(generatedDimensionChunkSource(seed, dimension)(unseen)),
      )
    }
  })
})
