import { assert, describe, expect, it } from '@effect/vitest'
import { vi } from 'vitest'
import { Deferred, Effect, Fiber, Option, Result } from 'effect'

import { BlockAxis, blockIdOf, blockPosition, ChunkAxis, chunkCoord, CHUNK_SIZE_XZ, WorldId } from '@nerima-games/mc-kernel'
import {
  attachChunkStoreRenderer,
  chunkKeyOf,
  EMPTY_SYNC_REPORT,
  makeProductionWorldRenderer,
  type WorldRendererAttachment,
} from '@nerima-games/mc-render'
import { makeWorldCommitCoordinator, ReplicatedOwnerUnknown, type WorldCommitCoordinatorApi } from '@nerima-games/mc-sim'
import { StorageError } from '@nerima-games/mc-save'
import {
  CHUNK_VOLUME,
  ChunkCapacity,
  generatedChunkSource,
  makeChunkStore,
  NoiseSeed,
  type Chunk,
  type ChunkSource,
  type ChunkWithBlockStates,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import {
  GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
  GameplayVillagerTradeSnapshotSchema,
  gameplayOwnerRegistrations,
  makeVillager,
} from '@nerima-games/mx-gameplay'
import * as THREE from 'three'

import {
  activeDimensionChunkSync,
  budgetedRendererStore,
  ChunkRenderFailure,
  desiredChunksAround,
  drainChunkRenderFaults,
  makeChunkStreaming,
  showDimensionChunks,
  type ChunkRenderFault,
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
    // The published chunk is not loaded again; the failed one is loaded on both attempts.
    expect(events.filter((event) => event === 'load:-18,44')).toHaveLength(1)
    expect(events.filter((event) => event === 'load:-18,45')).toHaveLength(2)
    expect(events.filter((event) => event.startsWith('load:'))).toHaveLength(10)
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
    expect(events.slice(0, 8)).toEqual([
      'load:-17,45', 'load:-17,45', 'dirty',
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

  it('interrupts an in-flight load without marking it loaded or unloading and can retry it', async () => {
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
      'start:1,0', 'interrupted', 'load:1,0',
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
      'redstone-dirty',
      'load:1,0',
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

  describe('chunk store failures', () => {
    const streamingFor = async (events: Array<string>, counters: { streamed: number; dropped: number }) =>
      makeChunkStreaming({
        streamRadiusChunks: 0,
        activeSeed: 71,
        canvas: { setAttribute: () => {} },
        coordinator: await Effect.runPromise(makeWorldCommitCoordinator({
          world: WorldId('chunk-streaming-store-failure'),
          owners: gameplayOwnerRegistrations(),
        })),
        villagerResidents: new Map(),
        saveCoordinator: { retainChunk: () => { events.push('retain') } },
        getMarkSessionDirty: () => () => { events.push('dirty') },
        markRedstoneDirty: () => { events.push('redstone-dirty') },
        getChunksStreamedIn: () => counters.streamed,
        setChunksStreamedIn: (count) => { counters.streamed = count },
        getChunksDropped: () => counters.dropped,
        setChunksDropped: (count) => { counters.dropped = count },
      })

    it('returns a load failure without marking the chunk loaded', async () => {
      const events: Array<string> = []
      const counters = { streamed: 0, dropped: 0 }
      const streaming = await streamingFor(events, counters)
      const failure = { _tag: 'DirtyChunkEvictionError' as const, coord: chunkCoord(ChunkAxis(0), ChunkAxis(0)) }
      const base = chunkContext(events)
      const context: ChunkStreamingContext = {
        ...base,
        chunkStore: { ...base.chunkStore, load: () => Effect.fail(failure) },
      }

      expect(await Effect.runPromise(Effect.result(streaming.streamAround(context, 0, 0))))
        .toEqual(Result.fail(failure))
      expect(events).toEqual([])
      expect([...context.streamLoaded]).toEqual([])
      expect(counters).toEqual({ streamed: 0, dropped: 0 })
    })

    it('returns an unload failure and keeps the chunk resident for the next attempt', async () => {
      const events: Array<string> = []
      const counters = { streamed: 0, dropped: 0 }
      const streaming = await streamingFor(events, counters)
      const failure = new StorageError({ operation: 'put', key: 'chunk:5,5' })
      const base = chunkContext(events)
      const context: ChunkStreamingContext = {
        ...base,
        chunkStore: { ...base.chunkStore, unload: () => Effect.fail(failure) },
      }
      context.streamLoaded.add('0,0')
      context.streamLoaded.add('5,5')

      expect(await Effect.runPromise(Effect.result(streaming.streamAround(context, 0, 0))))
        .toEqual(Result.fail(failure))
      expect(events).toEqual(['snapshot:5,5', 'retain', 'dirty'])
      expect([...context.streamLoaded]).toEqual(['0,0', '5,5'])
      expect(counters).toEqual({ streamed: 0, dropped: 0 })
    })
  })
})

describe('chunk render attachment wiring', () => {
  // The wiring under test needs resident chunks to mesh, not terrain. Generating
  // real noise terrain for both dimensions made the re-entry test ~5x slower
  // under V8 coverage and time out, so the stores are fed empty chunks.
  const emptyChunkSource: ChunkSource = (coord) => Effect.succeed(chunk(coord.cx, coord.cz))
  const coords = (chunks: ReadonlyArray<{ readonly cx: number; readonly cz: number }>) =>
    chunks.map(({ cx, cz }) => `${String(cx)},${String(cz)}`)

  it.effect('throttles the ChunkStore dirty channel and reports loads, block writes and unloads', () =>
    Effect.gen(function* () {
      const store = yield* makeChunkStore(generatedChunkSource(NoiseSeed(1)), ChunkCapacity(16))
      const rendererStore = yield* budgetedRendererStore(store, 2)
      const subscription = yield* rendererStore.store.subscribeDirty
      // Far apart, so no load also dirties a resident neighbour.
      for (const cx of [0, 10, 20]) yield* store.load(chunkCoord(ChunkAxis(cx), ChunkAxis(0)))

      const first = yield* subscription.drain
      expect(coords(first.changed)).toEqual(['0,0', '10,0'])
      expect(first.removed).toEqual([])
      expect(coords((yield* subscription.drain).changed)).toEqual(['20,0'])
      expect(yield* subscription.drain).toEqual({ changed: [], removed: [] })

      yield* store.setBlock(
        blockPosition(BlockAxis(1), BlockAxis(70), BlockAxis(1)),
        Option.getOrThrow(blockIdOf('stone')),
      )
      expect(coords((yield* subscription.drain).changed)).toEqual(['0,0'])

      yield* store.unload(chunkCoord(ChunkAxis(10), ChunkAxis(0)))
      const unloaded = yield* subscription.drain
      expect(unloaded.changed).toEqual([])
      expect(coords(unloaded.removed)).toEqual(['10,0'])
    }))

  it.effect('rejects an invalid frame budget and releases the subscription it took', () =>
    Effect.gen(function* () {
      const store = yield* makeChunkStore(generatedChunkSource(NoiseSeed(1)), ChunkCapacity(16))
      const events: Array<string> = []
      const result = yield* Effect.result(budgetedRendererStore({
        ...store,
        subscribeDirty: Effect.map(store.subscribeDirty, (subscription) => ({
          ...subscription,
          unsubscribe: Effect.andThen(subscription.unsubscribe, Effect.sync(() => { events.push('unsubscribe') })),
        })),
      }, 0))

      expect(result).toEqual(Result.fail({ _tag: 'BudgetedDirtySourceInputError', reason: 'invalid-frame-budget' }))
      expect(events).toEqual(['unsubscribe'])
    }))

  const recordingAttachment = (
    name: string,
    events: Array<string>,
    pendingFaults: Array<ChunkRenderFault>,
  ): WorldRendererAttachment => ({
    update: Effect.sync(() => {
      events.push(`update:${name}`)
      return EMPTY_SYNC_REPORT
    }),
    drainFaults: Effect.sync(() => pendingFaults.splice(0)),
    detach: Effect.void,
    attached: Effect.succeed(true),
  })

  it.effect('meshes a re-entered dimension\'s resident chunks again after the renderer was cleared', () =>
    Effect.gen(function* () {
      class GpuSurface {
        render = vi.fn<() => void>()
        setSize = vi.fn<() => void>()
        setClearColor = vi.fn<() => void>()
        dispose = vi.fn<() => void>()
      }
      const renderer = yield* makeProductionWorldRenderer<
        object, THREE.BufferGeometry<THREE.NormalBufferAttributes>, THREE.MeshBasicMaterial,
        THREE.InstancedBufferGeometry, THREE.ShaderMaterial
      >({ ...THREE, WebGLRenderer: GpuSurface }, {}, { width: 64, height: 64 }, new THREE.Texture())
      const counters = { streamed: 0, dropped: 0 }
      const streaming = makeChunkStreaming({
        streamRadiusChunks: 1,
        // Overworld streaming always runs the village search, whose sampling
        // count depends on the seed; this test checks no villagers, so it uses
        // a seed with a short search (2880 surface samples against 8640 for 71).
        activeSeed: 2,
        canvas: { setAttribute: () => {} },
        coordinator: yield* makeWorldCommitCoordinator({
          world: WorldId('chunk-streaming-dimension-reentry'),
          owners: gameplayOwnerRegistrations(),
        }),
        villagerResidents: new Map(),
        saveCoordinator: { retainChunk: () => {} },
        getMarkSessionDirty: () => () => {},
        markRedstoneDirty: () => {},
        getChunksStreamedIn: () => counters.streamed,
        setChunksStreamedIn: (count) => { counters.streamed = count },
        getChunksDropped: () => counters.dropped,
        setChunksDropped: (count) => { counters.dropped = count },
      })
      // The same wiring as main.ts makeDimensionChunkContext: one real ChunkStore
      // and one budgeted attachment per dimension, sharing one WorldRenderer.
      const dimensionContext = (dimension: Dimension) =>
        Effect.gen(function* () {
          const store = yield* makeChunkStore(emptyChunkSource, ChunkCapacity(64))
          const rendererStore = yield* budgetedRendererStore(store, 4)
          const renderAttachment = yield* attachChunkStoreRenderer(renderer, rendererStore.store)
          return {
            dimension,
            chunkStore: store,
            worldgenChunkStore: store,
            streamLoaded: new Set<string>(),
            renderAttachment,
            enqueueRenderUpdate: rendererStore.enqueue,
          }
        })
      const overworld = yield* dimensionContext('overworld')
      const nether = yield* dimensionContext('nether')
      let active = overworld
      const chunkSync = activeDimensionChunkSync(() => active)
      const runFrames = Effect.gen(function* () {
        const reports: Array<number> = []
        for (let frame = 0; frame < 8; frame += 1) reports.push((yield* chunkSync.update).meshed)
        return reports
      })
      const rendered = Effect.map(renderer.chunkKeys, (keys) => [...keys].sort())
      const around = desiredChunksAround(1, 0, 0).map(chunkKeyOf).sort()

      yield* Effect.gen(function* () {
        yield* streaming.streamAround(overworld, 0, 0)
        yield* runFrames
        expect(yield* rendered).toEqual(around)

        // main.ts alignActiveDimension: switch the context, then show its chunks.
        active = nether
        yield* showDimensionChunks(renderer, nether)
        yield* streaming.streamAround(nether, 0, 0)
        yield* runFrames
        expect(yield* rendered).toEqual(around)

        active = overworld
        yield* showDimensionChunks(renderer, overworld)
        yield* streaming.streamAround(overworld, 0, 0)
        const reentryFrames = yield* runFrames

        expect([...overworld.streamLoaded].sort()).toEqual(around)
        // Nine resident chunks under a budget of four per frame.
        expect(reentryFrames).toEqual([4, 4, 1, 0, 0, 0, 0, 0])
        expect(yield* rendered).toEqual(around)
      }).pipe(Effect.ensuring(renderer.dispose))
    }))

  it.effect('updates only the active dimension attachment', () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const overworld = { renderAttachment: recordingAttachment('overworld', events, []) }
      const nether = { renderAttachment: recordingAttachment('nether', events, []) }
      let active = overworld
      const port = activeDimensionChunkSync(() => active)

      yield* port.update
      active = nether
      yield* port.update

      expect(events).toEqual(['update:overworld', 'update:nether'])
    }))

  it.effect('drains typed render faults from every dimension once as a ChunkRenderFailure', () =>
    Effect.gen(function* () {
      const fault = (cx: number): ChunkRenderFault => ({
        _tag: 'ChunkRenderFault',
        chunk: chunkCoord(ChunkAxis(cx), ChunkAxis(0)),
        error: { _tag: 'ChunkMeshGeometryInputFailure', field: 'fluids' },
        occurrences: 1,
      })
      const overworldFault = fault(1)
      const netherFault = fault(2)
      const contexts: Parameters<typeof drainChunkRenderFaults>[0] = [
        { dimension: 'overworld', renderAttachment: recordingAttachment('overworld', [], [overworldFault]) },
        { dimension: 'nether', renderAttachment: recordingAttachment('nether', [], [netherFault]) },
      ]

      const drained = yield* Effect.result(drainChunkRenderFaults(contexts))

      assert(Result.isFailure(drained))
      expect(drained.failure).toBeInstanceOf(ChunkRenderFailure)
      expect(drained.failure._tag).toBe('ChunkRenderFailure')
      expect(drained.failure.faults).toEqual([
        { dimension: 'overworld', fault: overworldFault },
        { dimension: 'nether', fault: netherFault },
      ])
      expect(yield* Effect.result(drainChunkRenderFaults(contexts))).toEqual(Result.succeed(undefined))
    }))
})
