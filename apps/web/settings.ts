import {
  AudioVolume,
  DEFAULT_VOLUME_SETTINGS,
} from '@nerima-games/mc-audio'
import {
  DEFAULT_BINDINGS,
  ESCAPE_KEY_CODE,
  FOCUS_NAVIGATION_KEY_CODE,
  INPUT_ACTIONS,
  type Bindings,
  type InputAction,
} from '@nerima-games/mc-render'
import {
  loadFrom,
  SaveKey,
  saveTo,
  defineFormat,
  type SaveDecodeError,
  type SaveFormat,
  type StorageError,
  type StoragePort,
} from '@nerima-games/mc-save'
import { Effect, Option, Result, Schema } from 'effect'

export const PLAYER_SETTINGS_FORMAT_NAME = '@nerima-games/mc-compose/player-settings'
export const PLAYER_SETTINGS_KEY: SaveKey = SaveKey('mc-compose/player-settings')

export const PLAYER_BINDING_ACTIONS: ReadonlyArray<Exclude<InputAction, 'escape'>> = INPUT_ACTIONS.filter(
  (action): action is Exclude<InputAction, 'escape'> => action !== 'escape',
)

export type PlayerSettingsV1 = {
  readonly sensitivity: number
  readonly bindings: Bindings
  readonly masterVolume: AudioVolume
  readonly sfxVolume: AudioVolume
  readonly audioEnabled: boolean
  readonly captionsEnabled: boolean
}

// AudioVolume accepts every finite number in [0, 1]. Callers pass only values
// already inside that range, so a failure means the brand's contract changed;
// throwing surfaces that (at module load, for FULL_SFX_VOLUME) instead of
// carrying an unbranded volume into audio.
const volumeWithinUnitRange = (value: number): AudioVolume => Result.getOrThrowWith(
  AudioVolume.result(value),
  (error) => new Error(`player settings volume outside the AudioVolume range: ${error.message}`),
)

const FULL_SFX_VOLUME = volumeWithinUnitRange(1)

export const DEFAULT_PLAYER_SETTINGS: PlayerSettingsV1 = {
  sensitivity: 1,
  bindings: { ...DEFAULT_BINDINGS },
  masterVolume: DEFAULT_VOLUME_SETTINGS.master,
  sfxVolume: FULL_SFX_VOLUME,
  audioEnabled: true,
  captionsEnabled: true,
}

// defineFormat only rejects a blank name or a version that is not a safe
// integer >= 1. Both inputs here are module constants that satisfy that, so a
// failure means the constants were edited into an invalid state; failing at
// module load surfaces that before any settings are read or written.
export const PLAYER_SETTINGS_FORMAT: SaveFormat<unknown, unknown> = Result.getOrThrowWith(
  defineFormat({
    name: PLAYER_SETTINGS_FORMAT_NAME,
    version: 1,
    schema: Schema.Unknown,
  }),
  (problems) => new Error(`invalid player settings save format: ${problems.join('; ')}`),
)

export type PlayerSettingsPersistenceError = StorageError | SaveDecodeError

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const boundedNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback

// Same policy as boundedNumber: clamp a finite value into [0, 1], fall back
// otherwise. The clamped value is finite and within [0, 1], so the AudioVolume
// constructor accepts it.
const boundedVolume = (value: unknown, fallback: AudioVolume): AudioVolume =>
  typeof value === 'number' && Number.isFinite(value)
    ? volumeWithinUnitRange(Math.min(1, Math.max(0, value)))
    : fallback

const validBindingCode = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value !== ESCAPE_KEY_CODE
  && value !== FOCUS_NAVIGATION_KEY_CODE

export const rebindPlayerSettings = (
  bindings: Bindings,
  action: Exclude<InputAction, 'escape'>,
  code: string,
): Bindings => {
  if (!validBindingCode(code) || !PLAYER_BINDING_ACTIONS.includes(action)) return bindings

  const previousCode = bindings[action] ?? DEFAULT_BINDINGS[action]
  const conflictingAction = PLAYER_BINDING_ACTIONS.find(
    (candidate) => candidate !== action && bindings[candidate] === code,
  )
  const next = { ...bindings, [action]: code }
  if (conflictingAction !== undefined) next[conflictingAction] = previousCode
  return next
}

export const normalizeBindings = (value: unknown): Bindings => {
  const record = asRecord(value)
  if (record === undefined) return { ...DEFAULT_BINDINGS }

  return PLAYER_BINDING_ACTIONS.reduce<Bindings>((bindings, action) => {
    const code = record[action]
    return validBindingCode(code) ? rebindPlayerSettings(bindings, action, code) : bindings
  }, { ...DEFAULT_BINDINGS })
}

export const normalizePlayerSettings = (value: unknown): PlayerSettingsV1 => {
  const record = asRecord(value)
  if (record === undefined) return { ...DEFAULT_PLAYER_SETTINGS, bindings: { ...DEFAULT_BINDINGS } }

  return {
    sensitivity: boundedNumber(record['sensitivity'], 1, 0.1, 3),
    bindings: normalizeBindings(record['bindings']),
    masterVolume: boundedVolume(record['masterVolume'], DEFAULT_VOLUME_SETTINGS.master),
    sfxVolume: boundedVolume(record['sfxVolume'], FULL_SFX_VOLUME),
    audioEnabled: typeof record['audioEnabled'] === 'boolean' ? record['audioEnabled'] : true,
    captionsEnabled: typeof record['captionsEnabled'] === 'boolean'
      ? record['captionsEnabled']
      : true,
  }
}

export const loadPlayerSettings = (): Effect.Effect<
  PlayerSettingsV1,
  PlayerSettingsPersistenceError,
  StoragePort
> => loadFrom(PLAYER_SETTINGS_FORMAT, PLAYER_SETTINGS_KEY).pipe(
  Effect.map(Option.match({
    onNone: () => normalizePlayerSettings(undefined),
    onSome: normalizePlayerSettings,
  })),
)

export const savePlayerSettings = (
  settings: PlayerSettingsV1,
): Effect.Effect<void, StorageError | SaveDecodeError, StoragePort> =>
  saveTo(PLAYER_SETTINGS_FORMAT, PLAYER_SETTINGS_KEY, normalizePlayerSettings(settings))
