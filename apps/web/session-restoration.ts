import { Effect, Option, Result, Schema } from 'effect'
import {
  chunkSnapshotOf,
  type ChunkWithBlockStates,
  type ChunkSource,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import { PlayerServiceSnapshotSchema, type PlayerPose, type PlayerStorage } from '@nerima-games/mc-sim'
import type { GameplayOwnerInitialState, MobRoster, PlayerVitals } from '@nerima-games/mx-gameplay'

import { poseOfPlayerOwner } from './owner-backed-services'
import type { OpenedSession, SessionOpenError, SessionState } from './session-persistence'

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

export const SESSION_CHECKPOINT_OPENED_MESSAGE =
  'The latest save could not be read. The previous save was opened instead.'
export const SESSION_FUTURE_VERSION_MESSAGE = 'This world was saved by a newer version and cannot be opened.'
export const SESSION_UNSUPPORTED_VERSION_MESSAGE =
  'This world was saved by an older version that can no longer be opened.'
export const SESSION_CORRUPT_MESSAGE = 'This world could not be read, and no earlier save of it could be opened.'
export const SESSION_STORAGE_FAILURE_MESSAGE = 'Saved worlds could not be read from browser storage.'

/** What the player is told after a session opened; `None` when the latest save opened. */
export const sessionOpenNotice = (opened: OpenedSession): Option.Option<string> =>
  opened._tag === 'Checkpoint' ? Option.some(SESSION_CHECKPOINT_OPENED_MESSAGE) : Option.none()

/** The `loadError` query value the game sends the title screen when a session cannot be opened. */
export type SessionLoadError =
  | 'future-version-session'
  | 'unsupported-version-session'
  | 'corrupt-session'
  | 'session-storage-failure'

export const sessionLoadErrorOf = (error: SessionOpenError): SessionLoadError => {
  switch (error._tag) {
    case 'SessionIncompatibleError':
      return error.reason === 'future-version' ? 'future-version-session' : 'unsupported-version-session'
    case 'SessionCorruptError':
      return 'corrupt-session'
    case 'StorageError':
      return 'session-storage-failure'
  }
}

const SESSION_LOAD_ERROR_MESSAGES: Readonly<Record<SessionLoadError, string>> = {
  'future-version-session': SESSION_FUTURE_VERSION_MESSAGE,
  'unsupported-version-session': SESSION_UNSUPPORTED_VERSION_MESSAGE,
  'corrupt-session': SESSION_CORRUPT_MESSAGE,
  'session-storage-failure': SESSION_STORAGE_FAILURE_MESSAGE,
}

export const sessionOpenFailureMessage = (error: SessionOpenError): string =>
  SESSION_LOAD_ERROR_MESSAGES[sessionLoadErrorOf(error)]

const isSessionLoadError = (value: string): value is SessionLoadError =>
  Object.hasOwn(SESSION_LOAD_ERROR_MESSAGES, value)

/** The message for a `loadError` query value; `None` for a value this module did not produce. */
export const sessionLoadErrorMessage = (value: string | null): Option.Option<string> =>
  value !== null && isSessionLoadError(value) ? Option.some(SESSION_LOAD_ERROR_MESSAGES[value]) : Option.none()
