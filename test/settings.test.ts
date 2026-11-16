import { AudioVolume, DEFAULT_VOLUME_SETTINGS } from '@nerima-games/mc-audio'
import { DEFAULT_BINDINGS } from '@nerima-games/mc-render'
import { InMemoryStorageLayer, saveTo } from '@nerima-games/mc-save'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
  DEFAULT_PLAYER_SETTINGS,
  PLAYER_SETTINGS_FORMAT,
  PLAYER_SETTINGS_KEY,
  loadPlayerSettings,
  normalizePlayerSettings,
  rebindPlayerSettings,
  savePlayerSettings,
} from '../apps/web/settings'

describe('player settings', () => {
  it('normalizes malformed fields independently and clamps numeric values', () => {
    expect(normalizePlayerSettings({
      sensitivity: 99,
      masterVolume: -2,
      sfxVolume: Number.NaN,
      audioEnabled: 'yes',
      captionsEnabled: false,
      bindings: { moveForward: 'Escape', jump: 'KeyJ' },
    })).toMatchObject({
      sensitivity: 3,
      masterVolume: 0,
      sfxVolume: 1,
      audioEnabled: true,
      captionsEnabled: false,
      bindings: { moveForward: DEFAULT_BINDINGS.moveForward, jump: 'KeyJ' },
    })
  })

  it('clamps out-of-range volumes to AudioVolume bounds and falls back for non-finite ones', () => {
    const above = normalizePlayerSettings({ masterVolume: 7, sfxVolume: 1.5 })
    const below = normalizePlayerSettings({ masterVolume: -0.25, sfxVolume: -3 })
    const nonFinite = normalizePlayerSettings({ masterVolume: Number.POSITIVE_INFINITY, sfxVolume: '0.5' })

    expect([above.masterVolume, above.sfxVolume]).toEqual([1, 1])
    expect([below.masterVolume, below.sfxVolume]).toEqual([0, 0])
    expect([nonFinite.masterVolume, nonFinite.sfxVolume])
      .toEqual([DEFAULT_VOLUME_SETTINGS.master, DEFAULT_PLAYER_SETTINGS.sfxVolume])
    for (const settings of [above, below, nonFinite]) {
      expect(AudioVolume.is(settings.masterVolume)).toBe(true)
      expect(AudioVolume.is(settings.sfxVolume)).toBe(true)
    }
  })

  it('keeps in-range volumes unchanged', () => {
    expect(normalizePlayerSettings({ masterVolume: 0.35, sfxVolume: 0 })).toMatchObject({
      masterVolume: 0.35,
      sfxVolume: 0,
    })
  })

  it.effect('clamps out-of-range volumes read from storage', () =>
    Effect.gen(function* () {
      yield* saveTo(PLAYER_SETTINGS_FORMAT, PLAYER_SETTINGS_KEY, {
        ...DEFAULT_PLAYER_SETTINGS,
        masterVolume: 4,
        sfxVolume: -1,
      })

      expect(yield* loadPlayerSettings()).toMatchObject({ masterVolume: 1, sfxVolume: 0 })
    }).pipe(Effect.provide(InMemoryStorageLayer)))

  it('uses fresh defaults for absent or non-object payloads', () => {
    const first = normalizePlayerSettings(undefined)
    const second = normalizePlayerSettings('corrupt')

    expect(first).toEqual(DEFAULT_PLAYER_SETTINGS)
    expect(second).toEqual(DEFAULT_PLAYER_SETTINGS)
    expect(first.bindings).not.toBe(second.bindings)
  })

  it('swaps a duplicate binding deterministically', () => {
    const remapped = rebindPlayerSettings(DEFAULT_BINDINGS, 'moveForward', 'KeyS')

    expect(remapped['moveForward']).toBe('KeyS')
    expect(remapped['moveBackward']).toBe('KeyW')
    expect(new Set(Object.values(remapped)).size).toBe(Object.values(remapped).length)
  })

  it('preserves swapped bindings while normalizing persisted settings', () => {
    const bindings = rebindPlayerSettings(DEFAULT_BINDINGS, 'moveForward', 'KeyS')

    expect(normalizePlayerSettings({ ...DEFAULT_PLAYER_SETTINGS, bindings }).bindings).toEqual(bindings)
  })

  it.effect('persists independently under the player settings format', () =>
    Effect.gen(function* () {
      const expected = normalizePlayerSettings({
        ...DEFAULT_PLAYER_SETTINGS,
        sensitivity: 1.75,
        audioEnabled: false,
      })

      yield* savePlayerSettings(expected)
      expect(yield* loadPlayerSettings()).toEqual(expected)
    }).pipe(Effect.provide(InMemoryStorageLayer)))

  it.effect('round-trips swapped bindings through player settings storage', () =>
    Effect.gen(function* () {
      const bindings = rebindPlayerSettings(DEFAULT_BINDINGS, 'moveForward', 'KeyS')
      const expected = { ...DEFAULT_PLAYER_SETTINGS, bindings }

      yield* savePlayerSettings(expected)
      expect((yield* loadPlayerSettings()).bindings).toEqual(bindings)
    }).pipe(Effect.provide(InMemoryStorageLayer)))
})
