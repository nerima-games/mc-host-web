import { describe, expect, it } from '@effect/vitest'
import {
  AIR_BLOCK_ID,
  BlockAxis,
  blockIdOf,
  blockPosition,
  BlockStateAgeSchema,
  ChunkAxis,
  chunkCoord,
  DimensionIdSchema,
  WorldIdSchema,
  type Dimension,
} from '@nerima-games/mc-kernel'
import {
  makeReplicatedOwnerId,
  makeWorldCommitCoordinator,
  type ReplicatedOwnerCandidate,
  type WorldCommitCoordinatorApi,
} from '@nerima-games/mc-sim'
import {
  CHUNK_HEIGHT,
  CHUNK_SIZE_XZ,
  CHUNK_VOLUME,
  ChunkCapacity,
  makeChunkStore,
  type ChunkBiomeType,
  type ChunkSource,
  type ChunkStoreApi,
  type ChunkStoreRegistryApi,
} from '@nerima-games/mc-worldgen'
import type { BlockStateEdit } from '@nerima-games/mx-gameplay'
import { Effect, Exit, Option, Ref, Result, Schema } from 'effect'

import { makeHostGameplayBlockStateWorld } from '../apps/web/gameplay-block-state-world'

const OWNER = makeReplicatedOwnerId('h5-block-state-owner')
const OTHER_OWNER = makeReplicatedOwnerId('h5-block-state-other-owner')
const UNKNOWN_OWNER = makeReplicatedOwnerId('h5-block-state-unknown-owner')
const WORLD = 'h5-block-state-world'
// Both are registered in every kernel release; their absence would make every
// fixture below meaningless.
const STONE = Option.getOrThrow(blockIdOf('stone'))
const POTATO = Option.getOrThrow(blockIdOf('potato_crop'))

const at = (x: number, y: number, z: number) => blockPosition(BlockAxis(x), BlockAxis(y), BlockAxis(z))
const P = at(1, 10, 1)
const Q = at(1, 11, 1)
const UNLOADED = at(CHUNK_SIZE_XZ + 1, 10, 1)
const ORIGIN_CHUNK = chunkCoord(ChunkAxis(0), ChunkAxis(0))

const allAirChunkSource: ChunkSource = (coord) => Effect.succeed({
  coord,
  blocks: new Uint16Array(CHUNK_VOLUME).fill(AIR_BLOCK_ID),
  biomes: Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, (): ChunkBiomeType => 'PLAINS'),
})

const potatoAt = (position: BlockStateEdit['position'], age: number) => Effect.map(
  Schema.decodeUnknownEffect(BlockStateAgeSchema)(age),
  (decoded): BlockStateEdit => ({ position, block: POTATO, state: { age: decoded } }),
)

type FixtureOptions = {
  // Wraps only the store the adapter reads from; the coordinator commits to
  // the real one.
  readonly wrapReadStore?: (store: ChunkStoreApi) => ChunkStoreApi
}

const makeFixture = (options: FixtureOptions = {}) => Effect.gen(function* () {
  const stores: Readonly<Record<Dimension, ChunkStoreApi>> = {
    overworld: yield* makeChunkStore(allAirChunkSource, ChunkCapacity(16)),
    nether: yield* makeChunkStore(allAirChunkSource, ChunkCapacity(16)),
    end: yield* makeChunkStore(allAirChunkSource, ChunkCapacity(16)),
  }
  // Only the overworld origin chunk is resident.
  yield* stores.overworld.load(ORIGIN_CHUNK)
  const chunkStores: ChunkStoreRegistryApi = { forDimension: (dimension) => stores[dimension] }
  const coordinator = yield* makeWorldCommitCoordinator({
    world: yield* Schema.decodeUnknownEffect(WorldIdSchema)(WORLD),
    owners: [
      { ownerId: OWNER, schema: Schema.Number, initialState: 0 },
      { ownerId: OTHER_OWNER, schema: Schema.Number, initialState: 0 },
    ],
    chunkStores,
  })
  const commits = yield* Ref.make(0)
  const counted: WorldCommitCoordinatorApi = {
    ...coordinator,
    commit: (request) => Effect.andThen(Ref.update(commits, (count) => count + 1), coordinator.commit(request)),
  }
  const wrapRead = options.wrapReadStore
  const world = makeHostGameplayBlockStateWorld({
    coordinator: counted,
    chunkStores: wrapRead === undefined
      ? chunkStores
      : { forDimension: (dimension) => wrapRead(stores[dimension]) },
    dimensionIds: yield* Effect.all({
      overworld: Schema.decodeEffect(DimensionIdSchema)('overworld'),
      nether: Schema.decodeEffect(DimensionIdSchema)('nether'),
      end: Schema.decodeEffect(DimensionIdSchema)('end'),
    }),
  })

  const observe = Effect.gen(function* () {
    return {
      world: yield* coordinator.revision,
      overworld: yield* coordinator.dimensionRevision('overworld'),
      owner: (yield* coordinator.snapshot(OWNER, Schema.Number)).state,
      otherOwner: (yield* coordinator.snapshot(OTHER_OWNER, Schema.Number)).state,
      p: yield* stores.overworld.getBlockWithState(P),
      q: yield* stores.overworld.getBlockWithState(Q),
    }
  })

  // Advance only the world revision: an owner-only commit names no dimension.
  const advanceWorldOnly = Effect.gen(function* () {
    yield* coordinator.commit({
      expectedRevision: yield* coordinator.revision,
      expectedDimensions: [],
      changes: [{ ownerId: OTHER_OWNER, state: 9 }],
    })
  })

  return { stores, coordinator, world, commits, observe, advanceWorldOnly }
})

const defectOf = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.hasFails(exit)).toBe(false)
  const defect = Exit.findDefect(exit)
  expect(Result.isSuccess(defect)).toBe(true)
  return Result.isSuccess(defect) ? defect.success : undefined
}

const ownerChange = (state: number): ReplicatedOwnerCandidate => ({ ownerId: OWNER, state })

describe('host GameplayBlockStateWorld over the C7 coordinator', () => {
  describe('read', () => {
    it.effect('returns Found with the stored state, and an empty state for a block without properties', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const port = fixture.world.forDimension('overworld')
        expect(yield* port.write([yield* potatoAt(P, 3)])).toStrictEqual({ _tag: 'Written' })
        // A C7 batch rejects an explicit state for a block without properties,
        // so the stateless block is placed through the store directly.
        yield* fixture.stores.overworld.setBlock(Q, STONE)

        expect(yield* port.read(P)).toStrictEqual({ _tag: 'Found', cell: { block: POTATO, state: { age: 3 } } })
        expect(yield* port.read(Q)).toStrictEqual({ _tag: 'Found', cell: { block: STONE, state: {} } })
        expect(yield* port.read(at(2, 10, 1))).toStrictEqual({ _tag: 'Found', cell: { block: AIR_BLOCK_ID, state: {} } })
      }))

    it.effect('returns Unavailable ChunkNotLoaded for a chunk that is not resident, per dimension', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()

        expect(yield* fixture.world.forDimension('overworld').read(UNLOADED))
          .toStrictEqual({ _tag: 'Unavailable', reason: 'ChunkNotLoaded' })
        // The overworld origin chunk is resident; the nether's is not.
        expect(yield* fixture.world.forDimension('nether').read(P))
          .toStrictEqual({ _tag: 'Unavailable', reason: 'ChunkNotLoaded' })
        expect(yield* fixture.stores.nether.isLoaded(ORIGIN_CHUNK)).toBe(false)
      }))

    it.effect.each([
      { label: 'below the world', y: -1 },
      { label: 'at CHUNK_HEIGHT', y: CHUNK_HEIGHT },
    ])('returns Unavailable OutOfWorld for y $label', ({ y }) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()

        expect(yield* fixture.world.forDimension('overworld').read(at(1, y, 1)))
          .toStrictEqual({ _tag: 'Unavailable', reason: 'OutOfWorld' })
      }))

    it.effect('dies when the store cannot decode a resident block state', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          wrapReadStore: (store) => ({
            ...store,
            getBlockWithState: () => Effect.fail({ _tag: 'BlockStateCodecFailure', reason: 'reserved-code' }),
          }),
        })

        const exit = yield* Effect.exit(fixture.world.forDimension('overworld').read(P))

        expect(defectOf(exit)).toMatchObject({
          message: 'c7-adapter: unexpected BlockStateCodecFailure',
          cause: { _tag: 'BlockStateCodecFailure', reason: 'reserved-code' },
        })
      }))
  })

  describe('write', () => {
    it.effect('commits the edits and every owner change in one commit that advances each revision once', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const before = yield* fixture.observe

        const written = yield* fixture.world
          .forDimension('overworld', [ownerChange(7)])
          .write([yield* potatoAt(P, 2), yield* potatoAt(Q, 5)], [{ ownerId: OTHER_OWNER, state: 4 }])

        expect(written).toStrictEqual({ _tag: 'Written' })
        expect(yield* Ref.get(fixture.commits)).toBe(1)
        const after = yield* fixture.observe
        expect(after).toMatchObject({
          world: before.world + 1,
          overworld: before.overworld + 1,
          owner: 7,
          otherOwner: 4,
          p: { _tag: 'Block', block: POTATO, state: { age: 2 } },
          q: { _tag: 'Block', block: POTATO, state: { age: 5 } },
        })
        expect(yield* fixture.coordinator.dimensionRevision('nether')).toBe(0)
      }))

    it.effect('commits when the given expected world revision is current', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* fixture.advanceWorldOnly
        const current = yield* fixture.coordinator.revision

        const written = yield* fixture.world
          .forDimension('overworld', [ownerChange(3)], current)
          .write([yield* potatoAt(P, 1)])

        expect(written).toStrictEqual({ _tag: 'Written' })
        expect(yield* fixture.observe).toMatchObject({
          world: current + 1,
          owner: 3,
          p: { _tag: 'Block', block: POTATO, state: { age: 1 } },
        })
      }))

    it.effect('expects the current revisions when no expected world revision is given', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* fixture.advanceWorldOnly
        yield* fixture.world.forDimension('overworld').write([yield* potatoAt(Q, 0)])

        const written = yield* fixture.world.forDimension('overworld').write([yield* potatoAt(P, 1)])

        expect(written).toStrictEqual({ _tag: 'Written' })
        expect(yield* fixture.observe).toMatchObject({ world: 3, overworld: 2 })
      }))

    it.effect('refuses a stale expected world revision without Written and changes nothing', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const stale = yield* fixture.coordinator.revision
        yield* fixture.advanceWorldOnly
        const before = yield* fixture.observe

        const written = yield* fixture.world
          .forDimension('overworld', [ownerChange(7)], stale)
          .write([yield* potatoAt(P, 2)])

        expect(written).toStrictEqual({ _tag: 'Unsupported', operation: 'writeState' })
        expect(yield* Ref.get(fixture.commits)).toBe(1)
        expect(yield* fixture.observe).toStrictEqual(before)
        expect(before.owner).toBe(0)
      }))

    it.effect.each([
      { label: 'in a chunk that is not resident', position: UNLOADED },
      { label: 'outside the world', position: at(1, CHUNK_HEIGHT, 1) },
    ])('refuses an edit $label without Written and changes nothing', ({ position }) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const before = yield* fixture.observe

        const written = yield* fixture.world
          .forDimension('overworld', [ownerChange(7)])
          .write([yield* potatoAt(P, 2), yield* potatoAt(position, 2)])

        expect(written).toStrictEqual({ _tag: 'Unsupported', operation: 'writeState' })
        expect(yield* fixture.observe).toStrictEqual(before)
      }))

    it.effect.each([
      { label: 'an empty batch', reason: 'empty', edits: [] },
      {
        label: 'duplicate positions',
        reason: 'duplicate-position',
        edits: [{ position: P, block: POTATO, state: {} }, { position: P, block: POTATO, state: {} }],
      },
    ])('dies on $label from a rule without committing', ({ reason, edits }) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const before = yield* fixture.observe

        const exit = yield* Effect.exit(fixture.world.forDimension('overworld', [ownerChange(7)]).write(edits))

        expect(defectOf(exit)).toMatchObject({
          message: 'c7-adapter: unexpected WorldWriteInvalidBatch',
          cause: { _tag: 'WorldWriteInvalidBatch', reason },
        })
        expect(yield* Ref.get(fixture.commits)).toBe(0)
        expect(yield* fixture.observe).toStrictEqual(before)
      }))

    it.effect('dies on an owner change for an unregistered owner and commits neither part', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const before = yield* fixture.observe

        const exit = yield* Effect.exit(fixture.world
          .forDimension('overworld', [ownerChange(7)])
          .write([yield* potatoAt(P, 2)], [{ ownerId: UNKNOWN_OWNER, state: 1 }]))

        expect(defectOf(exit)).toMatchObject({
          message: 'c7-adapter: unexpected ReplicatedOwnerUnknown',
          cause: { _tag: 'ReplicatedOwnerUnknown', ownerId: UNKNOWN_OWNER },
        })
        expect(yield* fixture.observe).toStrictEqual(before)
      }))
  })
})
