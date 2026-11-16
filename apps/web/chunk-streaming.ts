import { BlockAxis, ChunkAxis, chunkCoord } from '@nerima-games/mc-kernel'
import type { WorldCommitCoordinatorApi, WorldCommitCoordinatorError } from '@nerima-games/mc-sim'
import { chunkKeyOf, type ChunkRef, syncWorld } from '@nerima-games/mc-render'
import {
  biomeFor,
  DEFAULT_TERRAIN_LEVELS,
  NoiseSeed,
  surfaceHeightAt,
  type ChunkStoreApi,
  type Dimension,
  type InvalidNaturalStructureCoordinate,
  villageVillagerSpawnsForChunk,
} from '@nerima-games/mc-worldgen'
import {
  addVillager,
  makeVillager,
  GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
  GameplayVillagerTradeSnapshotSchema,
} from '@nerima-games/mx-gameplay'
import { Effect, Exit, Result } from 'effect'

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
  readonly queueLoadedChunk: (chunk: { cx: number; cz: number }) => void
  readonly streamLoaded: Set<string>
}

export type DimensionChunkContext = ChunkStreamingContext<ChunkStoreApi, ChunkStoreApi> & {
  readonly dirtyChunks: Parameters<typeof syncWorld>[1]
  readonly meshChunkFromStore: Parameters<typeof syncWorld>[2]
  readonly colorForChunk: NonNullable<NonNullable<Parameters<typeof syncWorld>[3]>['colorForChunk']>
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

export type ChunkStreamingRuntime = {
  readonly streamAround: (
    context: ChunkStreamingContext,
    x: number,
    z: number,
  ) => Effect.Effect<void, WorldCommitCoordinatorError | InvalidNaturalStructureCoordinate>
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
  ): Effect.Effect<void, WorldCommitCoordinatorError | InvalidNaturalStructureCoordinate> =>
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
          yield* context.chunkStore.load(chunkCoord(chunk.cx, chunk.cz)).pipe(Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: () => Effect.void,
          }))
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
          context.queueLoadedChunk(chunk)
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
          yield* context.chunkStore.unload(chunkCoord(chunk.cx, chunk.cz)).pipe(Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: () => Effect.void,
          }))
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
