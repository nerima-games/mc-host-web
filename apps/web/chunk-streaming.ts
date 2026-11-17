import { BlockAxis, ChunkAxis, chunkCoord } from '@nerima-games/mc-kernel'
import type { WorldCommitCoordinatorApi, WorldCommitCoordinatorError } from '@nerima-games/mc-sim'
import {
  chunkKeyOf,
  makeBudgetedDirtySource,
  type BudgetedDirtySource,
  type BudgetedDirtySourceInputError,
  type ChunkRef,
  type ChunkSyncPort,
  type RendererChunkStore,
  type WorldRenderer,
  type WorldRendererAttachment,
} from '@nerima-games/mc-render'
import {
  biomeFor,
  DEFAULT_TERRAIN_LEVELS,
  NoiseSeed,
  surfaceHeightAt,
  type ChunkStoreApi,
  type ChunkStoreError,
  type Dimension,
  villageVillagerSpawnsForChunk,
} from '@nerima-games/mc-worldgen'
import {
  addVillager,
  makeVillager,
  GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
  GameplayVillagerTradeSnapshotSchema,
} from '@nerima-games/mx-gameplay'
import { Data, Effect, Exit, Result } from 'effect'
import type { YieldableError } from 'effect/Cause'

import { snapshotResidentChunks, type PersistedVillager } from './session-persistence'
import type { SessionSaveCoordinator } from './session-save-coordinator'
import type { RenderLightingSnapshot } from './render-lighting'

export type ChunkStreamingContext<
  ChunkStore extends Pick<ChunkStoreApi, 'load' | 'unload'> = Pick<ChunkStoreApi, 'load' | 'unload'>,
  WorldgenChunkStore extends Pick<ChunkStoreApi, 'loadedCoords' | 'snapshot'> = Pick<
    ChunkStoreApi,
    'loadedCoords' | 'snapshot'
  >,
> = {
  readonly dimension: Dimension
  readonly chunkStore: ChunkStore
  readonly worldgenChunkStore: WorldgenChunkStore
  readonly streamLoaded: Set<string>
}

export type DimensionChunkContext = ChunkStreamingContext<ChunkStoreApi, ChunkStoreApi> & {
  /** mc-render's attachment to this dimension's ChunkStore; exactly one per store. */
  readonly renderAttachment: WorldRendererAttachment
  /** `enqueue` of the budgeted dirty source `renderAttachment` drains. */
  readonly enqueueRenderUpdate: BudgetedDirtySource['enqueue']
  readonly lightingSnapshot: () => RenderLightingSnapshot
}

export type ChunkStreamingDependencies = {
  readonly streamRadiusChunks: number
  readonly activeSeed: number
  readonly canvas: Pick<HTMLCanvasElement, 'setAttribute'>
  readonly coordinator: WorldCommitCoordinatorApi
  readonly villagerResidents: Map<string, PersistedVillager>
  readonly saveCoordinator: Pick<SessionSaveCoordinator, 'retainChunk'>
  readonly getMarkSessionDirty: () => () => void
  readonly markRedstoneDirty: () => void
  readonly getChunksStreamedIn: () => number
  readonly setChunksStreamedIn: (count: number) => void
  readonly getChunksDropped: () => number
  readonly setChunksDropped: (count: number) => void
}

// ChunkStoreError covers the unload's ChunkPersistenceError and the village
// spawn lookup's InvalidNaturalStructureCoordinate.
export type ChunkStreamingFailure = WorldCommitCoordinatorError | ChunkStoreError

export type ChunkStreamingRuntime = {
  readonly streamAround: (
    context: ChunkStreamingContext,
    x: number,
    z: number,
  ) => Effect.Effect<void, ChunkStreamingFailure>
  readonly retainDimensionResidents: (context: ChunkStreamingContext) => Effect.Effect<void>
}

/**
 * Which chunks should be resident around a world position.
 *
 * The world is unbounded horizontally, so every coordinate in the radius is
 * loadable and no fixture-edge filtering is needed.
 */
export const desiredChunksAround = (
  radius: number,
  x: number,
  z: number,
): ReadonlyArray<ChunkRef> => {
  const cx0 = Math.floor(x / 16)
  const cz0 = Math.floor(z / 16)
  const wanted: Array<ChunkRef> = []
  for (let cx = cx0 - radius; cx <= cx0 + radius; cx += 1) {
    for (let cz = cz0 - radius; cz <= cz0 + radius; cz += 1) {
      wanted.push(chunkCoord(ChunkAxis(cx), ChunkAxis(cz)))
    }
  }
  return wanted
}

export const makeChunkStreaming = (
  dependencies: ChunkStreamingDependencies,
): ChunkStreamingRuntime => {
  // initializeSessionWorld has already validated the seed returned to the host.
  const seed = Result.getOrThrow(NoiseSeed.result(dependencies.activeSeed))
  const streamAround = (
    context: ChunkStreamingContext,
    x: number,
    z: number,
  ): Effect.Effect<void, ChunkStreamingFailure> =>
    Effect.suspend(() => {
      let streamed = 0
      let dropped = 0
      return Effect.gen(function* () {
        const wanted = desiredChunksAround(dependencies.streamRadiusChunks, x, z)
        const wantedKeys = new Set<string>(wanted.map(chunkKeyOf))
        const changed = wanted.filter((chunk) => !context.streamLoaded.has(chunkKeyOf(chunk)))
        const removed = [...context.streamLoaded]
          .filter((key) => !wantedKeys.has(key))
          .map((key) => {
            const [cx, cz] = key.split(',')
            return chunkCoord(ChunkAxis(Number(cx)), ChunkAxis(Number(cz)))
          })

        for (const chunk of changed) {
          yield* context.chunkStore.load(chunkCoord(chunk.cx, chunk.cz))
          let discovered = false
          if (context.dimension === 'overworld') {
            const initial = yield* dependencies.coordinator.snapshot(
              GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
              GameplayVillagerTradeSnapshotSchema,
            )
            const spawns = yield* Effect.fromResult(villageVillagerSpawnsForChunk(
              seed,
              chunk.cx,
              chunk.cz,
              (x, z) => {
                const surfaceY = surfaceHeightAt(seed, x, z)
                return {
                  biome: biomeFor(seed, x, z, surfaceY, DEFAULT_TERRAIN_LEVELS),
                  surfaceY,
                  seaLevel: BlockAxis(DEFAULT_TERRAIN_LEVELS.seaLevel),
                }
              },
            ))
            for (const spawn of spawns) {
              if (!dependencies.villagerResidents.has(spawn.id)) {
                discovered = true
              }
              if (!initial.state.villagers.some((villager) => villager.id === spawn.id)) {
                discovered = true
              }
            }
            if (discovered) {
              yield* dependencies.coordinator.commitFromSnapshot(
                GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
                GameplayVillagerTradeSnapshotSchema,
                (snapshot) => Effect.sync(() => {
                  let trades = snapshot.state
                  // The coordinator serializes this builder with publication; preserve intervening trades.
                  for (const spawn of spawns) {
                    if (!trades.villagers.some((villager) => villager.id === spawn.id)) {
                      trades = addVillager(trades, makeVillager(spawn.id, spawn.profession))
                    }
                  }
                  return {
                    expectedRevision: snapshot.revision,
                    expectedDimensions: [],
                    changes: [{ ownerId: GAMEPLAY_VILLAGER_TRADES_OWNER_ID, state: trades }],
                  }
                }),
              )
              for (const spawn of spawns) {
                if (dependencies.villagerResidents.has(spawn.id)) continue
                dependencies.villagerResidents.set(spawn.id, {
                  id: spawn.id,
                  profession: spawn.profession,
                  dimension: 'overworld',
                  feetPosition: { x: spawn.x + 0.5, y: spawn.y, z: spawn.z + 0.5 },
                })
              }
            }
          }
          context.streamLoaded.add(chunkKeyOf(chunk))
          streamed += 1
          if (discovered) dependencies.getMarkSessionDirty()()
        }
        for (const chunk of removed) {
          const snapshot = yield* context.worldgenChunkStore.snapshot(chunkCoord(chunk.cx, chunk.cz))
          if (snapshot !== undefined) {
            dependencies.saveCoordinator.retainChunk({ dimension: context.dimension, chunk: snapshot })
            dependencies.getMarkSessionDirty()()
          }
          yield* context.chunkStore.unload(chunkCoord(chunk.cx, chunk.cz))
          context.streamLoaded.delete(chunkKeyOf(chunk))
          dropped += 1
        }
      }).pipe(Effect.onExit((exit) => Effect.sync(() => {
        if (Exit.isFailure(exit) && streamed === 0 && dropped === 0) return
        // Earlier chunks remain published when a later load or owner update fails or is interrupted.
        if (streamed > 0 || dropped > 0) dependencies.markRedstoneDirty()
        dependencies.setChunksStreamedIn(dependencies.getChunksStreamedIn() + streamed)
        dependencies.setChunksDropped(dependencies.getChunksDropped() + dropped)
        dependencies.canvas.setAttribute('data-chunks-meshed', String(context.streamLoaded.size))
        dependencies.canvas.setAttribute('data-chunks-streamed-in', String(dependencies.getChunksStreamedIn()))
        dependencies.canvas.setAttribute('data-chunks-dropped', String(dependencies.getChunksDropped()))
      })))
    })

  const retainDimensionResidents = (context: ChunkStreamingContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      const residents = yield* snapshotResidentChunks(context.worldgenChunkStore)
      for (const chunk of residents) {
        dependencies.saveCoordinator.retainChunk({ dimension: context.dimension, chunk })
      }
    })

  return { streamAround, retainDimensionResidents }
}

export const clearRenderedChunks = <Key extends string, KeyError, KeyRequirements, RemoveError, RemoveRequirements>(
  worldRenderer: {
    readonly chunkKeys: Effect.Effect<ReadonlyArray<Key>, KeyError, KeyRequirements>
    readonly removeChunk: (key: Key) => Effect.Effect<unknown, RemoveError, RemoveRequirements>
  },
): Effect.Effect<void, KeyError | RemoveError, KeyRequirements | RemoveRequirements> =>
  Effect.gen(function* () {
    const rendered = yield* worldRenderer.chunkKeys
    for (const key of rendered) yield* worldRenderer.removeChunk(key)
  })

/**
 * Show a dimension's chunks in the shared WorldRenderer after switching to it.
 *
 * Clearing removes the previous dimension's meshes. A dimension entered again
 * keeps its resident chunks, but its attachment drained their dirty entries
 * when it first meshed them and `streamAround` does not load a chunk it has
 * already streamed, so nothing marks them dirty again. Enqueueing the store's
 * resident chunks into the budgeted source makes the attachment mesh them
 * again, at most the frame budget per frame.
 */
export const showDimensionChunks = (
  worldRenderer: Pick<WorldRenderer, 'chunkKeys' | 'removeChunk'>,
  context: Pick<DimensionChunkContext, 'worldgenChunkStore' | 'enqueueRenderUpdate'>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* clearRenderedChunks(worldRenderer)
    context.enqueueRenderUpdate({ changed: yield* context.worldgenChunkStore.loadedCoords, removed: [] })
  })

export type BudgetedRendererStore = {
  readonly store: RendererChunkStore
  readonly enqueue: BudgetedDirtySource['enqueue']
}

/**
 * The store `attachChunkStoreRenderer` reads, with the dirty channel throttled
 * by mc-render's `makeBudgetedDirtySource` so one storm of edits does not
 * remesh every dirtied chunk in the same frame, and that source's `enqueue`.
 *
 * The subscription is taken here, once: `attachWorldRenderer` reads
 * `subscribeDirty` exactly once per attachment, so the returned store is meant
 * for a single `attachChunkStoreRenderer` call.
 */
export const budgetedRendererStore = (
  store: RendererChunkStore,
  maxUpdatesPerFrame: number,
): Effect.Effect<BudgetedRendererStore, BudgetedDirtySourceInputError> =>
  Effect.gen(function* () {
    const subscription = yield* store.subscribeDirty
    const budgeted = yield* Effect.fromResult(makeBudgetedDirtySource(subscription, maxUpdatesPerFrame)).pipe(
      Effect.onError(() => subscription.unsubscribe),
    )
    return {
      store: {
        peek: store.peek,
        neighbours: store.neighbours,
        getLight: store.getLight,
        subscribeDirty: Effect.succeed({ drain: budgeted.drain, unsubscribe: subscription.unsubscribe }),
      },
      enqueue: budgeted.enqueue,
    }
  })

/**
 * The port mc-render's `render:chunk-sync` stage calls once per frame. Only
 * the active dimension's attachment is updated; an inactive dimension's
 * subscription keeps coalescing its dirty set until it is active again.
 */
export const activeDimensionChunkSync = (
  active: () => Pick<DimensionChunkContext, 'renderAttachment'>,
): ChunkSyncPort => ({
  update: Effect.suspend(() => active().renderAttachment.update),
})

export type ChunkRenderFault = Effect.Success<WorldRendererAttachment['drainFaults']>[number]

type ChunkRenderFailureFields = {
  readonly faults: ReadonlyArray<{ readonly dimension: Dimension; readonly fault: ChunkRenderFault }>
}

/** Typed meshing faults mc-render recorded while `render:chunk-sync` ran. */
export type ChunkRenderFailure = YieldableError &
  ChunkRenderFailureFields & { readonly _tag: 'ChunkRenderFailure' }

export const ChunkRenderFailure: new (fields: ChunkRenderFailureFields) => ChunkRenderFailure =
  Data.TaggedError('ChunkRenderFailure')

/**
 * The stage's error channel is `never`, so mc-render queues meshing faults on
 * the attachment instead of failing the frame. Draining every dimension (not
 * only the active one) reports a fault recorded just before a dimension switch.
 */
export const drainChunkRenderFaults = (
  contexts: ReadonlyArray<Pick<DimensionChunkContext, 'dimension' | 'renderAttachment'>>,
): Effect.Effect<void, ChunkRenderFailure> =>
  Effect.gen(function* () {
    const faults: Array<ChunkRenderFailureFields['faults'][number]> = []
    for (const context of contexts) {
      for (const fault of yield* context.renderAttachment.drainFaults) {
        faults.push({ dimension: context.dimension, fault })
      }
    }
    if (faults.length > 0) return yield* Effect.fail(new ChunkRenderFailure({ faults }))
  })
