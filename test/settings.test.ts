import { AudioVolume } from '@nerima-games/mc-audio'
import { defineFormat, InMemoryStorageLayer, saveTo } from '@nerima-games/mc-save'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'

import {
  DEFAULT_PLAYER_SETTINGS,
  PLAYER_SETTINGS_FORMAT_NAME,
  PLAYER_SETTINGS_KEY,
  loadPlayerSettings,
  rebindPlayerSettings,
  savePlayerSettings,
  updatePlayerSettings,
  type PlayerSettingsV1,
} from '../apps/web/settings'

const DEFAULT_BINDINGS_LITERAL = {
  attack: 'MouseLeft',
  hotbarSlot1: 'Digit1',
  hotbarSlot2: 'Digit2',
  hotbarSlot3: 'Digit3',
  hotbarSlot4: 'Digit4',
  hotbarSlot5: 'Digit5',
  hotbarSlot6: 'Digit6',
  hotbarSlot7: 'Digit7',
  hotbarSlot8: 'Digit8',
  hotbarSlot9: 'Digit9',
  jump: 'Space',
  moveBackward: 'KeyS',
  moveForward: 'KeyW',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  openChat: 'KeyT',
  openInventory: 'KeyE',
  pickBlock: 'MouseMiddle',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  use: 'MouseRight',
}

const STORED_V2 = {
  sensitivity: 1.75,
  bindings: { ...DEFAULT_BINDINGS_LITERAL, moveForward: 'KeyS', moveBackward: 'KeyW' },
  masterVolume: 0.35,
  sfxVolume: 0,
  audioEnabled: false,
  captionsEnabled: true,
}

// Writes a payload under the player settings format name and the given
// version without the strict schema, the way an older or corrupted build could.
const storeRaw = (version: number, payload: unknown) =>
  saveTo(
    Result.getOrThrow(defineFormat({ name: PLAYER_SETTINGS_FORMAT_NAME, version, schema: Schema.Unknown })),
    PLAYER_SETTINGS_KEY,
    payload,
  )

const loadFailureTag = Effect.gen(function* () {
  const error = yield* Effect.flip(loadPlayerSettings())
  return error._tag
})

const volume = (value: number): AudioVolume => Result.getOrThrow(AudioVolume.result(value))

const settingsWith = (patch: Partial<PlayerSettingsV1>): PlayerSettingsV1 => ({ ...DEFAULT_PLAYER_SETTINGS, ...patch })

describe('player settings v2 storage', () => {
  it.effect('loads defaults when nothing is stored', () =>
    Effect.gen(function* () {
      expect(yield* loadPlayerSettings()).toEqual({
        sensitivity: 1,
        bindings: DEFAULT_BINDINGS_LITERAL,
        masterVolume: 0.8,
        sfxVolume: 1,
        audioEnabled: true,
        captionsEnabled: true,
      })
    }).pipe(Effect.provide(InMemoryStorageLayer)))

  it.effect('round-trips a valid value', () =>
    Effect.gen(function* () {
      yield* savePlayerSettings(settingsWith({
        sensitivity: 1.75,
        bindings: { ...DEFAULT_BINDINGS_LITERAL, moveForward: 'KeyS', moveBackward: 'KeyW' },
        masterVolume: volume(0.35),
        sfxVolume: volume(0),
        audioEnabled: false,
      }))

      expect(yield* loadPlayerSettings()).toEqual(STORED_V2)
    }).pipe(Effect.provide(InMemoryStorageLayer)))

  const invalidStored: ReadonlyArray<readonly [string, unknown]> = [
    ['sensitivity above range', { ...STORED_V2, sensitivity: 99 }],
    ['master volume below range', { ...STORED_V2, masterVolume: -2 }],
    ['sensitivity of the wrong type', { ...STORED_V2, sensitivity: '1.5' }],
    ['audioEnabled of the wrong type', { ...STORED_V2, audioEnabled: 'yes' }],
    ['an unknown key', { ...STORED_V2, fov: 70 }],
    ['a missing field', { sensitivity: 1, bindings: DEFAULT_BINDINGS_LITERAL, masterVolume: 0.8, sfxVolume: 1, audioEnabled: true }],
    ['duplicate binding codes', { ...STORED_V2, bindings: { ...DEFAULT_BINDINGS_LITERAL, jump: 'KeyW' } }],
    ['a reserved binding code', { ...STORED_V2, bindings: { ...DEFAULT_BINDINGS_LITERAL, jump: 'Tab' } }],
    ['a blank binding code', { ...STORED_V2, bindings: { ...DEFAULT_BINDINGS_LITERAL, jump: '  ' } }],
    ['a stored escape binding', { ...STORED_V2, bindings: { ...DEFAULT_BINDINGS_LITERAL, escape: 'KeyQ' } }],
    ['a missing binding action', { ...STORED_V2, bindings: { moveForward: 'KeyW' } }],
    ['a non-record payload', 'corrupt'],
  ]
  for (const [name, payload] of invalidStored) {
    it.effect(`fails with SaveDecodeError for ${name}`, () =>
      Effect.gen(function* () {
        yield* storeRaw(2, payload)
        expect(yield* loadFailureTag).toBe('SaveDecodeError')
      }).pipe(Effect.provide(InMemoryStorageLayer)))
  }

  const boundaries: ReadonlyArray<readonly [string, Readonly<Record<string, number>>, boolean]> = [
    ['sensitivity 0.1', { sensitivity: 0.1 }, true],
    ['sensitivity 3', { sensitivity: 3 }, true],
    ['sensitivity 0.099', { sensitivity: 0.099 }, false],
    ['sensitivity 3.01', { sensitivity: 3.01 }, false],
    ['master volume 0', { masterVolume: 0 }, true],
    ['master volume 1', { masterVolume: 1 }, true],
    ['master volume -0.01', { masterVolume: -0.01 }, false],
    ['master volume 1.01', { masterVolume: 1.01 }, false],
    ['sfx volume 0', { sfxVolume: 0 }, true],
    ['sfx volume 1', { sfxVolume: 1 }, true],
    ['sfx volume -0.01', { sfxVolume: -0.01 }, false],
    ['sfx volume 1.01', { sfxVolume: 1.01 }, false],
  ]
  for (const [name, patch, accepted] of boundaries) {
    it.effect(`${accepted ? 'accepts' : 'rejects'} stored ${name}`, () =>
      Effect.gen(function* () {
        yield* storeRaw(2, { ...STORED_V2, ...patch })
        const loaded = yield* Effect.result(loadPlayerSettings())
        if (accepted) {
          expect(loaded).toEqual(Result.succeed({ ...STORED_V2, ...patch }))
        } else {
          expect(Result.isFailure(loaded) && loaded.failure._tag).toBe('SaveDecodeError')
        }
      }).pipe(Effect.provide(InMemoryStorageLayer)))
  }

  it.effect('refuses to save an invalid value and leaves storage unchanged', () =>
    Effect.gen(function* () {
      yield* storeRaw(2, STORED_V2)

      const error = yield* Effect.flip(savePlayerSettings(settingsWith({ sensitivity: 99 })))
      const duplicate = yield* Effect.flip(savePlayerSettings(settingsWith({
        bindings: { ...DEFAULT_BINDINGS_LITERAL, jump: 'KeyW' },
      })))

      expect(error._tag).toBe('SaveDecodeError')
      expect(duplicate._tag).toBe('SaveDecodeError')
      expect(yield* loadPlayerSettings()).toEqual(STORED_V2)
    }).pipe(Effect.provide(InMemoryStorageLayer)))
})

describe('player settings v1 migration', () => {
  it.effect('loads a full v1 record unchanged', () =>
    Effect.gen(function* () {
      yield* storeRaw(1, STORED_V2)
      expect(yield* loadPlayerSettings()).toEqual(STORED_V2)
    }).pipe(Effect.provide(InMemoryStorageLayer)))

  it.effect('fills only the omitted fields and binding actions', () =>
    Effect.gen(function* () {
      const { moveLeft: _moveLeft, hotbarSlot9: _hotbarSlot9, ...partialBindings } = {
        ...DEFAULT_BINDINGS_LITERAL,
        jump: 'KeyJ',
      }
      yield* storeRaw(1, {
        sensitivity: 2,
        bindings: partialBindings,
        masterVolume: 0.5,
        sfxVolume: 0.25,
        audioEnabled: false,
      })

      expect(yield* loadPlayerSettings()).toEqual({
        sensitivity: 2,
        bindings: { ...DEFAULT_BINDINGS_LITERAL, jump: 'KeyJ' },
        masterVolume: 0.5,
        sfxVolume: 0.25,
        audioEnabled: false,
        captionsEnabled: true,
      })
    }).pipe(Effect.provide(InMemoryStorageLayer)))

  it.effect('fills every field of an empty v1 record', () =>
    Effect.gen(function* () {
      yield* storeRaw(1, {})
      expect(yield* loadPlayerSettings()).toEqual({
        sensitivity: 1,
        bindings: DEFAULT_BINDINGS_LITERAL,
        masterVolume: 0.8,
        sfxVolume: 1,
        audioEnabled: true,
        captionsEnabled: true,
      })
    }).pipe(Effect.provide(InMemoryStorageLayer)))

  const invalidV1: ReadonlyArray<readonly [string, unknown]> = [
    ['an out-of-range present value', { sensitivity: 99 }],
    ['a present value of the wrong type', { captionsEnabled: 'no' }],
    ['present bindings that are not a record', { bindings: 'KeyW' }],
    ['a present invalid binding code', { bindings: { moveForward: 'Escape' } }],
    ['a non-record payload', ['corrupt']],
  ]
  for (const [name, payload] of invalidV1) {
    it.effect(`fails with SaveDecodeError for ${name}`, () =>
      Effect.gen(function* () {
        yield* storeRaw(1, payload)
        expect(yield* loadFailureTag).toBe('SaveDecodeError')
      }).pipe(Effect.provide(InMemoryStorageLayer)))
  }
})

describe('rebindPlayerSettings', () => {
  it('swaps a duplicate binding', () => {
    expect(rebindPlayerSettings(DEFAULT_BINDINGS_LITERAL, 'moveForward', 'KeyS')).toEqual(Result.succeed({
      ...DEFAULT_BINDINGS_LITERAL,
      moveForward: 'KeyS',
      moveBackward: 'KeyW',
    }))
  })

  it('binds an unused code without touching other actions', () => {
    expect(rebindPlayerSettings(DEFAULT_BINDINGS_LITERAL, 'jump', 'KeyJ')).toEqual(Result.succeed({
      ...DEFAULT_BINDINGS_LITERAL,
      jump: 'KeyJ',
    }))
  })

  const rejections: ReadonlyArray<readonly [string, 'blank-key' | 'reserved-key']> = [
    ['', 'blank-key'],
    ['   ', 'blank-key'],
    ['Escape', 'reserved-key'],
    ['Tab', 'reserved-key'],
  ]
  for (const [code, reason] of rejections) {
    it(`rejects ${JSON.stringify(code)} as ${reason}`, () => {
      expect(rebindPlayerSettings(DEFAULT_BINDINGS_LITERAL, 'jump', code)).toEqual(Result.fail({
        _tag: 'PlayerBindingRejected',
        action: 'jump',
        code,
        reason,
      }))
    })
  }
})

describe('updatePlayerSettings', () => {
  it('applies a valid patch', () => {
    expect(updatePlayerSettings(DEFAULT_PLAYER_SETTINGS, {
      sensitivity: 0.1,
      masterVolume: volume(0),
      captionsEnabled: false,
    })).toEqual(Result.succeed({
      sensitivity: 0.1,
      bindings: DEFAULT_BINDINGS_LITERAL,
      masterVolume: 0,
      sfxVolume: 1,
      audioEnabled: true,
      captionsEnabled: false,
    }))
  })

  it('fails for a value mc-sim rejects', () => {
    const updated = updatePlayerSettings(DEFAULT_PLAYER_SETTINGS, { sensitivity: 3.01 })
    expect(Result.isFailure(updated) && updated.failure._tag).toBe('SchemaError')
  })

  it('fails when the current bindings are invalid', () => {
    const updated = updatePlayerSettings(
      settingsWith({ bindings: { ...DEFAULT_BINDINGS_LITERAL, jump: 'KeyW' } }),
      { audioEnabled: false },
    )
    expect(Result.isFailure(updated) && updated.failure._tag).toBe('SchemaError')
  })
})
