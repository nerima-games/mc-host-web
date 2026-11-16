import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Result } from 'effect'

import { ChunkAxis, chunkCoord, CHUNK_SIZE_XZ, WorldId } from '@nerima-games/mc-kernel'
import { makeWorldCommitCoordinator, ReplicatedOwnerUnknown, type WorldCommitCoordinatorApi } from '@nerima-games/mc-sim'
import { CHUNK_VOLUME, type Chunk, type ChunkWithBlockStates } from '@nerima-games/mc-worldgen'
import {
  GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
  GameplayVillagerTradeSnapshotSchema,
  gameplayOwnerRegistrations,
  makeVillager,
} from '@nerima-games/mx-gameplay'

import {
  desiredChunksAround,
  makeChunkStreaming,
  type ChunkStreamingContext,
} from '../apps/web/chunk-streaming'
import type { PersistedVillager } from '../apps/web/session-persistence'

const chunk = (cx: number, cz: number): ChunkWithBlockStates => ({
  coord: chunkCoord(ChunkAxis(cx), ChunkAxis(cz)),
  blocks: new Uint16Array(CHUNK_VOLUME),
  blockStates: new Uint32Array(CHUNK_VOLUME),
  biomes: Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, () => 'PLAINS'),
})

const chunkContext = (events: Array<string>): ChunkStreamingContext => ({
  dimension: 'nether',
  chunkStore: {
    load: (coord) => Effect.sync(() => {
      events.push(`load:${String(coord.cx)},${String(coord.cz)}`)
      return chunk(coord.cx, coord.cz)
    }),
    unload: (coord) => Effect.sync(() => {
      events.push(`unload:${String(coord.cx)},${String(coord.cz)}`)
      return true
    }),
  },
  worldgenChunkStore: {
    loadedCoords: Effect.succeed([]),
    snapshot: (coord) => Effect.sync(() => {
      events.push(`snapshot:${String(coord.cx)},${String(coord.cz)}`)
      return chunk(coord.cx, coord.cz)
    }),
  },
  queueLoadedChunk: (coord) => events.push(`queue:${String(coord.cx)},${String(coord.cz)}`),
  streamLoaded: new Set(),
})

describe('chunk streaming', () => {
  it('counts and notifies partial publication once when a later chunk fails and is retried', async () => {
    const owner = await Effect.runPromise(makeWorldCommitCoordinator({
      world: WorldId('chunk-streaming-partial-retry'),
      owners: gameplayOwnerRegistrations(),
    }))
    const failure = new ReplicatedOwnerUnknown({ ownerId: GAMEPLAY_VILLAGER_TRADES_OWNER_ID })
    let snapshotCalls = 0
    const coordinator: WorldCommitCoordinatorApi = {
      ...owner,
      snapshot: (ownerId, schema) => {
        snapshotCalls += 1
        return snapshotCalls === 2 ? Effect.fail(failure) : owner.snapshot(ownerId, schema)
      },
    }
    const events: string[] = []
    const counters = { streamed: 0, dropped: 0 }
    const attributes = new Map<string, string>()
    const streaming = makeChunkStreaming({
      streamRadiusChunks: 1,
      activeSeed: 71,
      coordinator,
      canvas: { setAttribute: (name, value) => { attributes.set(name, value) } },
      villagerResidents: new Map(),
      saveCoordinator: { retainChunk: () => { events.push('retain') } },
      getMarkSessionDirty: () => () => { events.push('dirty') },
      markRedstoneDirty: () => { events.push('redstone-dirty') },
      getChunksStreamedIn: () => counters.streamed,
      setChunksStreamedIn: (count) => { counters.streamed = count },
      getChunksDropped: () => counters.dropped,
      setChunksDropped: (count) => { counters.dropped = count },
    })
    const context: ChunkStreamingContext = { ...chunkContext(events), dimension: 'overworld' }
    context.streamLoaded.add('0,0')

    expect(await Effect.runPromise(Effect.result(
      streaming.streamAround(context, -272, 720),
    ))).toEqual(Result.fail(failure))
    expect([...context.streamLoaded]).toEqual(['0,0', '-18,44'])
    expect(counters).toEqual({ streamed: 1, dropped: 0 })
    expect(events.filter((event) => event === 'redstone-dirty')).toHaveLength(1)
    expect(events.filter((event) => event.startsWith('unload:'))).toEqual([])
    expect(attributes.get('data-chunks-streamed-in')).toBe('1')
    expect(attributes.get('data-chunks-meshed')).toBe('2')

    await Effect.runPromise(streaming.streamAround(context, -272, 720))
    expect(context.streamLoaded.size).toBe(9)
    expect(context.streamLoaded.has('0,0')).toBe(false)
    expect(counters).toEqual({ streamed: 9, dropped: 1 })
    expect(events.filter((event) => event === 'queue:-18,44')).toHaveLength(1)
    expect(events.filter((event) => event.startsWith('queue:'))).toHaveLength(9)
    expect(events.filter((event) => event === 'unload:0,0')).toHaveLength(1)
    expect(events.filter((event) => event === 'retain')).toHaveLength(1)
    expect(events.filter((event) => event === 'redstone-dirty')).toHaveLength(2)
    expect(attributes).toEqual(new Map([
      ['data-chunks-meshed', '9'],
      ['data-chunks-streamed-in', '9'],
      ['data-chunks-dropped', '1'],
    ]))
  })

  it('retries a failed owner commit and preserves intervening trade uses and restock progress', async () => {
    // Public real-terrain generation for seed 71 places this villager in chunk (-17, 45).
    const villagerId = 'village:71:-258:734:house:0'
    const villager = makeVillager(villagerId, 'farmer')
    const unrelated = makeVillager('elsewhere', 'toolsmith')
    const initial = { villagers: [villager, unrelated], restockElapsedSecs: 42 }
    const intervening = {
      villagers: [
        { ...villager, offers: villager.offers.map((offer) => ({ ...offer, uses: 3 })) },
        unrelated,
      ],
      restockElapsedSecs: 91,
    }
    const owner = await Effect.runPromise(makeWorldCommitCoordinator({
      world: WorldId('chunk-streaming-owner-retry'),
      owners: Result.getOrThrow(gameplayOwnerRegistrations({ villagerTrades: initial })),
    }))
    const failure = new ReplicatedOwnerUnknown({ ownerId: GAMEPLAY_VILLAGER_TRADES_OWNER_ID })
    let commitAttempts = 0
    const coordinator: WorldCommitCoordinatorApi = {
      ...owner,
      commitFromSnapshot: (ownerId, schema, buildRequest) => Effect.gen(function* () {
        commitAttempts += 1
        if (commitAttempts === 1) return yield* Effect.fail(failure)
        yield* owner.commitFromSnapshot(
          GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
          GameplayVillagerTradeSnapshotSchema,
          (snapshot) => Effect.succeed({
            expectedRevision: snapshot.revision,
            expectedDimensions: [],
            changes: [{ ownerId: GAMEPLAY_VILLAGER_TRADES_OWNER_ID, state: intervening }],
          }),
        )
        return yield* owner.commitFromSnapshot(ownerId, schema, buildRequest)
      }),
    }
    const events: string[] = []
    const counters = { streamed: 0, dropped: 0 }
    const villagerResidents = new Map<string, PersistedVillager>()
    const streaming = makeChunkStreaming({
      streamRadiusChunks: 0,
      activeSeed: 71,
      coordinator,
      canvas: { setAttribute: () => { events.push('attribute') } },
      villagerResidents,
      saveCoordinator: { retainChunk: () => { events.push('retain') } },
      getMarkSessionDirty: () => () => { events.push('dirty') },
      markRedstoneDirty: () => { events.push('redstone-dirty') },
      getChunksStreamedIn: () => counters.streamed,
      setChunksStreamedIn: (count) => { counters.streamed = count },
      getChunksDropped: () => counters.dropped,
      setChunksDropped: (count) => { counters.dropped = count },
    })
    const context: ChunkStreamingContext = { ...chunkContext(events), dimension: 'overworld' }
    context.streamLoaded.add('0,0')

    const failed = await Effect.runPromise(Effect.result(streaming.streamAround(context, -272, 720)))
    expect(failed).toEqual(Result.fail(failure))
    expect(events).toEqual(['load:-17,45'])
    expect([...context.streamLoaded]).toEqual(['0,0'])
    expect(villagerResidents.size).toBe(0)
    expect(counters).toEqual({ streamed: 0, dropped: 0 })
    const afterFailure = await Effect.runPromise(owner.snapshot(
      GAMEPLAY_VILLAGER_TRADES_OWNER_ID, GameplayVillagerTradeSnapshotSchema,
    ))
    expect(afterFailure.state).toEqual(initial)

    await Effect.runPromise(streaming.streamAround(context, -272, 720))
    const published = await Effect.runPromise(owner.snapshot(
      GAMEPLAY_VILLAGER_TRADES_OWNER_ID, GameplayVillagerTradeSnapshotSchema,
    ))
    expect(commitAttempts).toBe(2)
    expect(published.state).toEqual(intervening)
    expect(published.revision).toBe(2)
    expect(villagerResidents.size).toBe(1)
    expect(villagerResidents.get(villagerId)).toMatchObject({
      profession: 'farmer', dimension: 'overworld', feetPosition: { x: -271.5, y: 76, z: 724.5 },
    })
    expect(events.slice(0, 9)).toEqual([
      'load:-17,45', 'load:-17,45', 'queue:-17,45', 'dirty',
      'snapshot:0,0', 'retain', 'dirty', 'unload:0,0', 'redstone-dirty',
    ])
    expect([...context.streamLoaded]).toEqual(['-17,45'])
    expect(counters).toEqual({ streamed: 1, dropped: 1 })

    await Effect.runPromise(streaming.streamAround(context, -272, 720))
    expect(commitAttempts).toBe(2)
    expect((await Effect.runPromise(owner.snapshot(
      GAMEPLAY_VILLAGER_TRADES_OWNER_ID, GameplayVillagerTradeSnapshotSchema,
    ))).state).toEqual(intervening)
  })

  it('interrupts an in-flight load without queueing or unloading and can retry it', async () => {
    const events: string[] = []
    const started = Deferred.makeUnsafe<void>()
    const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
      world: WorldId('chunk-streaming-interruption'),
      owners: gameplayOwnerRegistrations(),
    }))
    const counters = { streamed: 0, dropped: 0 }
    const attributes = new Map<string, string>()
    const streaming = makeChunkStreaming({
      streamRadiusChunks: 0,
      activeSeed: 71,
      coordinator,
      canvas: { setAttribute: (name, value) => { attributes.set(name, value) } },
      villagerResidents: new Map(),
      saveCoordinator: { retainChunk: () => { events.push('retain') } },
      getMarkSessionDirty: () => () => { events.push('dirty') },
      markRedstoneDirty: () => { events.push('redstone-dirty') },
      getChunksStreamedIn: () => counters.streamed,
      setChunksStreamedIn: (count) => { counters.streamed = count },
      getChunksDropped: () => counters.dropped,
      setChunksDropped: (count) => { counters.dropped = count },
    })
    const base = chunkContext(events)
    base.streamLoaded.add('0,0')
    let suspended = true
    const context: ChunkStreamingContext = {
      ...base,
      chunkStore: {
        ...base.chunkStore,
        load: (coord) => suspended
          ? Effect.gen(function* () {
              events.push(`start:${String(coord.cx)},${String(coord.cz)}`)
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }).pipe(Effect.onInterrupt(() => Effect.sync(() => { events.push('interrupted') })))
          : base.chunkStore.load(coord),
      },
    }
    const fiber = Effect.runFork(streaming.streamAround(context, 16, 0))
    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(events).toEqual(['start:1,0', 'interrupted'])
    expect([...context.streamLoaded]).toEqual(['0,0'])
    expect(counters).toEqual({ streamed: 0, dropped: 0 })
    expect(attributes.size).toBe(0)

    suspended = false
    await Effect.runPromise(streaming.streamAround(context, 16, 0))
    expect(events).toEqual([
      'start:1,0', 'interrupted', 'load:1,0', 'queue:1,0',
      'snapshot:0,0', 'retain', 'dirty', 'unload:0,0', 'redstone-dirty',
    ])
    expect([...context.streamLoaded]).toEqual(['1,0'])
    expect(counters).toEqual({ streamed: 1, dropped: 1 })
  })

  it('preserves the row-major order of chunks around a position', () => {
    expect(desiredChunksAround(1, 0, 0)).toEqual([
      { cx: -1, cz: -1 },
      { cx: -1, cz: 0 },
      { cx: -1, cz: 1 },
      { cx: 0, cz: -1 },
      { cx: 0, cz: 0 },
      { cx: 0, cz: 1 },
      { cx: 1, cz: -1 },
      { cx: 1, cz: 0 },
      { cx: 1, cz: 1 },
    ])
  })

  it('loads new chunks before snapshotting, retaining, and unloading removed chunks', async () => {
    const events: Array<string> = []
    const attributes = new Map<string, string>()
    const retained: Array<Readonly<{ dimension: string; chunk: Chunk }>> = []
    const counters = { streamed: 0, dropped: 0 }
    const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
      world: WorldId('chunk-streaming-test'),
      owners: gameplayOwnerRegistrations(),
    }))
    const streaming = makeChunkStreaming({
      streamRadiusChunks: 0,
      activeSeed: 71,
      canvas: { setAttribute: (name, value) => { attributes.set(name, value) } },
      coordinator,
      villagerResidents: new Map(),
      saveCoordinator: { retainChunk: (value) => { retained.push(value) } },
      getMarkSessionDirty: () => () => { events.push('dirty') },
      markRedstoneDirty: () => { events.push('redstone-dirty') },
      getChunksStreamedIn: () => counters.streamed,
      setChunksStreamedIn: (count) => { counters.streamed = count },
      getChunksDropped: () => counters.dropped,
      setChunksDropped: (count) => { counters.dropped = count },
    })
    const context = chunkContext(events)

    await Effect.runPromise(streaming.streamAround(context, 0, 0))
    await Effect.runPromise(streaming.streamAround(context, 16, 0))

    expect(events).toEqual([
      'load:0,0',
      'queue:0,0',
      'redstone-dirty',
      'load:1,0',
      'queue:1,0',
      'snapshot:0,0',
      'dirty',
      'unload:0,0',
      'redstone-dirty',
    ])
    expect(retained).toHaveLength(1)
    expect(retained[0]).toMatchObject({ dimension: 'nether', chunk: { coord: { cx: 0, cz: 0 } } })
    expect([...context.streamLoaded]).toEqual(['1,0'])
    expect(attributes).toEqual(new Map([
      ['data-chunks-meshed', '1'],
      ['data-chunks-streamed-in', '2'],
      ['data-chunks-dropped', '1'],
    ]))
  })
})
