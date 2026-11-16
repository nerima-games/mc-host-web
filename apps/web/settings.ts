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
  defineFormatMigration,
  type SaveDecodeError,
  type SaveFormat,
  type StorageError,
  type StoragePort,
} from '@nerima-games/mc-save'
import { decodeSettings } from '@nerima-games/mc-sim'
import { Effect, Option, Result, Schema } from 'effect'

export const PLAYER_SETTINGS_FORMAT_NAME = '@nerima-games/mc-compose/player-settings'
export const PLAYER_SETTINGS_KEY: SaveKey = SaveKey('mc-compose/player-settings')

type BindableAction = Exclude<InputAction, 'escape'>

export const PLAYER_BINDING_ACTIONS: ReadonlyArray<BindableAction> = INPUT_ACTIONS.filter(
  (action): action is BindableAction => action !== 'escape',
)

export type PlayerSettingsV1 = {
  readonly sensitivity: number
  readonly bindings: Bindings
  readonly masterVolume: AudioVolume
  readonly sfxVolume: AudioVolume
  readonly audioEnabled: boolean
  readonly captionsEnabled: boolean
}

// AudioVolume accepts every finite number in [0, 1] and 1 is inside it, so a
// failure means the brand's contract changed; throwing at module load surfaces
// that instead of carrying an unbranded volume into audio.
const FULL_SFX_VOLUME = Result.getOrThrowWith(
  AudioVolume.result(1),
  (error) => new Error(`player settings volume outside the AudioVolume range: ${error.message}`),
)

export const DEFAULT_PLAYER_SETTINGS: PlayerSettingsV1 = {
  sensitivity: 1,
  bindings: { ...DEFAULT_BINDINGS },
  masterVolume: DEFAULT_VOLUME_SETTINGS.master,
  sfxVolume: FULL_SFX_VOLUME,
  audioEnabled: true,
  captionsEnabled: true,
}

export type PlayerBindingRejected = {
  readonly _tag: 'PlayerBindingRejected'
  readonly action: BindableAction
  readonly code: string
  readonly reason: 'blank-key' | 'reserved-key'
}

const bindingCodeRejection = (code: string): PlayerBindingRejected['reason'] | undefined => {
  if (code.trim().length === 0) return 'blank-key'
  if (code === ESCAPE_KEY_CODE || code === FOCUS_NAVIGATION_KEY_CODE) return 'reserved-key'
  return undefined
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// mc-save decodes with default parse options, under which a struct drops
// unknown keys; checking the raw record first makes an unknown key a decode
// failure instead of something silently discarded.
const withExactKeys = <S extends Schema.Top>(keys: ReadonlyArray<string>, schema: S) =>
  Schema.Unknown.check(Schema.makeFilter((input) => {
    if (!isRecord(input)) return 'Expected a record'
    const unknownKey = Reflect.ownKeys(input).find((key) => typeof key !== 'string' || !keys.includes(key))
    return unknownKey === undefined ? undefined : `Unexpected key ${String(unknownKey)}`
  })).pipe(Schema.decodeTo(schema))

const BindingCodeSchema = Schema.String.check(Schema.makeFilter((code) => {
  const reason = bindingCodeRejection(code)
  return reason === undefined ? undefined : `Binding code rejected: ${reason}`
}))

// The stored record holds exactly the bindable actions. 'escape' is owned by
// the frame-level handler and absent from DEFAULT_BINDINGS, and v1 builds only
// ever wrote PLAYER_BINDING_ACTIONS on top of DEFAULT_BINDINGS, so a stored
// 'escape' key is rejected like any other unknown key.
const PlayerBindingsSchema = withExactKeys(
  PLAYER_BINDING_ACTIONS,
  Schema.Struct(Object.fromEntries(PLAYER_BINDING_ACTIONS.map((action) => [action, BindingCodeSchema])))
    .check(Schema.makeFilter((bindings) => {
      const codes = Object.values(bindings)
      return new Set(codes).size === codes.length || 'Each binding code must belong to one action'
    })),
)

const AudioVolumeSchema = Schema.Number.pipe(Schema.fromBrand('AudioVolume', AudioVolume))

const PlayerSettingsFieldsSchema = Schema.Struct({
  sensitivity: Schema.Number,
  bindings: PlayerBindingsSchema,
  masterVolume: AudioVolumeSchema,
  sfxVolume: AudioVolumeSchema,
  audioEnabled: Schema.Boolean,
  captionsEnabled: Schema.Boolean,
})

// mc-sim owns the ranges of the settings it shares with the host, so the raw
// values are checked there before the volumes are branded for mc-audio.
// decodeSettings fills every setting the candidate omits with mc-sim's
// defaults and rejects any supplied value outside its schema.
const StoredPlayerSettingsSchema = Schema.toEncoded(PlayerSettingsFieldsSchema).check(
  Schema.makeFilter((settings) => Result.match(decodeSettings({
    mouseSensitivity: settings.sensitivity,
    masterVolume: settings.masterVolume,
    sfxVolume: settings.sfxVolume,
    audioEnabled: settings.audioEnabled,
    captionsEnabled: settings.captionsEnabled,
  }), {
    onFailure: (error) => `mc-sim rejected the player settings: ${error.message}`,
    onSuccess: () => undefined,
  })),
)

const PlayerSettingsSchema = withExactKeys(
  Object.keys(PlayerSettingsFieldsSchema.fields),
  StoredPlayerSettingsSchema,
).pipe(Schema.decodeTo(PlayerSettingsFieldsSchema))

const decodePlayerSettings = Schema.decodeUnknownResult(PlayerSettingsSchema)

const fillOmitted = (
  record: Readonly<Record<string, unknown>>,
  defaults: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  ...record,
  ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !Object.hasOwn(record, key))),
})

// Builds before v2 stored a record without a schema and older ones wrote fewer
// fields. Only omitted fields and omitted binding actions are filled; a present
// value is carried as is, so an invalid one still fails the v2 decode.
const migrateFromV1 = (record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const bindings = record['bindings']
  return fillOmitted(
    isRecord(bindings) ? { ...record, bindings: fillOmitted(bindings, DEFAULT_BINDINGS) } : record,
    DEFAULT_PLAYER_SETTINGS,
  )
}

// defineFormatMigration only rejects an invalid fromVersion or a migrate that
// is not a function, and defineFormat only rejects a blank name or a version
// that is not a safe integer >= 1. All inputs here are module constants that
// satisfy that, so a failure means they were edited into an invalid state;
// failing at module load surfaces that before any settings are read or written.
const formatDefinitionError = (problems: ReadonlyArray<string>): Error =>
  new Error(`invalid player settings save format: ${problems.join('; ')}`)

export const PLAYER_SETTINGS_FORMAT: SaveFormat<PlayerSettingsV1, unknown> = Result.getOrThrowWith(
  defineFormat({
    name: PLAYER_SETTINGS_FORMAT_NAME,
    version: 2,
    schema: PlayerSettingsSchema,
    migrations: [
      Result.getOrThrowWith(
        defineFormatMigration({
          fromVersion: 1,
          schema: Schema.declare(isRecord, { expected: 'Player settings v1 record' }),
          migrate: migrateFromV1,
        }),
        formatDefinitionError,
      ),
    ],
  }),
  formatDefinitionError,
)

export type PlayerSettingsPersistenceError = StorageError | SaveDecodeError

export const rebindPlayerSettings = (
  bindings: Bindings,
  action: BindableAction,
  code: string,
): Result.Result<Bindings, PlayerBindingRejected> => {
  const reason = bindingCodeRejection(code)
  if (reason !== undefined) return Result.fail({ _tag: 'PlayerBindingRejected', action, code, reason })

  const previousCode = bindings[action] ?? DEFAULT_BINDINGS[action]
  const conflictingAction = PLAYER_BINDING_ACTIONS.find(
    (candidate) => candidate !== action && bindings[candidate] === code,
  )
  const next = { ...bindings, [action]: code }
  if (conflictingAction !== undefined) next[conflictingAction] = previousCode
  return Result.succeed(next)
}

export const updatePlayerSettings = (
  current: PlayerSettingsV1,
  patch: Partial<Omit<PlayerSettingsV1, 'bindings'>>,
): Result.Result<PlayerSettingsV1, Schema.SchemaError> => decodePlayerSettings({ ...current, ...patch })

export const loadPlayerSettings = (): Effect.Effect<
  PlayerSettingsV1,
  PlayerSettingsPersistenceError,
  StoragePort
> => loadFrom(PLAYER_SETTINGS_FORMAT, PLAYER_SETTINGS_KEY).pipe(
  Effect.map(Option.getOrElse(() => DEFAULT_PLAYER_SETTINGS)),
)

export const savePlayerSettings = (
  settings: PlayerSettingsV1,
): Effect.Effect<void, StorageError | SaveDecodeError, StoragePort> =>
  saveTo(PLAYER_SETTINGS_FORMAT, PLAYER_SETTINGS_KEY, settings)
