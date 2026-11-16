import { Data, Effect, Option, Result, Schema } from 'effect'
import { blockIdOf, ChunkAxis, chunkCoord, type ChunkCoord } from '@nerima-games/mc-kernel'
import {
  chunkSnapshotOf,
  CHUNK_FORMAT,
  generatedDimensionChunkSource,
  makeChunkStore,
  ChunkCapacity,
  CHUNK_HEIGHT,
  CHUNK_SIZE_XZ,
  blockIndex,
  type Chunk,
  type ChunkStoreError,
  type InvalidNaturalStructureCoordinate,
  type InvalidTerrainLevels,
  type NoiseSeed,
  type ChunkWithBlockStates,
  type ChunkSource,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import { PlayerServiceSnapshotSchema, type PlayerPose, type PlayerStorage } from '@nerima-games/mc-sim'
import type { GameplayOwnerInitialState, MobRoster, PlayerVitals } from '@nerima-games/mx-gameplay'

import { poseOfPlayerOwner } from './owner-backed-services'
import type { DimensionChunk, OpenedSession, SessionOpenError, SessionState } from './session-persistence'

/** What the owners hold before anything is loaded: the generated world's own state. */
export type GeneratedOwnerState = Readonly<{
  pose: PlayerPose
  dimension: Dimension
  storage: PlayerStorage
  vitals: PlayerVitals
}>

/**
 * The initial state of the owners the host reads through its views. A loaded
 * session seeds them with its saved values; a new one with the generated
 * world's spawn, storage and vitals, since mx-gameplay's no-argument
 * registrations would start the player at the origin rather than on the
 * generated surface. The entity roster is the one `initializeSessionWorld`
 * merged from every saved dimension (empty for a new session).
 *
 * The saved pose is plain numbers, so it is decoded with the player owner's
 * schema rather than asserted to be a `PlayerPose`.
 */
export const gameplayOwnerInitialState = (
  loaded: Pick<SessionState, 'dimension' | 'player' | 'storage' | 'vitals' | 'villagers' | 'brewing' | 'statusEffects' | 'crops'> | undefined,
  generated: GeneratedOwnerState,
  entities: MobRoster,
): Result.Result<GameplayOwnerInitialState, Schema.SchemaError> => {
  if (loaded === undefined) {
    return Result.succeed({
      playerPose: generated.pose,
      dimension: generated.dimension,
      playerStorage: generated.storage,
      vitals: generated.vitals,
      entities,
      droppedItems: { items: [] },
    })
  }
  return Result.map(
    Schema.decodeUnknownResult(PlayerServiceSnapshotSchema)({
      pose: {
        feetPosition: { dimension: loaded.dimension, ...loaded.player.feetPosition },
        yawRadians: loaded.player.yawRadians,
        pitchRadians: loaded.player.pitchRadians,
      },
    }),
    (player) => ({
      playerPose: poseOfPlayerOwner(player),
      dimension: player.pose.feetPosition.dimension,
      playerStorage: loaded.storage,
      vitals: loaded.vitals,
      entities,
      droppedItems: { items: [] },
      villagerTrades: loaded.villagers.trades,
      brewing: loaded.brewing,
      statusEffects: loaded.statusEffects,
      crops: loaded.crops,
    }),
  )
}

export type InitialWorldRestoreActions<State> = {
  readonly restoreContainerStorage: (state: State) => Promise<unknown>
  readonly addCreativeStartingItems: () => Promise<unknown>
}

/**
 * The parts of the initial world that are not owner state. The player, its
 * storage, vitals and entities start in the owners
 * (`gameplayOwnerInitialState`), so only the local container storage is
 * restored here, and the creative starter items go through the inventory view.
 */
export const restoreInitialWorld = async <State>(
  state: State | undefined,
  isCreativeMode: boolean,
  actions: InitialWorldRestoreActions<State>,
): Promise<void> => {
  if (state !== undefined) {
    await actions.restoreContainerStorage(state)
  } else if (isCreativeMode) {
    await actions.addCreativeStartingItems()
  }
}

export type LoadedSessionServiceRestoreActions<State> = {
  readonly restoreTime: (state: State) => Promise<unknown>
  readonly restoreWeather: (state: State) => Promise<unknown>
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
  await actions.restoreStatusEffects(state)
  await actions.restoreEnderDragon(state)
}

export const makeSessionChunkSourceFor = (
  dimension: Dimension,
  persistedChunks: ReadonlyMap<string, ChunkWithBlockStates>,
  generatedSource: ChunkSource,
): ChunkSource => (coord) => {
  const persisted = persistedChunks.get(
    `${dimension}:${String(coord.cx)},${String(coord.cz)}`,
  )
  return persisted === undefined
    ? generatedSource(coord)
    : Effect.sync(() => chunkSnapshotOf(persisted))
}

export type SessionTerrainRestorationFailure =
  | Schema.SchemaError
  | InvalidNaturalStructureCoordinate
  | InvalidTerrainLevels
  | ChunkStoreError

export type SessionTerrainSources = Readonly<Record<Dimension, ChunkSource>>

export const makeSessionTerrainSources = (seed: NoiseSeed): SessionTerrainSources => ({
  overworld: generatedDimensionChunkSource(seed, 'overworld'),
  nether: generatedDimensionChunkSource(seed, 'nether'),
  end: generatedDimensionChunkSource(seed, 'end'),
})

const materializeTerrain = (generated: Chunk): Effect.Effect<ChunkWithBlockStates, ChunkStoreError> =>
  Effect.gen(function* () {
    const store = yield* makeChunkStore(() => Effect.succeed(generated), ChunkCapacity(1))
    yield* store.load(generated.coord)
    // This private one-chunk store has just loaded this coordinate and cannot evict it.
    const snapshot = Option.getOrThrow(Option.fromUndefinedOr(yield* store.snapshot(generated.coord)))
    return { ...generated, ...snapshot }
  })

export const restoreDimensionTerrain = (
  sources: SessionTerrainSources,
  savedChunks: ReadonlyArray<DimensionChunk>,
): Effect.Effect<{
  readonly chunks: ReadonlyArray<DimensionChunk>
  readonly rebuiltChunks: ReadonlyArray<DimensionChunk>
}, SessionTerrainRestorationFailure> => Effect.gen(function* () {
  const chunks: Array<DimensionChunk> = []
  const rebuiltChunks: Array<DimensionChunk> = []
  const legacyByCoord = new Map<string, Schema.Codec.Encoded<typeof CHUNK_FORMAT.schema>>()
  for (const saved of savedChunks) {
    if (saved.dimension === 'overworld') {
      chunks.push(saved)
      continue
    }
    // Encode for comparison; persisted records have already passed loadFrom's validation.
    const encoded = yield* Effect.fromResult(Schema.encodeResult(CHUNK_FORMAT.schema)(saved.chunk))
    const key = `${String(saved.chunk.coord.cx)},${String(saved.chunk.coord.cz)}`
    let encodedLegacy = legacyByCoord.get(key)
    if (encodedLegacy === undefined) {
      const legacy = yield* sources.overworld(saved.chunk.coord)
      // Session saves and loads project these fields, dropping generation-only markers.
      // Encode this projection directly; decoding and re-encoding repeats full-buffer validation.
      encodedLegacy = yield* Effect.fromResult(Schema.encodeUnknownResult(CHUNK_FORMAT.schema)({
        coord: legacy.coord,
        blocks: legacy.blocks,
        blockStates: legacy.blockStates,
        biomes: legacy.biomes,
      }))
      legacyByCoord.set(key, encodedLegacy)
    }
    if (JSON.stringify(encoded) !== JSON.stringify(encodedLegacy)) {
      chunks.push(saved)
      continue
    }
    const generated = yield* sources[saved.dimension](saved.chunk.coord)
    const chunk = yield* materializeTerrain(generated)
    const rebuilt = { dimension: saved.dimension, chunk }
    chunks.push(rebuilt)
    rebuiltChunks.push(rebuilt)
  }
  return { chunks, rebuiltChunks }
})

type SessionTerrainMigrationUnsafePositionFields = {
  readonly dimension: Dimension
  readonly coord: ChunkCoord
}
export const SessionTerrainMigrationUnsafePosition: new (
  fields: SessionTerrainMigrationUnsafePositionFields,
) => Error & { readonly _tag: 'SessionTerrainMigrationUnsafePosition' } & SessionTerrainMigrationUnsafePositionFields =
  Data.TaggedError('SessionTerrainMigrationUnsafePosition')<SessionTerrainMigrationUnsafePositionFields>

const terrainChunkKey = (dimension: string, at: { readonly x: number; readonly z: number }): string =>
  `${dimension}:${String(Math.floor(at.x / CHUNK_SIZE_XZ))},${String(Math.floor(at.z / CHUNK_SIZE_XZ))}`

const safeTerrainPosition = (chunk: ChunkWithBlockStates): SessionState['player']['feetPosition'] | undefined => {
  // These fixed registry entries are full, non-hazardous terrain blocks; air is the only accepted body cell.
  const air = Option.getOrThrow(blockIdOf('air'))
  const floors = new Set<number>([
    Option.getOrThrow(blockIdOf('stone')),
    Option.getOrThrow(blockIdOf('netherrack')),
    Option.getOrThrow(blockIdOf('end_stone')),
    Option.getOrThrow(blockIdOf('obsidian')),
  ])
  for (let y = CHUNK_HEIGHT - 3; y >= 0; y -= 1) {
    for (let x = 1; x < CHUNK_SIZE_XZ - 1; x += 1) {
      for (let z = 1; z < CHUNK_SIZE_XZ - 1; z += 1) {
        const floor = chunk.blocks[blockIndex(x, y, z)]
        if (floor === undefined || !floors.has(floor)) continue
        let clear = true
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            if (chunk.blocks[blockIndex(x + dx, y + 1, z + dz)] !== air
              || chunk.blocks[blockIndex(x + dx, y + 2, z + dz)] !== air) clear = false
          }
        }
        if (clear) return {
          x: chunk.coord.cx * CHUNK_SIZE_XZ + x + 0.5,
          y: y + 1,
          z: chunk.coord.cz * CHUNK_SIZE_XZ + z + 0.5,
        }
      }
    }
  }
  return undefined
}

export const reconcileTerrainMigrationState = (
  state: SessionState,
  terrain: { readonly chunks: ReadonlyArray<DimensionChunk>; readonly rebuiltChunks: ReadonlyArray<DimensionChunk> },
  sources: SessionTerrainSources,
): Effect.Effect<{
  readonly state: SessionState
  readonly chunks: ReadonlyArray<DimensionChunk>
}, SessionTerrainRestorationFailure | InstanceType<typeof SessionTerrainMigrationUnsafePosition>> => Effect.gen(function* () {
  const chunks = [...terrain.chunks]
  const rebuiltKeys = new Set(terrain.rebuiltChunks.map(({ dimension, chunk }) =>
    `${dimension}:${String(chunk.coord.cx)},${String(chunk.coord.cz)}`))
  const affected = (dimension: string, at: { readonly x: number; readonly z: number }): boolean =>
    rebuiltKeys.has(terrainChunkKey(dimension, at))
  let player = state.player
  if (affected(state.dimension, player.feetPosition)) {
    const replaced = terrain.rebuiltChunks.find(({ dimension, chunk }) =>
      dimension === state.dimension
        && terrainChunkKey(dimension, player.feetPosition) === `${dimension}:${String(chunk.coord.cx)},${String(chunk.coord.cz)}`)
    // affected() proves that this coordinate occurs in the replacement list.
    const replacedChunk = Option.getOrThrow(Option.fromUndefinedOr(replaced)).chunk
    let landing = safeTerrainPosition(replacedChunk)
    if (landing === undefined) {
      const centerCoord = chunkCoord(ChunkAxis(0), ChunkAxis(0))
      let center = chunks.find(({ dimension, chunk }) =>
        dimension === state.dimension && chunk.coord.cx === 0 && chunk.coord.cz === 0)?.chunk
      if (center === undefined) {
        center = yield* materializeTerrain(yield* sources[state.dimension](centerCoord))
        chunks.push({ dimension: state.dimension, chunk: center })
      }
      landing = safeTerrainPosition(center)
    }
    if (landing === undefined) return yield* Effect.fail(new SessionTerrainMigrationUnsafePosition({
      dimension: state.dimension,
      coord: replacedChunk.coord,
    }))
    player = { ...player, feetPosition: landing }
  }
  const entities = (dimension: Dimension): SessionState['entities'][Dimension] => ({
    ...state.entities[dimension],
    entities: state.entities[dimension].entities.filter((entity) => !affected(dimension, entity.feetPosition)),
  })
  const vehicles = state.vehicles?.filter((vehicle) => !affected(vehicle.dimension, vehicle.position))
  const removedVehicleIds = new Set<string>(state.vehicles?.filter((vehicle) => affected(vehicle.dimension, vehicle.position)).map(({ id }) => id))
  const removedResidentIds = new Set(state.villagers.residents.filter((resident) => affected(resident.dimension, resident.feetPosition)).map(({ id }) => id))
  const wither = state.wither === undefined ? undefined : {
    ...state.wither,
    withers: state.wither.withers.filter((wither) => !affected(wither.dimension, wither.snapshot.state.feetPosition)),
    skulls: state.wither.skulls.filter((skull) => !affected(skull.dimension, skull.position)),
  }
  return {
    chunks,
    state: {
      ...state,
      player,
      entities: { overworld: entities('overworld'), nether: entities('nether'), end: entities('end') },
      villagers: {
        ...state.villagers,
        residents: state.villagers.residents.filter((resident) => !affected(resident.dimension, resident.feetPosition)),
        trades: {
          ...state.villagers.trades,
          villagers: state.villagers.trades.villagers.filter(({ id }) => !removedResidentIds.has(id)),
        },
      },
      ...(vehicles === undefined ? {} : { vehicles }),
      ...(state.mountedVehicleId != null && removedVehicleIds.has(state.mountedVehicleId) ? { mountedVehicleId: null } : {}),
      ...(wither === undefined ? {} : { wither }),
    },
  }
})

export const SESSION_CHECKPOINT_OPENED_MESSAGE =
  'The latest save could not be read. The previous save was opened instead.'
export const SESSION_FUTURE_VERSION_MESSAGE = 'This world was saved by a newer version and cannot be opened.'
export const SESSION_UNSUPPORTED_VERSION_MESSAGE =
  'This world was saved by an older version that can no longer be opened.'
export const SESSION_CORRUPT_MESSAGE = 'This world could not be read, and no earlier save of it could be opened.'
export const SESSION_STORAGE_FAILURE_MESSAGE = 'Saved worlds could not be read from or updated in browser storage.'

/** What the player is told after a session opened; `None` when the latest save opened. */
export const sessionOpenNotice = (opened: OpenedSession): Option.Option<string> =>
  opened._tag === 'Checkpoint' ? Option.some(SESSION_CHECKPOINT_OPENED_MESSAGE) : Option.none()

/** The `loadError` query value the game sends the title screen when a session cannot be opened. */
export type SessionLoadError =
  | 'future-version-session'
  | 'unsupported-version-session'
  | 'corrupt-session'
  | 'session-storage-failure'
  | 'terrain-migration-session'

export const sessionLoadErrorOf = (error: SessionOpenError): SessionLoadError => {
  switch (error._tag) {
    case 'SessionIncompatibleError':
      return error.reason === 'future-version' ? 'future-version-session' : 'unsupported-version-session'
    case 'SessionCorruptError':
      return 'corrupt-session'
    case 'StorageError':
      return 'session-storage-failure'
    default:
      return 'terrain-migration-session'
  }
}

const SESSION_LOAD_ERROR_MESSAGES: Readonly<Record<SessionLoadError, string>> = {
  'future-version-session': SESSION_FUTURE_VERSION_MESSAGE,
  'unsupported-version-session': SESSION_UNSUPPORTED_VERSION_MESSAGE,
  'corrupt-session': SESSION_CORRUPT_MESSAGE,
  'session-storage-failure': SESSION_STORAGE_FAILURE_MESSAGE,
  'terrain-migration-session': 'Saved terrain could not be migrated.',
}

export const sessionOpenFailureMessage = (error: SessionOpenError): string =>
  SESSION_LOAD_ERROR_MESSAGES[sessionLoadErrorOf(error)]

const isSessionLoadError = (value: string): value is SessionLoadError =>
  Object.hasOwn(SESSION_LOAD_ERROR_MESSAGES, value)

/** The message for a `loadError` query value; `None` for a value this module did not produce. */
export const sessionLoadErrorMessage = (value: string | null): Option.Option<string> =>
  value !== null && isSessionLoadError(value) ? Option.some(SESSION_LOAD_ERROR_MESSAGES[value]) : Option.none()
