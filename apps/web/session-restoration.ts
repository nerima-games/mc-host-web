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
import { containerIdAt, PlayerServiceSnapshotSchema, type PlayerPose, type PlayerStorage } from '@nerima-games/mc-sim'
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
  protectedChunks: ReadonlySet<string> = new Set(),
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
    if (protectedChunks.has(`${saved.dimension}:${String(saved.chunk.coord.cx)},${String(saved.chunk.coord.cz)}`)) {
      chunks.push(saved)
      continue
    }
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

export const protectedTerrainChunks = (state: SessionState, chunks: ReadonlyArray<DimensionChunk>): ReadonlySet<string> => {
  const keys = new Set<string>()
  const protect = (dimension: string, at: { readonly x: number; readonly z: number }): void => { keys.add(terrainChunkKey(dimension, at)) }
  let unlocated = state.brewing.bottles.some((slot) => slot !== undefined)
    || state.brewing.ingredient !== undefined || state.brewing.fuel !== undefined
    || state.brewing.fuelCharges !== 0 || state.brewing.brewProgressSecs !== 0
  for (const dimension of ['overworld', 'nether', 'end'] satisfies ReadonlyArray<Dimension>) {
    for (const entity of state.entities[dimension].entities) {
      if (entity.kind === 'dropped_item' || entity.kind === 'experience_orb') protect(dimension, entity.feetPosition)
    }
  }
  for (const vehicle of state.vehicles ?? []) protect(vehicle.dimension, vehicle.position)
  if (state.vehicles?.some(({ id }) => id === state.mountedVehicleId)) protect(state.dimension, state.player.feetPosition)
  for (const container of state.containerStorage.containers) {
    // The host writes containerIdAt(dimension, position); public ContainerId also permits non-spatial IDs.
    const match = /^(overworld|nether|end):(-?\d+),(-?\d+),(-?\d+)$/u.exec(container.id)
    if (match === null) { unlocated = true; continue }
    const dimension = match[1]!
    const at = { x: Number(match[2]), y: Number(match[3]), z: Number(match[4]) }
    if (!Number.isSafeInteger(at.x) || !Number.isSafeInteger(at.y) || !Number.isSafeInteger(at.z)
      || containerIdAt(dimension, at) !== container.id) { unlocated = true; continue }
    protect(dimension, at)
  }
  for (const furnace of state.furnaces) protect(furnace.dimension, furnace.position)
  for (const lever of state.redstone.levers) protect(lever.dimension, lever.position)
  for (const portal of state.portals) protect(portal.dimension, portal.position)
  for (const crop of state.crops.crops) protect(crop.dimension, crop.position)
  for (const resident of state.villagers.residents) protect(resident.dimension, resident.feetPosition)
  for (const frame of state.end.frames) protect('end', frame.position)
  if (unlocated) for (const { dimension, chunk } of chunks) keys.add(`${dimension}:${String(chunk.coord.cx)},${String(chunk.coord.cz)}`)
  return keys
}

const safeTerrainPosition = (chunk: ChunkWithBlockStates, original: SessionState['player']['feetPosition']): SessionState['player']['feetPosition'] | undefined => {
  // These fixed registry entries are full, non-hazardous terrain blocks; air is the only accepted body cell.
  const air = Option.getOrThrow(blockIdOf('air'))
  const floors = new Set<number>([
    Option.getOrThrow(blockIdOf('stone')),
    Option.getOrThrow(blockIdOf('netherrack')),
    Option.getOrThrow(blockIdOf('end_stone')),
    Option.getOrThrow(blockIdOf('obsidian')),
  ])
  const heights = Array.from({ length: CHUNK_HEIGHT - 2 }, (_, y) => y)
    .sort((a, b) => Math.abs(a + 1 - original.y) - Math.abs(b + 1 - original.y) || a - b)
  const columns = Array.from({ length: (CHUNK_SIZE_XZ - 2) ** 2 }, (_, index) => ({
    x: 1 + Math.floor(index / (CHUNK_SIZE_XZ - 2)), z: 1 + index % (CHUNK_SIZE_XZ - 2),
  })).sort((a, b) => {
    const distance = (at: { readonly x: number; readonly z: number }): number =>
      (chunk.coord.cx * CHUNK_SIZE_XZ + at.x + 0.5 - original.x) ** 2
      + (chunk.coord.cz * CHUNK_SIZE_XZ + at.z + 0.5 - original.z) ** 2
    return distance(a) - distance(b) || a.x - b.x || a.z - b.z
  })
  for (const y of heights) {
    for (const { x, z } of columns) {
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
    let landing = safeTerrainPosition(replacedChunk, player.feetPosition)
    if (landing === undefined) {
      const offsets = [{ x: -1, z: 0 }, { x: 0, z: -1 }, { x: 0, z: 1 }, { x: 1, z: 0 },
        { x: -1, z: -1 }, { x: -1, z: 1 }, { x: 1, z: -1 }, { x: 1, z: 1 }]
      for (const offset of offsets) {
        const coord = chunkCoord(ChunkAxis(replacedChunk.coord.cx + offset.x), ChunkAxis(replacedChunk.coord.cz + offset.z))
        const saved = chunks.find(({ dimension, chunk }) => dimension === state.dimension
          && chunk.coord.cx === coord.cx && chunk.coord.cz === coord.cz)
        const nearby = saved?.chunk ?? (yield* materializeTerrain(yield* sources[state.dimension](coord)))
        landing = safeTerrainPosition(nearby, player.feetPosition)
        if (landing !== undefined) {
          if (saved === undefined) chunks.push({ dimension: state.dimension, chunk: nearby })
          break
        }
      }
    }
    if (landing === undefined) return yield* Effect.fail(new SessionTerrainMigrationUnsafePosition({
      dimension: state.dimension,
      coord: replacedChunk.coord,
    }))
    player = { ...player, feetPosition: landing }
  }
  const entities = (dimension: Dimension): SessionState['entities'][Dimension] => ({
    ...state.entities[dimension],
    entities: state.entities[dimension].entities.filter((entity) => entity.kind === 'dropped_item'
      || entity.kind === 'experience_orb' || !affected(dimension, entity.feetPosition)),
  })
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
    case 'SaveDecodeError':
    case 'SessionManifestError':
    case 'ChunkIntegrityFailure':
      return 'corrupt-session'
    case 'StorageError':
      return 'session-storage-failure'
    case 'SessionTerrainMigrationUnsafePosition':
    case 'SchemaError':
    case 'InvalidNaturalStructureCoordinate':
    case 'InvalidTerrainLevels':
    case 'TerrainDensityFailure':
    case 'UnsupportedBiomeCategory':
    case 'BlockStateCodecFailure':
    case 'DirtyChunkEvictionError':
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
