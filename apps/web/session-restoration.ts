import { Effect } from 'effect'
import {
  chunkSnapshotOf,
  type Chunk,
  type ChunkWithBlockStates,
  type ChunkSource,
  type Dimension,
} from '@nerima-games/mc-worldgen'

export type InitialWorldRestoreActions<State> = {
  readonly restoreEntities: () => Promise<unknown>
  readonly restoreStorage: (state: State) => Promise<unknown>
  readonly restoreContainerStorage: (state: State) => Promise<unknown>
  readonly restorePlayer: (state: State) => Promise<unknown>
  readonly restoreVitals: (state: State) => Promise<unknown>
  readonly addCreativeStartingItems: () => Promise<unknown>
}

export const restoreInitialWorld = async <State>(
  state: State | undefined,
  isCreativeMode: boolean,
  actions: InitialWorldRestoreActions<State>,
): Promise<void> => {
  if (state !== undefined) {
    await actions.restoreEntities()
    await actions.restoreStorage(state)
    await actions.restoreContainerStorage(state)
    await actions.restorePlayer(state)
    await actions.restoreVitals(state)
  } else if (isCreativeMode) {
    await actions.addCreativeStartingItems()
  }
}

export type LoadedSessionServiceRestoreActions<State> = {
  readonly restoreTime: (state: State) => Promise<unknown>
  readonly restoreWeather: (state: State) => Promise<unknown>
  readonly restoreCrops: (state: State) => Promise<unknown>
  readonly restoreVillagerTrades: (state: State) => Promise<unknown>
  readonly restoreBrewingStand: (state: State) => Promise<unknown>
  readonly restoreStatusEffects: (state: State) => Promise<unknown>
  readonly restoreEnderDragon: (state: State) => Promise<unknown>
}

export const restoreLoadedSessionServices = async <State>(
  state: State | undefined,
  actions: LoadedSessionServiceRestoreActions<State>,
): Promise<void> => {
  if (state === undefined) return

  await actions.restoreTime(state)
  await actions.restoreWeather(state)
  await actions.restoreCrops(state)
  await actions.restoreVillagerTrades(state)
  await actions.restoreBrewingStand(state)
  await actions.restoreStatusEffects(state)
  await actions.restoreEnderDragon(state)
}

export const requireSessionChunkBlockStates = (chunk: Chunk): ChunkWithBlockStates => {
  // CHUNK_FORMAT decode (including v2 migration) and resident snapshots materialize states.
  // session-persistence widens those values to Chunk, so enforce that invariant here.
  if (chunk.blockStates === undefined) throw new Error('Session chunk has no block states')
  return { ...chunk, blockStates: chunk.blockStates }
}

export const makeSessionChunkSourceFor = (
  dimension: Dimension,
  persistedChunks: ReadonlyMap<string, Chunk>,
  generatedSource: ChunkSource,
): ChunkSource => (coord) => {
  const persisted = persistedChunks.get(
    `${dimension}:${String(coord.cx)},${String(coord.cz)}`,
  )
  return persisted === undefined
    ? generatedSource(coord)
    : Effect.sync(() => chunkSnapshotOf(requireSessionChunkBlockStates(persisted)))
}
