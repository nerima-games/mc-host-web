import { readFileSync } from 'node:fs'

import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Result, Schema } from 'effect'

import {
  encodeSave,
  SaveFormatName,
  SaveFormatVersion,
  SaveEnvelopeSchema,
  SaveKey,
  sealSaveEnvelope,
  StorageError,
  StoragePort,
  type SaveEnvelope,
  type StorageService,
} from '@nerima-games/mc-save'
import {
  FLINT_AND_STEEL_MAX_DURABILITY,
  INVENTORY_SLOT_COUNT,
  DamageCause,
  EntityHealthPoints,
  ExhaustionAmount,
  FoodSaturation,
  HungerPoints,
  TotalExperience,
  advanceFurnace,
  emptyBrewingState,
  equipFromInventory,
  itemStack,
  storageFromInventory,
  validateCropSnapshot,
  validateVehicleSnapshot,
  OccupantId,
  WitherChargeRemainingSecs,
  WitherHealthPoints,
  type CropSnapshot,
  type Vehicle,
} from '@nerima-games/mc-sim'
import {
  CHUNK_SIZE_XZ,
  ChunkAxis,
  ItemDamage,
  PositionAxis,
  RepairCost,
  chunkCoord,
  position,
  itemStackEqualsIgnoringCount,
  type ChunkCoord,
} from '@nerima-games/mc-kernel'
import {
  CHUNK_FORMAT,
  CHUNK_VOLUME,
  type ChunkSource,
  type ChunkWithBlockStates,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import {
  SPAWN_PLAYER_VITALS,
  emptyStatusEffectState,
  isDroppedItemBehaviour,
} from '@nerima-games/mx-gameplay'

import {
  EMPTY_END_STATE,
  EMPTY_ENTITY_ROSTER,
  EMPTY_ENTITY_ROSTERS,
  EMPTY_VILLAGER_STATE,
  SESSION_FORMAT_NAME,
  SESSION_FORMAT_VERSION,
  deleteSession,
  listSessionEntries,
  listSessions,
  loadSession,
  openSession,
  makeSessionChunkSource,
  normalizePersistedEntityRoster,
  normalizePersistedEntityRosters,
  persistedItemDropLifetime,
  persistedItemDropMetadata,
  saveSession as persistSession,
  sessionChunkKey,
  sessionHeadKey,
  toStoredSessionState,
  type DimensionChunk,
  type SaveSessionInput,
  type SessionHead,
  type SessionMetadata,
  type SessionState,
} from '../apps/web/session-persistence'
import {
  sessionLoadErrorOf,
  sessionOpenFailureMessage,
  sessionOpenNotice,
} from '../apps/web/session-restoration'

const fixtureEnvelopeText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const parseJson = (text: string): unknown => JSON.parse(text)

const coordOf = (cx: number, cz: number): ChunkCoord => chunkCoord(ChunkAxis(cx), ChunkAxis(cz))

const validCrops = (value: unknown): CropSnapshot => {
  const result = validateCropSnapshot(value)
  if (result._tag !== 'Valid') throw new Error(`crop fixture is invalid: ${result.error.reason}`)
  return result.snapshot
}

const validVehicles = (vehicles: ReadonlyArray<unknown>, nextSerial: number): ReadonlyArray<Vehicle> => {
  const result = validateVehicleSnapshot({ vehicles, nextSerial })
  if (result._tag !== 'Valid') throw new Error('vehicle fixture is invalid')
  return result.snapshot.vehicles
}

const stoneStack = Result.getOrThrow(itemStack('stone', 12))

const flintAndSteelSlots = () => {
  const flintAndSteel = Result.getOrThrow(itemStack('flint_and_steel', 1))
  return Array.from({ length: INVENTORY_SLOT_COUNT }, (_, index) => index === 0 ? flintAndSteel : undefined)
}

const sessionState = (seed: number): SessionState => ({
  seed,
  dimension: 'overworld',
  player: {
    feetPosition: { x: 1.5, y: 64, z: -2.5 },
    yawRadians: 0.25,
    pitchRadians: -0.1,
  },
  storage: storageFromInventory({
    slots: Array.from({ length: INVENTORY_SLOT_COUNT }, (_, index) => index === 0 ? stoneStack : undefined),
  }),
  containerStorage: {
    version: 3,
    containers: [{
      id: 'overworld:4,65,-2',
      kind: 'chest',
      slots: Array.from({ length: 27 }, (_, index) => index === 0 ? { ...stoneStack, durability: null } : null),
    }],
  },
  vitals: {
    ...SPAWN_PLAYER_VITALS,
    healthPoints: EntityHealthPoints(13),
    hungerPoints: HungerPoints(17),
    saturation: FoodSaturation(3),
    exhaustion: ExhaustionAmount(0.5),
    totalExperience: TotalExperience(37),
    lastDamageCause: DamageCause('fall'),
  },
  time: { ticks: 12_345, dayLengthTicks: 24_000 },
  weather: { weather: 'rain', remainingSecs: 123.5 },
  redstone: {
    levers: [{
      dimension: 'nether',
      position: { x: -3, y: 71, z: 12 },
      active: true,
    }],
  },
  furnaces: [],
  portals: [{
    dimension: 'overworld',
    position: { x: 10, y: 64, z: -7 },
  }],
  crops: validCrops({
    crops: [{
      dimension: 'overworld',
      position: { x: 4, y: 65, z: -2 },
      crop: 'potato_crop',
      growthSecs: 123,
    }],
  }),
  entities: EMPTY_ENTITY_ROSTERS,
  villagers: EMPTY_VILLAGER_STATE,
  brewing: Result.getOrThrow(emptyBrewingState()),
  statusEffects: emptyStatusEffectState(),
  end: EMPTY_END_STATE,
  wither: {
    nextWitherId: 1,
    nextSkullId: 0,
    withers: [{
      id: 'wither-1',
      dimension: 'overworld',
      snapshot: {
        kind: 'wither',
        version: 1,
        state: {
          phase: 'charging',
          healthPoints: WitherHealthPoints(300),
          chargeRemainingSecs: WitherChargeRemainingSecs(4),
          feetPosition: position(PositionAxis(2.5), PositionAxis(66), PositionAxis(-3.5)),
          velocity: position(PositionAxis(0), PositionAxis(0), PositionAxis(0)),
        },
      },
      rangedCooldownSecs: 2,
      meleeCooldownSecs: 1,
      shotsFired: 0,
    }],
    skulls: [],
  },
})

const chunk = (cx: number, cz: number, marker: number): ChunkWithBlockStates => ({
  coord: coordOf(cx, cz),
  blocks: new Uint16Array(CHUNK_VOLUME).fill(marker),
  // Code 0 is each block's default state; mc-worldgen's chunk format accepts it for every marker used here.
  blockStates: new Uint32Array(CHUNK_VOLUME),
  biomes: Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, () => 'PLAINS'),
})

const dimensionChunk = (
  dimension: Dimension,
  cx: number,
  cz: number,
  marker: number,
): DimensionChunk => ({ dimension, chunk: chunk(cx, cz, marker) })

describe('dynamic entity persistence', () => {
  it('reads item-drop elapsed time and defaults legacy saves to zero', () => {
    const roster = normalizePersistedEntityRoster({
      entities: [{
        id: 'drop-3',
        kind: 'dropped_item',
        feetPosition: { x: 1.5, y: 64, z: -2.5 },
        healthPoints: 1,
        behaviour: { item: 'stone', count: 2, elapsedSecs: 123.5 },
      }],
      nextSerial: 4,
    })

    expect(persistedItemDropLifetime(roster.entities[0]?.behaviour)).toEqual({
      elapsedSecs: 123.5,
    })
    expect(persistedItemDropLifetime({ item: 'stone', count: 2 })).toEqual({ elapsedSecs: 0 })
    expect(persistedItemDropLifetime({ elapsedSecs: Number.POSITIVE_INFINITY })).toEqual({
      elapsedSecs: 0,
    })
  })

  it('reconstructs persisted item drops accepted by the entity runtime', () => {
    const roster = normalizePersistedEntityRoster({
      entities: [{
        id: 'drop-4',
        kind: 'dropped_item',
        feetPosition: { x: 1.5, y: 64, z: -2.5 },
        healthPoints: 1,
        behaviour: {
          item: 'diamond_pickaxe',
          count: 1,
          durability: { current: 1500, max: 1561 },
          customName: 'Fortune Miner',
          enchantments: [{ id: 'fortune', level: 3 }],
          elapsedSecs: 123.5,
          eligibleFromFrame: 42,
        },
      }],
      nextSerial: 5,
    })

    const behaviour = roster.entities[0]?.behaviour
    expect(isDroppedItemBehaviour(behaviour)).toBe(true)
    expect(behaviour).toEqual({
      _tag: 'DroppedItem',
      item: 'diamond_pickaxe',
      count: 1,
      durability: { current: 1500, max: 1561 },
      customName: 'Fortune Miner',
      enchantments: [{ id: 'fortune', level: 3 }],
      elapsedSecs: 123.5,
      eligibleFromFrame: 42,
    })
  })

  it('validates item-drop metadata and omits malformed persisted values', () => {
    expect(persistedItemDropMetadata({
      item: 'diamond_pickaxe',
      durability: { current: 1500, max: 1561 },
      customName: 'Fortune Miner',
      enchantments: [{ id: 'fortune', level: 3 }],
    })).toEqual({
      customName: 'Fortune Miner',
      enchantments: [{ id: 'fortune', level: 3 }],
    })
    expect(persistedItemDropMetadata({
      item: 'stone',
      durability: null,
      customName: ' ',
      enchantments: [{ id: 'fortune', level: 99 }],
    })).toEqual({})
    expect(persistedItemDropMetadata({ item: 'stone', durability: null })).toEqual({})
  })

  it('keeps valid entity rows and sanitizes invalid roster data', () => {
    expect(normalizePersistedEntityRoster({
      entities: [
        {
          id: 'creeper-7',
          kind: 'creeper',
          feetPosition: { x: 1.5, y: 64, z: -2.5 },
          healthPoints: 13,
          behaviour: { fuse: 'dormant' },
        },
        {
          id: 'broken',
          kind: 'creeper',
          feetPosition: { x: Number.POSITIVE_INFINITY, y: 64, z: 0 },
          healthPoints: 20,
          behaviour: null,
        },
        {
          id: 'blank-kind',
          kind: ' ',
          feetPosition: { x: 0, y: 64, z: 0 },
          healthPoints: 20,
          behaviour: null,
        },
      ],
      nextSerial: 8.9,
    })).toEqual({
      entities: [{
        id: 'creeper-7',
        kind: 'creeper',
        feetPosition: { x: 1.5, y: 64, z: -2.5 },
        healthPoints: 13,
        behaviour: { fuse: 'dormant' },
      }],
      nextSerial: 8,
    })
    expect(normalizePersistedEntityRoster(null)).toEqual(EMPTY_ENTITY_ROSTER)
  })

  it('normalizes each dimension roster independently', () => {
    expect(normalizePersistedEntityRosters({
      overworld: { entities: [], nextSerial: 3 },
      nether: { entities: [], nextSerial: 7.8 },
      end: null,
    })).toEqual({
      overworld: { entities: [], nextSerial: 3 },
      nether: { entities: [], nextSerial: 7 },
      end: EMPTY_ENTITY_ROSTER,
    })
  })
})

const defaultMetadata: SessionMetadata = { name: 'Test World', mode: 'survival' }

// loadSession opens through openSession, so an unreadable live head without a
// checkpoint fails as corrupt; the decode failure itself is its live failure.
const loadFailureOf = (sessionId: string) =>
  Effect.flip(loadSession(sessionId)).pipe(Effect.map((error) => {
    expect(error).toMatchObject({ _tag: 'SessionCorruptError', sessionId, checkpoint: 'absent' })
    assert(error._tag === 'SessionCorruptError')
    return error.liveFailure
  }))
const saveSession = (
  input: Omit<SaveSessionInput, 'metadata'> & { readonly metadata?: SessionMetadata },
) => persistSession({ ...input, metadata: input.metadata ?? defaultMetadata })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const storedRecord = (state: SessionState): Readonly<Record<string, unknown>> => {
  const stored = Result.getOrThrow(toStoredSessionState(state))
  if (!isRecord(stored)) throw new Error('toStoredSessionState must return a record')
  return stored
}

const storedField = (state: SessionState, key: keyof SessionState): Readonly<Record<string, unknown>> => {
  const field = storedRecord(state)[key]
  if (!isRecord(field)) throw new Error(`stored ${key} must be a record`)
  return field
}

// Simulates a required field that is absent from the persisted JSON (JSON has
// no way to write a literal `undefined`, so on disk "absent" and "explicitly
// undefined" are the same thing — the key is simply missing). Setting the key
// to `undefined` instead would trip mc-save's `canonicalize`, which rejects
// `undefined`, so the key is dropped.
const storedStateWithout = (state: SessionState, key: keyof SessionState): unknown => {
  const { [key]: omitted, ...rest } = storedRecord(state)
  void omitted
  return rest
}

// Deliberately malformed persisted states: the overrides are raw encoded
// values that no well-typed `SessionState` can hold.
const storedStateWith = (state: SessionState, overrides: Readonly<Record<string, unknown>>): unknown => ({
  ...storedRecord(state),
  ...overrides,
})

// The plain envelope shape this suite seeds storage with; `setEnvelope`
// brands and seals it the way `saveTo` would.
type SeededEnvelope = {
  readonly format: string
  readonly version: number
  readonly payload: unknown
}

type ControlledStorage = {
  readonly layer: Layer.Layer<StoragePort>
  failChunkKey: string | undefined
  failNextHeadWrite: boolean
  failChunkRemoves: boolean
  chunkWriteCount: number
  readonly mutationCount: number
  readonly keys: ReadonlyArray<string>
  readonly envelope: (key: string) => SaveEnvelope | undefined
  readonly setEnvelope: (key: string, envelope: SaveEnvelope | SeededEnvelope) => void
  readonly removeEnvelope: (key: string) => void
}

// Only a live session head: the checkpoint head also ends in `/head`.
const LIVE_HEAD_KEY_PATTERN = /^mc-compose\/session\/[^/]+\/head$/u

const controlledStorage = (): ControlledStorage => {
  const entries = new Map<string, SaveEnvelope>()
  const state = {
    failChunkKey: undefined as string | undefined,
    failNextHeadWrite: false,
    failChunkRemoves: false,
    chunkWriteCount: 0,
    mutationCount: 0,
  }
  const storage: StorageService = {
    get: (key) => Effect.succeed(Option.fromNullishOr(entries.get(key))),
    put: (key, envelope) =>
      Effect.suspend(() => {
        state.mutationCount += 1
        if (String(key).includes('/chunk/')) state.chunkWriteCount += 1
        if (state.failChunkKey === String(key)) {
          return Effect.fail(new StorageError({ operation: 'put', key }))
        }
        if (state.failNextHeadWrite && LIVE_HEAD_KEY_PATTERN.test(key)) {
          state.failNextHeadWrite = false
          // Model an adapter that reports failure after partially mutating its backing store.
          entries.set(key, envelope)
          return Effect.fail(new StorageError({ operation: 'put', key }))
        }
        entries.set(key, envelope)
        return Effect.void
      }),
    remove: (key) =>
      Effect.suspend(() => {
        state.mutationCount += 1
        if (state.failChunkRemoves && String(key).includes('/chunk/')) {
          return Effect.fail(new StorageError({ operation: 'remove', key }))
        }
        entries.delete(key)
        return Effect.void
      }),
    commitBatch: (mutations) =>
      Effect.suspend(() => {
        const next = new Map(entries)
        for (const mutation of mutations) {
          const key = mutation.key
          if (mutation._tag === 'Put') {
            if (String(key).includes('/chunk/')) state.chunkWriteCount += 1
            if (state.failChunkKey === String(key)) {
              return Effect.fail(new StorageError({ operation: 'commitBatch', key }))
            }
            if (state.failNextHeadWrite && LIVE_HEAD_KEY_PATTERN.test(key)) {
              state.failNextHeadWrite = false
              return Effect.fail(new StorageError({ operation: 'commitBatch', key }))
            }
            next.set(key, mutation.envelope)
          } else {
            if (state.failChunkRemoves && String(key).includes('/chunk/')) {
              return Effect.fail(new StorageError({ operation: 'commitBatch', key }))
            }
            next.delete(key)
          }
        }
        entries.clear()
        for (const [key, envelope] of next) entries.set(key, envelope)
        return Effect.void
      }),
    readBatch: (keys) =>
      Effect.sync(() => keys.map((key) => Option.fromNullishOr(entries.get(key)))),
    keys: Effect.sync(() => [...entries.keys()].map(SaveKey)),
  }
  return {
    layer: Layer.succeed(StoragePort, storage),
    get failChunkKey() {
      return state.failChunkKey
    },
    set failChunkKey(value) {
      state.failChunkKey = value
    },
    get failNextHeadWrite() {
      return state.failNextHeadWrite
    },
    set failNextHeadWrite(value) {
      state.failNextHeadWrite = value
    },
    get failChunkRemoves() {
      return state.failChunkRemoves
    },
    set failChunkRemoves(value) {
      state.failChunkRemoves = value
    },
    get chunkWriteCount() {
      return state.chunkWriteCount
    },
    set chunkWriteCount(value) {
      state.chunkWriteCount = value
    },
    get mutationCount() {
      return state.mutationCount
    },
    get keys() {
      return [...entries.keys()]
    },
    envelope: (key) => entries.get(key),
    removeEnvelope: (key) => {
      entries.delete(key)
    },
    // mc-save 0.3.0 made `integrity` a required part of `SaveEnvelope` (a
    // checksum sealed over format/version/payload/extensions). Test fixtures
    // below build envelopes as plain drafts — the shape this suite has always
    // used to seed storage directly, bypassing `saveTo` — so seal on the way
    // in rather than repeating `sealSaveEnvelope(...)` at every one of this
    // file's call sites. An envelope that already carries `integrity` (for
    // example one copied from a prior `saveSession`/`storage.envelope()` call)
    // passes through unchanged.
    setEnvelope: (key, envelope) =>
      entries.set(key, 'integrity' in envelope ? envelope : Result.getOrThrow(sealSaveEnvelope({
        format: SaveFormatName(envelope.format),
        version: SaveFormatVersion(envelope.version),
        payload: envelope.payload,
      }))),
  }
}

describe('session persistence', () => {
  it.effect('round-trips session state and its revision manifest', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      const state = {
        ...sessionState(42),
        entities: {
          ...EMPTY_ENTITY_ROSTERS,
          overworld: {
            entities: [{
              id: 'drop-3',
              kind: 'dropped_item',
              feetPosition: { x: 1.5, y: 64, z: -2.5 },
              healthPoints: 1,
              behaviour: {
                _tag: 'DroppedItem',
                item: 'diamond_pickaxe',
                count: 1,
                durability: { current: 1500, max: 1561 },
                elapsedSecs: 123.5,
                customName: 'Fortune Miner',
                enchantments: [{ id: 'fortune', level: 3 }],
              },
            }],
            nextSerial: 4,
          },
        },
        workstations: {
          enchantmentSeed: 7,
          customNames: {},
          enchantedItems: {},
          deathDropDimension: 'nether' as const,
          respawn: null,
        },
        vehicles: validVehicles([{
          id: 'v:7',
          type: 'boat',
          dimension: 'overworld',
          position: { x: 4.5, y: 65, z: -2.5 },
          velocity: { x: 0.25, y: 0, z: -0.5 },
          yawRadians: 1.25,
          occupant: 'local-player',
        }], 8),
        mountedVehicleId: 'v:7',
      }
      const saved = yield* saveSession({
        sessionId: 'primary world',
        revision: 'r1',
        metadata: { name: 'Primary / 世界', mode: 'creative' },
        state,
        chunks: [dimensionChunk('overworld', 0, 0, 3), dimensionChunk('overworld', -1, 2, 7)],
      })
      const loaded = yield* loadSession('primary world')

      expect(Option.getOrThrow(loaded)).toEqual(saved)
      expect(saved.metadata).toEqual({ name: 'Primary / 世界', mode: 'creative' })
      expect(saved.state.vitals).toEqual(sessionState(42).vitals)
      expect(saved.state.time).toEqual(sessionState(42).time)
      expect(saved.state.weather).toEqual(sessionState(42).weather)
      expect(saved.state.redstone).toEqual(sessionState(42).redstone)
      expect(saved.state.containerStorage).toEqual(sessionState(42).containerStorage)
      expect(saved.state.portals).toEqual(sessionState(42).portals)
      expect(saved.state.crops).toEqual(sessionState(42).crops)
      expect(persistedItemDropLifetime(
        Option.getOrThrow(loaded).state.entities.overworld.entities[0]?.behaviour,
      )).toEqual({ elapsedSecs: 123.5 })
      expect(saved.state.workstations?.deathDropDimension).toBe('nether')
      expect(saved.state.vehicles?.[0]?.occupant).toBe(OccupantId('local-player'))
      expect(saved.state.mountedVehicleId).toBe('v:7')
      expect(saved.chunks.map(({ coord }) => coord)).toEqual([coordOf(0, 0), coordOf(-1, 2)])
      expect(storage.envelope(sessionHeadKey('primary world'))).toMatchObject({
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects malformed persisted Wither snapshots', () => {
    const storage = controlledStorage()
    const sessionId = 'invalid-wither-snapshot'
    const state = sessionState(42)
    const wither = state.wither
    if (wither === undefined) throw new Error('Session fixture must include a Wither runtime snapshot')

    storage.setEnvelope(sessionHeadKey(sessionId), {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId,
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(state, {
          wither: {
            ...wither,
            withers: [{ ...wither.withers[0]!, rangedCooldownSecs: -1 }],
          },
        }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf(sessionId)
      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects malformed direct gameplay snapshots', () => {
    const storage = controlledStorage()
    const state = sessionState(42)
    const invalidStates = [
      storedStateWith(state, {
        brewing: { bottles: [null, null, null], ingredient: null, fuel: null, fuelCharges: -1, brewProgressSecs: 0 },
      }),
      storedStateWith(state, {
        statusEffects: {
          effects: [{ type: 'speed', remainingSecs: -1, pulseClockSecs: 0, amplifier: 0 }],
        },
      }),
      storedStateWith(state, {
        villagers: {
          ...state.villagers,
          residents: [{
            id: '',
            profession: 'farmer',
            dimension: 'overworld',
            feetPosition: { x: 0, y: 64, z: 0 },
          }],
        },
      }),
    ]

    for (const [index, invalidState] of invalidStates.entries()) {
      const sessionId = `invalid-gameplay-snapshot-${String(index)}`
      storage.setEnvelope(sessionHeadKey(sessionId), {
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
        payload: {
          sessionId,
          revision: 'r1',
          metadata: defaultMetadata,
          state: invalidState,
          chunks: [],
        },
      })
    }

    return Effect.gen(function* () {
      for (const index of invalidStates.keys()) {
        const error = yield* loadFailureOf(`invalid-gameplay-snapshot-${String(index)}`)
        expect(error).toMatchObject({ _tag: 'SaveDecodeError' })
      }
    }).pipe(Effect.provide(storage.layer))
  })

  // Only v17 has a migration (to v18). Every older envelope version fails
  // `loadSession` with a `SaveDecodeError` naming that version, because
  // mc-save's `decodeSave` finds no migration starting from it. The payload is
  // otherwise current-shaped, so the rejection is the missing migration path,
  // not incidental payload damage.
  it.effect('rejects every session envelope version that has no migration path', () => {
    const storage = controlledStorage()
    const legacyVersions = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 16]

    for (const version of legacyVersions) {
      storage.setEnvelope(sessionHeadKey(`legacy-v${String(version)}`), {
        format: SESSION_FORMAT_NAME,
        version,
        payload: {
          sessionId: `legacy-v${String(version)}`,
          revision: 'r1',
          metadata: defaultMetadata,
          state: storedRecord(sessionState(version)),
          chunks: [],
        },
      })
    }

    return Effect.gen(function* () {
      for (const version of legacyVersions) {
        const error = yield* Effect.flip(loadSession(`legacy-v${String(version)}`))
        expect(error).toMatchObject({
          _tag: 'SessionIncompatibleError',
          reason: 'unsupported-version',
          storedVersion: version,
          currentVersion: 18,
        })
      }
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('normalizes malformed entity rosters during current session decode', () => {
    const storage = controlledStorage()
    const key = sessionHeadKey('current-entity-roster')
    storage.setEnvelope(key, {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId: 'current-entity-roster',
        revision: 'r1',
        metadata: defaultMetadata,
        // `entities` is deliberately malformed (a missing-field roster entry,
        // a null dimension roster) to exercise `normalizePersistedEntityRosters`.
        state: storedStateWith(sessionState(42), {
          entities: {
            overworld: {
              entities: [
                {
                  id: 'zombie-1',
                  kind: 'zombie',
                  feetPosition: { x: 1, y: 65, z: -2 },
                  healthPoints: 20,
                  behaviour: { target: 'local-player' },
                },
                { id: 'broken', kind: 'zombie' },
              ],
              nextSerial: 3.7,
            },
            nether: null,
            end: { entities: [], nextSerial: -4 },
          },
        }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const loaded = Option.getOrThrow(yield* loadSession('current-entity-roster'))

      expect(loaded.state.entities).toEqual({
        overworld: {
          entities: [{
            id: 'zombie-1',
            kind: 'zombie',
            feetPosition: { x: 1, y: 65, z: -2 },
            healthPoints: 20,
            behaviour: { target: 'local-player' },
          }],
          nextSerial: 3,
        },
        nether: EMPTY_ENTITY_ROSTER,
        end: { entities: [], nextSerial: 0 },
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects container storage explicitly set to undefined', () => {
    const storage = controlledStorage()
    const sessionId = 'undefined-v11-container-storage'
    storage.setEnvelope(sessionHeadKey(sessionId), {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId,
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWithout(sessionState(42), 'containerStorage'),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf(sessionId)
      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects invalid persisted container storage', () => {
    const storage = controlledStorage()
    const sessionId = 'invalid-container-storage'
    storage.setEnvelope(sessionHeadKey(sessionId), {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId,
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(sessionState(42), {
          containerStorage: {
            version: 3,
            containers: [{ id: '', kind: 'chest', slots: [] }],
          },
        }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf(sessionId)
      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects a portal registry explicitly set to undefined', () => {
    const storage = controlledStorage()
    const sessionId = 'undefined-v9-portals'
    storage.setEnvelope(sessionHeadKey(sessionId), {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId,
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWithout(sessionState(42), 'portals'),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf(sessionId)
      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects invalid persisted portal dimensions and coordinates', () => {
    const storage = controlledStorage()
    const invalidPortals = [
      { dimension: 'moon', position: { x: 1, y: 64, z: 2 } },
      { dimension: 'overworld', position: { x: 1.5, y: 64, z: 2 } },
      { dimension: 'overworld', position: { x: 1, y: '64', z: 2 } },
    ]

    for (const [index, portal] of invalidPortals.entries()) {
      const sessionId = `invalid-portal-${String(index)}`
      storage.setEnvelope(sessionHeadKey(sessionId), {
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
        payload: {
          sessionId,
          revision: 'r1',
          metadata: defaultMetadata,
          // `portal` is deliberately malformed (an unrecognized dimension
          // string, a fractional or non-numeric coordinate).
          state: storedStateWith(sessionState(index), { portals: [portal] }),
          chunks: [],
        },
      })
    }

    return Effect.gen(function* () {
      for (const index of invalidPortals.keys()) {
        const error = yield* loadFailureOf(`invalid-portal-${String(index)}`)
        expect(error).toMatchObject({
          _tag: 'SaveDecodeError',
          format: SESSION_FORMAT_NAME,
          version: SESSION_FORMAT_VERSION,
        })
      }
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects invalid persisted crop snapshots', () => {
    const storage = controlledStorage()
    const invalidCrops = [
      [{
        dimension: 'moon',
        position: { x: 1, y: 64, z: 2 },
        crop: 'potato_crop',
        growthSecs: 1,
      }],
      [{
        dimension: 'overworld',
        position: { x: 1.5, y: 64, z: 2 },
        crop: 'potato_crop',
        growthSecs: 1,
      }],
      [{
        dimension: 'overworld',
        position: { x: 1, y: 64, z: 2 },
        crop: 'potato_crop',
        growthSecs: -1,
      }],
    ]

    for (const [index, crops] of invalidCrops.entries()) {
      const sessionId = `invalid-crops-${String(index)}`
      storage.setEnvelope(sessionHeadKey(sessionId), {
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
        payload: {
          sessionId,
          revision: 'r1',
          metadata: defaultMetadata,
          // `crops` is deliberately malformed (an unrecognized dimension,
          // fractional coordinates, negative growth).
          state: storedStateWith(sessionState(index), { crops: { crops } }),
          chunks: [],
        },
      })
    }

    return Effect.gen(function* () {
      for (const index of invalidCrops.keys()) {
        const error = yield* loadFailureOf(`invalid-crops-${String(index)}`)
        expect(error).toMatchObject({
          _tag: 'SaveDecodeError',
          format: SESSION_FORMAT_NAME,
          version: SESSION_FORMAT_VERSION,
        })
      }
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects session envelopes from a future format version', () => {
    const storage = controlledStorage()
    const sessionId = 'future-version'
    storage.setEnvelope(sessionHeadKey(sessionId), {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION + 1,
      payload: {
        sessionId,
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedRecord(sessionState(42)),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* Effect.flip(loadSession(sessionId))
      expect(error).toMatchObject({
        _tag: 'SessionIncompatibleError',
        reason: 'future-version',
        key: 'mc-compose/session/future-version/head',
        storedVersion: 19,
        currentVersion: 18,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  // v18 encoded furnace states (mc-sim 0.11 `FurnaceState`, empty slots as `null`).
  const storedFurnace = (overrides: Readonly<Record<string, unknown>>) => ({
    station: 'furnace',
    input: null,
    fuel: null,
    output: null,
    fuelTimeRemainingSecs: 0,
    fuelTimeTotalSecs: 0,
    cookProgressSecs: 0,
    ...overrides,
  })

  const seedInvalidFurnaces = (
    storage: ControlledStorage,
    prefix: string,
    invalidStates: ReadonlyArray<unknown>,
  ): void => {
    for (const [index, state] of invalidStates.entries()) {
      const sessionId = `${prefix}-${String(index)}`
      storage.setEnvelope(sessionHeadKey(sessionId), {
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
        payload: {
          sessionId,
          revision: 'r1',
          metadata: defaultMetadata,
          state: storedStateWith(sessionState(index), {
            furnaces: [{ dimension: 'overworld', position: { x: 1, y: 64, z: 2 }, state }],
          }),
          chunks: [],
        },
      })
    }
  }

  const expectAllRejected = (prefix: string, count: number) =>
    Effect.gen(function* () {
      for (let index = 0; index < count; index += 1) {
        const error = yield* loadFailureOf(`${prefix}-${String(index)}`)
        expect(error).toMatchObject({
          _tag: 'SaveDecodeError',
          format: SESSION_FORMAT_NAME,
          version: SESSION_FORMAT_VERSION,
        })
      }
    })

  it.effect('rejects invalid persisted furnace states', () => {
    const storage = controlledStorage()
    const invalidStates = [
      storedFurnace({ cookProgressSecs: -1 }),
      storedFurnace({ fuelTimeRemainingSecs: -1 }),
      storedFurnace({ station: 'moon' }),
      storedFurnace({ fuelTimeRemainingSecs: 10, fuelTimeTotalSecs: 5 }),
    ]
    seedInvalidFurnaces(storage, 'invalid-furnace', invalidStates)
    return expectAllRejected('invalid-furnace', invalidStates.length).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects invalid persisted furnace item stacks', () => {
    const storage = controlledStorage()
    const invalidStates = [
      storedFurnace({ input: { item: 'raw_iron', count: 0, components: null } }),
      storedFurnace({ input: { item: 'item_from_an_unknown_build', count: 1, components: null } }),
    ]
    seedInvalidFurnaces(storage, 'invalid-furnace-stack', invalidStates)
    return expectAllRejected('invalid-furnace-stack', invalidStates.length).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects fractional persisted furnace coordinates', () => {
    const storage = controlledStorage()
    const sessionId = 'fractional-furnace-coordinate'
    storage.setEnvelope(sessionHeadKey(sessionId), {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId,
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(sessionState(42), {
          furnaces: [{
            dimension: 'overworld',
            position: { x: 1.5, y: 64, z: 2 },
            state: storedFurnace({}),
          }],
        }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf(sessionId)
      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects duplicate persisted furnace positions within a dimension', () => {
    const storage = controlledStorage()
    const sessionId = 'duplicate-furnace-position'
    const furnace = {
      dimension: 'overworld',
      position: { x: 1, y: 64, z: 2 },
      state: storedFurnace({}),
    }
    storage.setEnvelope(sessionHeadKey(sessionId), {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId,
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(sessionState(42), { furnaces: [furnace, furnace] }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf(sessionId)
      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects session metadata with a non-normalized world name', () => {
    const storage = controlledStorage()
    const invalidNames = ['', '   ', ' World ', 'w'.repeat(129)]

    for (const [index, name] of invalidNames.entries()) {
      const sessionId = `invalid-metadata-${String(index)}`
      storage.setEnvelope(sessionHeadKey(sessionId), {
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
        payload: {
          sessionId,
          revision: 'r1',
          metadata: { name, mode: 'survival' },
          state: storedRecord(sessionState(index)),
          chunks: [],
        },
      })
    }

    return Effect.gen(function* () {
      for (const index of invalidNames.keys()) {
        const error = yield* loadFailureOf(`invalid-metadata-${String(index)}`)
        expect(error).toMatchObject({
          _tag: 'SaveDecodeError',
          format: SESSION_FORMAT_NAME,
          version: SESSION_FORMAT_VERSION,
        })
      }
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('lists only valid canonical session heads in lexical session id order', () => {
    const storage = controlledStorage()
    const specialSessionId = 'world / %?'
    const oversizedLegacySessionId = 'w'.repeat(129)

    return Effect.gen(function* () {
      yield* saveSession({
        sessionId: specialSessionId,
        revision: 'r1',
        state: sessionState(3),
        chunks: [],
      })
      yield* saveSession({
        sessionId: 'alpha',
        revision: 'r2',
        metadata: { name: 'Alpha Display', mode: 'creative' },
        state: sessionState(1),
        chunks: [],
      })
      // A well-formed but pre-current-version envelope is skipped exactly like
      // a structurally corrupt one (mc-save 0.3.0 removed migrations; there is
      // no version this repository still knows how to bring forward).
      storage.setEnvelope(sessionHeadKey('legacy-v7'), {
        format: SESSION_FORMAT_NAME,
        version: 7,
        payload: {
          sessionId: 'legacy-v7',
          revision: 'legacy',
          state: storedRecord(sessionState(7)),
          chunks: [],
        },
      })
      storage.setEnvelope(sessionHeadKey('corrupted'), {
        format: SESSION_FORMAT_NAME,
        version: 7,
        payload: { invalid: true },
      })
      storage.setEnvelope(sessionHeadKey(oversizedLegacySessionId), {
        format: SESSION_FORMAT_NAME,
        version: 7,
        payload: {
          sessionId: oversizedLegacySessionId,
          revision: 'legacy-oversized',
          state: storedRecord(sessionState(8)),
          chunks: [],
        },
      })
      storage.setEnvelope('unrelated/head', {
        format: SESSION_FORMAT_NAME,
        version: 7,
        payload: {},
      })
      storage.setEnvelope('mc-compose/session/%61lpha/head', storage.envelope(sessionHeadKey('alpha'))!)
      storage.setEnvelope('mc-compose/session/%E0%A4%A/head', storage.envelope(sessionHeadKey('alpha'))!)
      storage.setEnvelope('mc-compose/session/alpha/revision/orphan/head', {
        format: SESSION_FORMAT_NAME,
        version: 7,
        payload: {},
      })

      const sessions = yield* listSessions()

      expect(sessions.map(({ sessionId }) => sessionId)).toEqual([
        'alpha',
        specialSessionId,
      ])
      expect(sessions.map(({ revision }) => revision)).toEqual(['r2', 'r1'])
      expect(sessions.map(({ metadata }) => metadata)).toEqual([
        { name: 'Alpha Display', mode: 'creative' },
        defaultMetadata,
      ])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('deletes a session including orphan revisions without touching another session', () => {
    const storage = controlledStorage()
    const deletedSessionId = 'world / one'
    const headlessSessionId = 'headless'
    const retainedSessionId = 'world / one-more'

    return Effect.gen(function* () {
      yield* saveSession({
        sessionId: deletedSessionId,
        revision: 'current',
        state: sessionState(1),
        chunks: [dimensionChunk('overworld', 0, 0, 4)],
      })
      yield* saveSession({
        sessionId: retainedSessionId,
        revision: 'current',
        state: sessionState(2),
        chunks: [dimensionChunk('overworld', 1, 0, 7)],
      })
      const orphanKey = sessionChunkKey(
        deletedSessionId,
        'orphan',
        'nether',
        coordOf(-2, 3),
      )
      storage.setEnvelope(orphanKey, storage.envelope(
        sessionChunkKey(deletedSessionId, 'current', 'overworld', coordOf(0, 0)),
      )!)
      storage.setEnvelope(sessionHeadKey(deletedSessionId), {
        format: SESSION_FORMAT_NAME,
        version: 7,
        payload: { invalid: true },
      })
      const headlessOrphanKey = sessionChunkKey(
        headlessSessionId,
        'orphan',
        'end',
        coordOf(4, -1),
      )
      storage.setEnvelope(headlessOrphanKey, storage.envelope(orphanKey)!)

      yield* deleteSession(deletedSessionId)
      yield* deleteSession(headlessSessionId)

      expect(storage.keys.some((key) =>
        key.startsWith(`mc-compose/session/${encodeURIComponent(deletedSessionId)}/`),
      )).toBe(false)
      expect(storage.keys).not.toContain(headlessOrphanKey)
      expect(storage.keys).toContain(sessionHeadKey(retainedSessionId))
      expect(storage.keys).toContain(
        sessionChunkKey(retainedSessionId, 'current', 'overworld', coordOf(1, 0)),
      )
      expect(Option.isSome(yield* loadSession(retainedSessionId))).toBe(true)
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('round-trips partially damaged equipped tools', () => {
    const storage = controlledStorage()
    const initialStorage = storageFromInventory({ slots: flintAndSteelSlots() })
    const damagedStorage = {
      ...initialStorage,
      inventoryDurability: initialStorage.inventoryDurability.map((durability, index) =>
        index === 0 ? { current: 17, max: FLINT_AND_STEEL_MAX_DURABILITY } : durability,
      ),
    }
    const equippedStorage = equipFromInventory(damagedStorage, 0, 'offhand').storage

    return Effect.gen(function* () {
      yield* saveSession({
        sessionId: 'durable-equipment',
        revision: 'r1',
        state: { ...sessionState(42), storage: equippedStorage },
        chunks: [],
      })

      const loaded = Option.getOrThrow(yield* loadSession('durable-equipment'))
      expect(loaded.state.storage).toEqual(equippedStorage)
      expect(loaded.state.storage.equipment.slots.offhand).toMatchObject({
        item: 'flint_and_steel',
        count: 1,
        durability: { current: 17, max: FLINT_AND_STEEL_MAX_DURABILITY },
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects a player storage that violates durability invariants', () => {
    const storage = controlledStorage()
    const key = sessionHeadKey('invalid-storage-durability')
    const validStorage = storageFromInventory({ slots: flintAndSteelSlots() })
    storage.setEnvelope(key, {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId: 'invalid-storage-durability',
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(sessionState(42), {
          storage: {
            ...storedField({ ...sessionState(42), storage: validStorage }, 'storage'),
            inventoryDurability: Array.from({ length: INVENTORY_SLOT_COUNT }, () => null),
          },
        }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf('invalid-storage-durability')

      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
      })
      expect(storage.envelope(key)?.version).toBe(SESSION_FORMAT_VERSION)
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('keeps equal chunk coordinates distinct across dimensions', () => {
    const storage = controlledStorage()
    const fallback: ChunkSource = (coord) => Effect.succeed(chunk(coord.cx, coord.cz, 9))

    return Effect.gen(function* () {
      const head = yield* saveSession({
        sessionId: 'dimension-coordinates',
        revision: 'r1',
        state: sessionState(42),
        chunks: [dimensionChunk('overworld', 0, 0, 3), dimensionChunk('nether', 0, 0, 7)],
      })
      const overworld = yield* makeSessionChunkSource(head, 'overworld', fallback)
      const nether = yield* makeSessionChunkSource(head, 'nether', fallback)

      expect(head.chunks.map(({ dimension }) => dimension)).toEqual(['overworld', 'nether'])
      expect(head.chunks[0]!.key).toContain('/dimension/overworld/chunk/0/0')
      expect(head.chunks[1]!.key).toContain('/dimension/nether/chunk/0/0')
      expect(Effect.runSync(overworld.source(coordOf(0, 0))).blocks[0]).toBe(3)
      expect(Effect.runSync(nether.source(coordOf(0, 0))).blocks[0]).toBe(7)
      expect(overworld.chunks).toHaveLength(2)
    }).pipe(Effect.provide(storage.layer))
  })


  // mc-save 0.8 refuses to seal a payload with a non-finite number, so such a
  // session can no longer reach `loadSession`'s schema through storage.
  it('refuses to store non-finite persisted vitals', () => {
    const sealed = sealSaveEnvelope({
      format: SaveFormatName(SESSION_FORMAT_NAME),
      version: SaveFormatVersion(SESSION_FORMAT_VERSION),
      payload: {
        sessionId: 'non-finite-vitals',
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(sessionState(42), {
          vitals: { ...sessionState(42).vitals, healthPoints: Number.POSITIVE_INFINITY },
        }),
        chunks: [],
      },
    })

    expect(Result.isFailure(sealed)).toBe(true)
    expect(Result.isFailure(sealed) ? sealed.failure : undefined).toMatchObject({
      _tag: 'SaveDecodeError',
      reason: 'save contains a non-finite number',
    })
  })

  it.effect('rejects persisted simulation time that violates invariants', () => {
    const storage = controlledStorage()
    const key = sessionHeadKey('invalid-time')
    storage.setEnvelope(key, {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId: 'invalid-time',
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(sessionState(42), { time: { ticks: -1, dayLengthTicks: 24_000 } }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf('invalid-time')

      expect(error).toMatchObject({ _tag: 'SaveDecodeError', version: SESSION_FORMAT_VERSION })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects persisted weather that violates simulation invariants', () => {
    const storage = controlledStorage()
    const key = sessionHeadKey('invalid-weather')
    storage.setEnvelope(key, {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId: 'invalid-weather',
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(sessionState(42), { weather: { weather: 'rain', remainingSecs: 0 } }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf('invalid-weather')

      expect(error).toMatchObject({ _tag: 'SaveDecodeError', version: SESSION_FORMAT_VERSION })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects persisted vitals that violate gameplay invariants', () => {
    const storage = controlledStorage()
    const key = sessionHeadKey('invalid-vitals')
    storage.setEnvelope(key, {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId: 'invalid-vitals',
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(sessionState(42), {
          vitals: { ...sessionState(42).vitals, healthPoints: 21, maxHealthPoints: 20 },
        }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf('invalid-vitals')

      expect(error).toMatchObject({ _tag: 'SaveDecodeError', version: SESSION_FORMAT_VERSION })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects invalid vitals on both save encoding and load decoding', () => {
    const storage = controlledStorage()
    const invalidState: SessionState = {
      ...sessionState(42),
      vitals: { ...sessionState(42).vitals, healthPoints: EntityHealthPoints(21), maxHealthPoints: EntityHealthPoints(20) },
    }
    const decodeSessionId = 'invalid-vitals-codec-decode'
    const encodeSessionId = 'invalid-vitals-codec-encode'
    storage.setEnvelope(sessionHeadKey(decodeSessionId), {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId: decodeSessionId,
        revision: 'r1',
        metadata: defaultMetadata,
        state: storedStateWith(sessionState(42), { vitals: invalidState.vitals }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const decodeError = yield* loadFailureOf(decodeSessionId)
      expect(decodeError).toMatchObject({
        _tag: 'SaveDecodeError',
        reason: 'the payload does not satisfy the current schema',
      })

      const encodeError = yield* Effect.flip(persistSession({
        sessionId: encodeSessionId,
        revision: 'r1',
        metadata: defaultMetadata,
        state: invalidState,
        chunks: [],
      }))
      expect(encodeError).toMatchObject({
        _tag: 'SaveDecodeError',
        reason: 'the value does not satisfy the format schema, so it cannot be encoded',
      })
      expect(storage.envelope(sessionHeadKey(encodeSessionId))).toBeUndefined()
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects a saved session containing an unknown inventory item id', () => {
    const storage = controlledStorage()
    const key = sessionHeadKey('unknown-item')
    const base = sessionState(42)
    storage.setEnvelope(key, {
      format: SESSION_FORMAT_NAME,
      version: SESSION_FORMAT_VERSION,
      payload: {
        sessionId: 'unknown-item',
        revision: 'r1',
        metadata: defaultMetadata,
        // The `item_from_an_unknown_build` slot is deliberately not an
        // `ItemType` this build knows.
        state: storedStateWith(base, {
          storage: {
            ...storedField(base, 'storage'),
            inventory: {
              slots: Array.from({ length: INVENTORY_SLOT_COUNT }, (_, index) =>
                index === 0 ? { item: 'item_from_an_unknown_build', count: 1, components: null } : null,
              ),
            },
          },
        }),
        chunks: [],
      },
    })

    return Effect.gen(function* () {
      const error = yield* loadFailureOf('unknown-item')

      expect(error).toMatchObject({
        _tag: 'SaveDecodeError',
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION,
      })
      expect(storage.envelope(key)).toBeDefined()
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('prefers saved chunks and falls back only for absent coordinates', () => {
    const storage = controlledStorage()
    const generated: Array<string> = []
    const fallback: ChunkSource = (coord) =>
      Effect.sync(() => {
        generated.push(`${String(coord.cx)},${String(coord.cz)}`)
        return chunk(coord.cx, coord.cz, 9)
      })

    return Effect.gen(function* () {
      const head = yield* saveSession({
        sessionId: 'source-order',
        revision: 'r1',
        state: sessionState(1),
        chunks: [dimensionChunk('overworld', 0, 0, 4)],
      })
      const loaded = yield* makeSessionChunkSource(head, 'overworld', fallback)
      loaded.chunks[0]!.chunk.blocks[0] = 8
      const persisted = Effect.runSync(loaded.source(coordOf(0, 0)))
      expect(persisted.blocks[0]).toBe(4)
      persisted.blocks[0] = 6
      const persistedAgain = Effect.runSync(loaded.source(coordOf(0, 0)))
      const missing = Effect.runSync(loaded.source(coordOf(1, 0)))

      expect(persistedAgain.blocks[0]).toBe(4)
      expect(loaded.chunks[0]!.chunk.blocks[0]).toBe(8)
      expect(missing.blocks[0]).toBe(9)
      expect(generated).toEqual(['1,0'])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects a manifest whose saved chunk key is missing', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      const head = yield* saveSession({
        sessionId: 'missing-chunk',
        revision: 'r1',
        state: sessionState(1),
        chunks: [],
      })
      const coord = coordOf(3, -2)
      const invalidHead = {
        ...head,
        chunks: [
          {
            dimension: 'overworld' as const,
            coord,
            key: sessionChunkKey(head.sessionId, head.revision, 'overworld', coord),
          },
        ],
      }
      const error = yield* Effect.flip(
        makeSessionChunkSource(invalidHead, 'overworld', (missingCoord) =>
          Effect.succeed(chunk(missingCoord.cx, missingCoord.cz, 9)),
        ),
      )

      expect(error).toMatchObject({
        _tag: 'SessionManifestError',
        reason: 'missing-chunk',
        dimension: 'overworld',
        coord,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects duplicate coordinates in the manifest', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      const head = yield* saveSession({
        sessionId: 'duplicate-coordinate',
        revision: 'r1',
        state: sessionState(1),
        chunks: [dimensionChunk('overworld', 0, 0, 4)],
      })
      const duplicateHead = { ...head, chunks: [head.chunks[0]!, head.chunks[0]!] }
      const error = yield* Effect.flip(
        makeSessionChunkSource(duplicateHead, 'overworld', (coord) =>
          Effect.succeed(chunk(coord.cx, coord.cz, 9)),
        ),
      )

      expect(error).toMatchObject({
        _tag: 'SessionManifestError',
        reason: 'duplicate-coordinate',
        dimension: 'overworld',
        coord: coordOf(0, 0),
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects duplicate save coordinates before writing chunks', () => {
    const storage = controlledStorage()
    const coord = coordOf(2, -1)
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        saveSession({
          sessionId: 'duplicate-save',
          revision: 'r1',
          state: sessionState(1),
          chunks: [
            dimensionChunk('overworld', coord.cx, coord.cz, 4),
            dimensionChunk('overworld', coord.cx, coord.cz, 7),
          ],
        }),
      )

      expect(error).toMatchObject({
        _tag: 'SessionManifestError',
        reason: 'duplicate-coordinate',
        dimension: 'overworld',
        coord,
      })
      expect(storage.chunkWriteCount).toBe(0)
      expect(Option.isNone(yield* loadSession('duplicate-save'))).toBe(true)
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('does not publish a new head when a chunk write fails', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveSession({
        sessionId: 'chunk-failure',
        revision: 'r1',
        state: sessionState(1),
        chunks: [dimensionChunk('overworld', 0, 0, 1)],
      })
      const failedKey = sessionChunkKey('chunk-failure', 'r2', 'overworld', coordOf(1, 0))
      storage.failChunkKey = failedKey
      const error = yield* Effect.flip(
        saveSession({
          sessionId: 'chunk-failure',
          revision: 'r2',
          state: sessionState(2),
          chunks: [
            dimensionChunk('overworld', 0, 0, 2),
            dimensionChunk('overworld', 1, 0, 3),
          ],
        }),
      )

      const loaded = Option.getOrThrow(yield* loadSession('chunk-failure'))
      expect(error).toMatchObject({ _tag: 'StorageError', operation: 'put', key: failedKey })
      expect(loaded.revision).toBe('r1')
      expect(loaded.state.seed).toBe(1)
      expect(storage.keys.filter((key) => key.includes('/revision/r2/'))).toEqual([])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('restores the previous head when publishing the new head fails', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveSession({
        sessionId: 'head-failure',
        revision: 'r1',
        state: sessionState(1),
        chunks: [dimensionChunk('overworld', 0, 0, 1)],
      })
      storage.failNextHeadWrite = true
      const error = yield* Effect.flip(
        saveSession({
          sessionId: 'head-failure',
          revision: 'r2',
          state: sessionState(2),
          chunks: [dimensionChunk('overworld', 0, 0, 2)],
        }),
      )

      const loaded = Option.getOrThrow(yield* loadSession('head-failure'))
      expect(error).toMatchObject({
        _tag: 'StorageError',
        operation: 'put',
        key: sessionHeadKey('head-failure'),
      })
      expect(loaded.revision).toBe('r1')
      expect(loaded.state.seed).toBe(1)
      expect(storage.keys.filter((key) => key.includes('/revision/r2/'))).toEqual([])
      expect(sessionHeadKey('head-failure')).toContain('/head')
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('restores overwritten chunk records when a same-revision save fails', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveSession({
        sessionId: 'same-revision-failure',
        revision: 'r1',
        state: sessionState(1),
        chunks: [dimensionChunk('overworld', 0, 0, 1)],
      })
      storage.failChunkKey = sessionChunkKey(
        'same-revision-failure',
        'r1',
        'overworld',
        coordOf(1, 0),
      )
      yield* Effect.flip(
        saveSession({
          sessionId: 'same-revision-failure',
          revision: 'r1',
          state: sessionState(2),
          chunks: [
            dimensionChunk('overworld', 0, 0, 8),
            dimensionChunk('overworld', 1, 0, 9),
          ],
        }),
      )

      const head = Option.getOrThrow(yield* loadSession('same-revision-failure'))
      const loaded = yield* makeSessionChunkSource(head, 'overworld', (coord) =>
        Effect.succeed(chunk(coord.cx, coord.cz, 7)),
      )
      expect(head.state.seed).toBe(1)
      expect(Effect.runSync(loaded.source(coordOf(0, 0))).blocks[0]).toBe(1)
      // The first save of r1 was copied to the checkpoint before the failed publish.
      expect(storage.keys.filter((key) => key.includes('/chunk/')).sort()).toEqual([
        'mc-compose/session/same-revision-failure/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
        'mc-compose/session/same-revision-failure/revision/r1/dimension/overworld/chunk/0/0',
      ])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('keeps storage bounded to the live revision and one checkpoint across revisions', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveSession({
        sessionId: 'bounded',
        revision: 'r1',
        state: sessionState(1),
        chunks: [dimensionChunk('overworld', 0, 0, 1), dimensionChunk('overworld', 1, 0, 1)],
      })
      yield* saveSession({
        sessionId: 'bounded',
        revision: 'r2',
        state: sessionState(2),
        chunks: [dimensionChunk('overworld', 2, 0, 2)],
      })

      expect([...storage.keys].sort()).toEqual([
        'mc-compose/session/bounded/checkpoint/head',
        'mc-compose/session/bounded/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
        'mc-compose/session/bounded/checkpoint/revision/r1/dimension/overworld/chunk/1/0',
        'mc-compose/session/bounded/head',
        'mc-compose/session/bounded/revision/r2/dimension/overworld/chunk/2/0',
      ])

      yield* saveSession({
        sessionId: 'bounded',
        revision: 'r3',
        state: sessionState(3),
        chunks: [],
      })
      expect([...storage.keys].sort()).toEqual([
        'mc-compose/session/bounded/checkpoint/head',
        'mc-compose/session/bounded/checkpoint/revision/r2/dimension/overworld/chunk/2/0',
        'mc-compose/session/bounded/head',
      ])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('does not fail a published save when old-revision cleanup fails', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveSession({
        sessionId: 'cleanup-failure',
        revision: 'r1',
        state: sessionState(1),
        chunks: [dimensionChunk('overworld', 0, 0, 1)],
      })
      storage.failChunkRemoves = true
      const saved = yield* saveSession({
        sessionId: 'cleanup-failure',
        revision: 'r2',
        state: sessionState(2),
        chunks: [dimensionChunk('overworld', 1, 0, 2)],
      })

      expect(saved.revision).toBe('r2')
      expect(Option.getOrThrow(yield* loadSession('cleanup-failure')).revision).toBe('r2')
      expect(storage.keys.filter((key) => key.includes('/chunk/')).sort()).toEqual([
        'mc-compose/session/cleanup-failure/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
        'mc-compose/session/cleanup-failure/revision/r1/dimension/overworld/chunk/0/0',
        'mc-compose/session/cleanup-failure/revision/r2/dimension/overworld/chunk/1/0',
      ])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('round-trips item stacks whose components differ from the item defaults', () => {
    const storage = controlledStorage()
    const sword = Result.getOrThrow(itemStack('diamond_sword', 1))
    const damagedSword = Result.getOrThrow(itemStack('diamond_sword', 1, {
      components: { ...sword.components, damage: ItemDamage(17) },
    }))
    const pickaxe = Result.getOrThrow(itemStack('diamond_pickaxe', 1))
    const repairedPickaxe = Result.getOrThrow(itemStack('diamond_pickaxe', 1, {
      components: { ...pickaxe.components, repairCost: RepairCost(3) },
    }))
    const state: SessionState = {
      ...sessionState(42),
      storage: storageFromInventory({
        slots: Array.from({ length: INVENTORY_SLOT_COUNT }, (_, index) =>
          index === 0 ? damagedSword : index === 1 ? repairedPickaxe : undefined),
      }),
    }

    return Effect.gen(function* () {
      yield* saveSession({ sessionId: 'non-default-components', revision: 'r1', state, chunks: [] })
      const loaded = Option.getOrThrow(yield* loadSession('non-default-components'))
      const [first, second] = loaded.state.storage.inventory.slots

      expect(itemStackEqualsIgnoringCount(damagedSword, sword)).toBe(false)
      expect(first !== undefined && itemStackEqualsIgnoringCount(first, damagedSword)).toBe(true)
      expect(first?.count).toBe(damagedSword.count)
      expect(second !== undefined && itemStackEqualsIgnoringCount(second, repairedPickaxe)).toBe(true)
      expect(second?.count).toBe(repairedPickaxe.count)
    }).pipe(Effect.provide(storage.layer))
  })

  describe('v17 saves written by the mc-sim 0.4 build', () => {
    // Envelopes captured verbatim from the previous build (Effect 3, mc-save
    // 0.4, mc-sim 0.4) through its own `saveSession`; they are not produced by
    // the code under test.
    const fixtureEnvelope = (name: string): SaveEnvelope =>
      Schema.decodeUnknownSync(SaveEnvelopeSchema)(parseJson(fixtureEnvelopeText(name)))

    const seedFixture = (storage: ControlledStorage, sessionId: string, name: string): SaveEnvelope => {
      const envelope = fixtureEnvelope(name)
      storage.setEnvelope(sessionHeadKey(sessionId), envelope)
      return envelope
    }

    // v17 -> v18 values for fields v17 never recorded (same table as the
    // migration in apps/web/session-persistence.ts): station 'furnace',
    // cookProgressSecs = cookElapsedSecs, fuelTimeRemainingSecs =
    // fuelTimeTotalSecs = burnRemainingSecs.
    it.effect('migrates a stackless v17 save to v18 without changing its game state', () => {
      const storage = controlledStorage()
      const envelope = seedFixture(storage, 'v17-stackless-fixture', 'session-v17-stackless-envelope.json')
      return Effect.gen(function* () {
        expect(envelope.version).toBe(17)
        const loaded = Option.getOrThrow(yield* loadSession('v17-stackless-fixture'))

        expect(loaded.state.furnaces).toEqual([{
          dimension: 'overworld',
          position: { x: 1, y: 64, z: 2 },
          state: {
            station: 'furnace',
            input: undefined,
            fuel: undefined,
            output: undefined,
            fuelTimeRemainingSecs: 60,
            fuelTimeTotalSecs: 60,
            cookProgressSecs: 4.5,
          },
        }])
        expect(loaded.state.containerStorage).toEqual({
          version: 3,
          containers: [{
            id: 'overworld:4,65,-2',
            kind: 'chest',
            slots: Array.from({ length: 27 }, () => null),
          }],
        })
        // Status effects carry their recorded amplifiers unchanged (pufferfish
        // poison IV and hunger III from the old build's `applyStatusEffect`).
        expect(loaded.state.statusEffects).toEqual({
          effects: [
            { type: 'poison', remainingSecs: 60, pulseClockSecs: 0, amplifier: 3 },
            { type: 'speed', remainingSecs: 30, pulseClockSecs: 0, amplifier: 0 },
            { type: 'hunger', remainingSecs: 15, pulseClockSecs: 0, amplifier: 2 },
          ],
        })
        expect(loaded.state.brewing).toEqual(Result.getOrThrow(emptyBrewingState()))
        expect(loaded.state.storage.inventory.slots.every((slot) => slot === undefined)).toBe(true)
        expect(loaded.state.vitals).toMatchObject({ healthPoints: 13, hungerPoints: 17, lastDamageCause: 'fall' })
        expect(loaded.state.mountedVehicleId).toBe('v:7')
      }).pipe(Effect.provide(storage.layer))
    })

    it.effect('re-reads a migrated stackless v17 save unchanged after writing it as v18', () => {
      const storage = controlledStorage()
      seedFixture(storage, 'v17-stackless-fixture', 'session-v17-stackless-envelope.json')
      return Effect.gen(function* () {
        const migrated = Option.getOrThrow(yield* loadSession('v17-stackless-fixture'))
        yield* persistSession({
          sessionId: migrated.sessionId,
          revision: 'r2',
          metadata: migrated.metadata,
          state: migrated.state,
          chunks: [],
        })
        const reread = Option.getOrThrow(yield* loadSession('v17-stackless-fixture'))

        expect(storage.envelope(sessionHeadKey('v17-stackless-fixture'))?.version).toBe(SESSION_FORMAT_VERSION)
        expect(reread.state).toEqual(migrated.state)
      }).pipe(Effect.provide(storage.layer))
    })

    // v17 stacks had no components; they migrate to `components: null`,
    // which mc-sim's `LegacyItemStackSchema` reads as the item's defaults.
    it.effect('migrates a v17 save with item stacks to v18 without changing its game state', () => {
      const storage = controlledStorage()
      seedFixture(storage, 'v17-fixture', 'session-v17-envelope.json')
      return Effect.gen(function* () {
        const loaded = Option.getOrThrow(yield* loadSession('v17-fixture'))
        const stack = (item: 'stone' | 'flint_and_steel' | 'raw_iron' | 'coal', count: number) =>
          Result.getOrThrow(itemStack(item, count))

        expect(loaded.state.storage.inventory.slots[0]).toEqual(stack('stone', 12))
        expect(loaded.state.storage.inventory.slots[1]).toEqual(stack('flint_and_steel', 1))
        expect(loaded.state.storage.inventory.slots.slice(2).every((slot) => slot === undefined)).toBe(true)
        expect(loaded.state.storage.inventoryDurability[1]).toEqual({ current: 64, max: 64 })
        expect(loaded.state.containerStorage).toEqual({
          version: 3,
          containers: [{
            id: 'overworld:4,65,-2',
            kind: 'chest',
            slots: Array.from({ length: 27 }, (_, index) =>
              index === 0 ? { ...stack('stone', 12), durability: null } : null),
          }],
        })
        const furnace = loaded.state.furnaces[0]?.state
        expect(furnace).toEqual({
          station: 'furnace',
          input: stack('raw_iron', 3),
          fuel: stack('coal', 2),
          output: undefined,
          fuelTimeRemainingSecs: 60,
          fuelTimeTotalSecs: 60,
          cookProgressSecs: 4.5,
        })
        // v17 raw_iron took 10 s with 4.5 s elapsed, so the first ingot is
        // still due 5.5 s after loading.
        if (furnace === undefined) throw new Error('fixture furnace must load')
        const justBefore = Result.getOrThrow(advanceFurnace(furnace, 5.4))
        const atCompletion = Result.getOrThrow(advanceFurnace(furnace, 5.5))
        expect(justBefore.smeltedCount).toBe(0)
        expect(atCompletion.smeltedCount).toBe(1)
      }).pipe(Effect.provide(storage.layer))
    })

    it.effect('re-reads a migrated v17 save with item stacks unchanged after writing it as v18', () => {
      const storage = controlledStorage()
      seedFixture(storage, 'v17-fixture', 'session-v17-envelope.json')
      return Effect.gen(function* () {
        const migrated = Option.getOrThrow(yield* loadSession('v17-fixture'))
        yield* persistSession({
          sessionId: migrated.sessionId,
          revision: 'r2',
          metadata: migrated.metadata,
          state: migrated.state,
          chunks: [],
        })
        const reread = Option.getOrThrow(yield* loadSession('v17-fixture'))

        expect(reread.state).toEqual(migrated.state)
      }).pipe(Effect.provide(storage.layer))
    })

    const brewingStack = (item: 'awkward_potion' | 'sugar' | 'blaze_powder', count: number) =>
      Result.getOrThrow(itemStack(item, count))

    // Old brewing stands, from the old build's own `acceptBrewingFuel`,
    // `acceptBrewingBottle`, `acceptBrewingIngredient`, and `tickBrewingStand`.
    it.effect('completes a v17 brew in progress into bottle slot 0 without refunding its fuel', () => {
      const storage = controlledStorage()
      const envelope = seedFixture(storage, 'v17-brewing-in-progress', 'session-v17-brewing-in-progress-envelope.json')
      return Effect.gen(function* () {
        // 3 fuel units, a water bottle, and nether wart, ticked 5 s into the brew.
        expect(envelope.payload).toMatchObject({
          state: {
            brewing: {
              fuelUnits: 2,
              bottle: 'water_bottle',
              ingredient: null,
              brewing: { output: 'awkward', remainingSecs: 15 },
            },
          },
        })
        const loaded = Option.getOrThrow(yield* loadSession('v17-brewing-in-progress'))

        expect(loaded.state.brewing).toEqual({
          bottles: [brewingStack('awkward_potion', 1), undefined, undefined],
          ingredient: undefined,
          fuel: undefined,
          fuelCharges: 2,
          brewProgressSecs: 0,
        })
      }).pipe(Effect.provide(storage.layer))
    })

    it.effect('moves a v17 bottle and ingredient into slot 0 and keeps 5 fuel units as 5 charges', () => {
      const storage = controlledStorage()
      seedFixture(storage, 'v17-brewing-fuel-5', 'session-v17-brewing-fuel-5-envelope.json')
      return Effect.gen(function* () {
        const loaded = Option.getOrThrow(yield* loadSession('v17-brewing-fuel-5'))

        expect(loaded.state.brewing).toEqual({
          bottles: [brewingStack('awkward_potion', 1), undefined, undefined],
          ingredient: brewingStack('sugar', 1),
          fuel: undefined,
          fuelCharges: 5,
          brewProgressSecs: 0,
        })
      }).pipe(Effect.provide(storage.layer))
    })

    it.effect('keeps 20 of 45 v17 fuel units as charges and the excess as ceil(25 / 20) blaze powder', () => {
      const storage = controlledStorage()
      seedFixture(storage, 'v17-brewing-fuel-45', 'session-v17-brewing-fuel-45-envelope.json')
      return Effect.gen(function* () {
        const loaded = Option.getOrThrow(yield* loadSession('v17-brewing-fuel-45'))

        expect(loaded.state.brewing).toEqual({
          bottles: [undefined, undefined, undefined],
          ingredient: undefined,
          fuel: brewingStack('blaze_powder', 2),
          fuelCharges: 20,
          brewProgressSecs: 0,
        })
      }).pipe(Effect.provide(storage.layer))
    })

    it.effect('fails the migration when the v17 fuel excess needs more than one stack of blaze powder', () => {
      const storage = controlledStorage()
      seedFixture(storage, 'v17-brewing-fuel-overflow', 'session-v17-brewing-fuel-overflow-envelope.json')
      return Effect.gen(function* () {
        // 1301 units: 20 charges plus ceil(1281 / 20) = 65 blaze powder, one over a stack of 64.
        const error = yield* loadFailureOf('v17-brewing-fuel-overflow')

        expect(error).toMatchObject({
          _tag: 'SaveDecodeError',
          version: 17,
          reason: 'the payload could not be migrated from v17 to v18',
          cause: { _tag: 'V17BrewingFuelOverflow', fuelUnits: 1301, fuelItemCount: 65, maxStackCount: 64 },
        })
      }).pipe(Effect.provide(storage.layer))
    })
  })

  // A save edited by hand can hold `1e999`, which JSON parses to Infinity.
  // mc-save's envelope validation rejects it before the session schema runs.
  it.effect('rejects a stored save whose JSON holds 1e999 before decoding the session', () => {
    const storage = controlledStorage()
    // The recorded integrity no longer matches; mc-save checks finiteness first.
    const editedText = fixtureEnvelopeText('session-v17-stackless-envelope.json')
      .replace('"remainingSecs":123.5', '"remainingSecs":1e999')
    storage.setEnvelope(
      sessionHeadKey('v17-stackless-fixture'),
      Schema.decodeUnknownSync(SaveEnvelopeSchema)(parseJson(editedText)),
    )

    return Effect.gen(function* () {
      const error = yield* loadFailureOf('v17-stackless-fixture')

      expect(error).toMatchObject({ _tag: 'SaveDecodeError', reason: 'save contains a non-finite number' })
    }).pipe(Effect.provide(storage.layer))
  })
})

describe('session checkpoint and compatibility', () => {
  // Keeps the record's integrity block, so its checksum no longer matches.
  const tamper = (storage: ControlledStorage, key: string): void => {
    const envelope = storage.envelope(key)
    if (envelope === undefined) throw new Error(`no record at ${key}`)
    storage.setEnvelope(key, { ...envelope, payload: { tampered: true } })
  }

  const storedSnapshot = (storage: ControlledStorage): ReadonlyArray<readonly [string, string]> =>
    storage.keys.map((key): readonly [string, string] => [key, JSON.stringify(storage.envelope(key))])

  // One chunk source per head: each one decodes every chunk the manifest lists.
  const savedMarkers = (head: SessionHead) =>
    makeSessionChunkSource(head, 'overworld', (coord) => Effect.succeed(chunk(coord.cx, coord.cz, 99))).pipe(
      Effect.map((loaded) => head.chunks.map(({ coord }) => Effect.runSync(loaded.source(coord)).blocks[0])),
    )

  const saveRevision = (sessionId: string, revision: string, seed: number, markers: ReadonlyArray<number>) =>
    saveSession({
      sessionId,
      revision,
      state: sessionState(seed),
      chunks: markers.map((marker, cx) => dimensionChunk('overworld', cx, 0, marker)),
    })

  const sealedHeadDraft = (sessionId: string, version: number) => ({
    format: SESSION_FORMAT_NAME,
    version,
    payload: {
      sessionId,
      revision: 'other-build',
      metadata: defaultMetadata,
      state: storedRecord(sessionState(9)),
      chunks: [],
    },
  })

  it.effect('opens the live revision that a save published', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      const saved = yield* saveRevision('live-world', 'r1', 1, [3, 4])

      const opened = Option.getOrThrow(yield* openSession('live-world'))

      expect(opened).toEqual({ _tag: 'Live', head: saved })
      expect(sessionOpenNotice(opened)).toEqual(Option.none())
      expect(yield* savedMarkers(opened.head)).toEqual([3, 4])
      expect(Option.isNone(yield* openSession('absent-world'))).toBe(true)
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('copies the previous revision to the checkpoint and opens it when the live head is corrupt', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('checkpointed', 'r1', 1, [3])
      yield* saveRevision('checkpointed', 'r2', 2, [5])
      expect(storage.keys).toContain('mc-compose/session/checkpointed/checkpoint/head')
      tamper(storage, 'mc-compose/session/checkpointed/head')

      const opened = Option.getOrThrow(yield* openSession('checkpointed'))

      assert(opened._tag === 'Checkpoint')
      expect(opened.head.revision).toBe('r1')
      expect(opened.head.state.seed).toBe(1)
      expect(opened.head.chunks).toEqual([{
        dimension: 'overworld',
        coord: coordOf(0, 0),
        key: 'mc-compose/session/checkpointed/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
      }])
      expect(opened.liveFailure).toMatchObject({
        _tag: 'SaveDecodeError',
        record: { _tag: 'Head', key: 'mc-compose/session/checkpointed/head' },
        repair: { lastHealthyRevisionAvailable: true },
      })
      expect(yield* savedMarkers(opened.head)).toEqual([3])
      expect(sessionOpenNotice(opened)).toEqual(
        Option.some('The latest save could not be read. The previous save was opened instead.'),
      )
      expect(yield* listSessionEntries()).toEqual({ sessions: [opened.head], unavailable: [] })
      expect(yield* listSessions()).toEqual([opened.head])
      expect(yield* loadSession('checkpointed')).toEqual(Option.some(opened.head))
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('keeps the healthy checkpoint when a save replaces a corrupt live head', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('recovering', 'r1', 1, [3])
      yield* saveRevision('recovering', 'r2', 2, [5])
      tamper(storage, 'mc-compose/session/recovering/head')

      const saved = yield* saveRevision('recovering', 'r3', 3, [7])

      expect(yield* openSession('recovering')).toEqual(Option.some({ _tag: 'Live', head: saved }))
      // The unreadable r2 head named no chunks, so its chunk stays until deleteSession.
      expect(storage.keys).toContain('mc-compose/session/recovering/revision/r2/dimension/overworld/chunk/0/0')
      tamper(storage, 'mc-compose/session/recovering/head')
      const opened = Option.getOrThrow(yield* openSession('recovering'))
      assert(opened._tag === 'Checkpoint')
      expect(opened.head.revision).toBe('r1')
      expect(yield* savedMarkers(opened.head)).toEqual([3])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('opens the checkpoint when a live chunk is missing', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('missing-live-chunk', 'r1', 1, [3])
      yield* saveRevision('missing-live-chunk', 'r2', 2, [5])
      storage.removeEnvelope('mc-compose/session/missing-live-chunk/revision/r2/dimension/overworld/chunk/0/0')

      const opened = Option.getOrThrow(yield* openSession('missing-live-chunk'))

      assert(opened._tag === 'Checkpoint')
      expect(opened.head.revision).toBe('r1')
      expect(opened.liveFailure).toMatchObject({
        _tag: 'SaveDecodeError',
        record: {
          _tag: 'Chunk',
          key: 'mc-compose/session/missing-live-chunk/revision/r2/dimension/overworld/chunk/0/0',
        },
        repair: {
          lastHealthyRevisionAvailable: true,
          discardableChunkKeys: ['mc-compose/session/missing-live-chunk/revision/r2/dimension/overworld/chunk/0/0'],
        },
      })
      expect(yield* savedMarkers(opened.head)).toEqual([3])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('opens the checkpoint when a live chunk is corrupt', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('corrupt-live-chunk', 'r1', 1, [3])
      // The damaged chunk is the second, so the first one decodes before it fails.
      yield* saveRevision('corrupt-live-chunk', 'r2', 2, [5, 6])
      tamper(storage, 'mc-compose/session/corrupt-live-chunk/revision/r2/dimension/overworld/chunk/1/0')

      const opened = Option.getOrThrow(yield* openSession('corrupt-live-chunk'))

      assert(opened._tag === 'Checkpoint')
      expect(opened.head.revision).toBe('r1')
      expect(opened.liveFailure).toMatchObject({
        _tag: 'SaveDecodeError',
        record: {
          _tag: 'Chunk',
          key: 'mc-compose/session/corrupt-live-chunk/revision/r2/dimension/overworld/chunk/1/0',
        },
      })
      expect(yield* savedMarkers(opened.head)).toEqual([3])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('refuses to open, overwrite, or list a session saved by a newer build', () => {
    const storage = controlledStorage()
    const incompatible = {
      _tag: 'SessionIncompatibleError',
      reason: 'future-version',
      key: 'mc-compose/session/future/head',
      storedVersion: 19,
      currentVersion: 18,
    }
    return Effect.gen(function* () {
      yield* saveRevision('future', 'r1', 1, [3])
      yield* saveRevision('future', 'r2', 2, [5])
      storage.setEnvelope('mc-compose/session/future/head', sealedHeadDraft('future', 19))

      // The checkpoint is readable, but an older copy must not hide the newer save.
      const openError = yield* Effect.flip(openSession('future'))
      expect(openError).toMatchObject(incompatible)
      expect(sessionOpenFailureMessage(openError)).toBe('This world was saved by a newer version and cannot be opened.')
      expect(sessionLoadErrorOf(openError)).toBe('future-version-session')
      const before = storedSnapshot(storage)
      const mutations = storage.mutationCount
      expect(yield* Effect.flip(saveRevision('future', 'r3', 3, [7]))).toMatchObject(incompatible)
      expect(storedSnapshot(storage)).toEqual(before)
      expect(storage.mutationCount).toBe(mutations)
      const entries = yield* listSessionEntries()
      expect(entries.sessions).toEqual([])
      expect(entries.unavailable).toMatchObject([{ sessionId: 'future', failure: incompatible }])
      expect(yield* listSessions()).toEqual([])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('refuses to open or overwrite a session version without a migration path', () => {
    const storage = controlledStorage()
    const incompatible = {
      _tag: 'SessionIncompatibleError',
      reason: 'unsupported-version',
      key: 'mc-compose/session/legacy/head',
      storedVersion: 16,
      currentVersion: 18,
    }
    storage.setEnvelope('mc-compose/session/legacy/head', sealedHeadDraft('legacy', 16))
    return Effect.gen(function* () {
      const openError = yield* Effect.flip(openSession('legacy'))
      expect(openError).toMatchObject(incompatible)
      expect(sessionOpenFailureMessage(openError)).toBe(
        'This world was saved by an older version that can no longer be opened.',
      )
      expect(sessionLoadErrorOf(openError)).toBe('unsupported-version-session')
      const before = storedSnapshot(storage)
      expect(yield* Effect.flip(saveRevision('legacy', 'r1', 1, [3]))).toMatchObject(incompatible)
      expect(storedSnapshot(storage)).toEqual(before)
      expect((yield* listSessionEntries()).unavailable).toMatchObject([{ sessionId: 'legacy', failure: incompatible }])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('fails as corrupt when the live head and the checkpoint head are both unreadable', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('unreadable', 'r1', 1, [3])
      yield* saveRevision('unreadable', 'r2', 2, [5])
      tamper(storage, 'mc-compose/session/unreadable/head')
      tamper(storage, 'mc-compose/session/unreadable/checkpoint/head')
      const corrupt = {
        _tag: 'SessionCorruptError',
        sessionId: 'unreadable',
        liveFailure: {
          _tag: 'SaveDecodeError',
          record: { _tag: 'Head', key: 'mc-compose/session/unreadable/head' },
          repair: { lastHealthyRevisionAvailable: false },
        },
        checkpoint: {
          _tag: 'SaveDecodeError',
          record: { _tag: 'Head', key: 'mc-compose/session/unreadable/checkpoint/head' },
        },
      }

      const openError = yield* Effect.flip(openSession('unreadable'))
      expect(openError).toMatchObject(corrupt)
      expect(sessionOpenFailureMessage(openError)).toBe(
        'This world could not be read, and no earlier save of it could be opened.',
      )
      expect(sessionLoadErrorOf(openError)).toBe('corrupt-session')
      const entries = yield* listSessionEntries()
      expect(entries.sessions).toEqual([])
      expect(entries.unavailable).toMatchObject([{ sessionId: 'unreadable', failure: corrupt }])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('fails as corrupt when a checkpoint chunk is unreadable', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('partial-checkpoint', 'r1', 1, [3])
      yield* saveRevision('partial-checkpoint', 'r2', 2, [5])
      tamper(storage, 'mc-compose/session/partial-checkpoint/head')
      tamper(storage, 'mc-compose/session/partial-checkpoint/checkpoint/revision/r1/dimension/overworld/chunk/0/0')

      expect(yield* Effect.flip(openSession('partial-checkpoint'))).toMatchObject({
        _tag: 'SessionCorruptError',
        checkpoint: {
          _tag: 'SaveDecodeError',
          record: {
            _tag: 'Chunk',
            key: 'mc-compose/session/partial-checkpoint/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
          },
        },
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('fails as corrupt with an absent checkpoint when only one revision was saved', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('single-revision', 'r1', 1, [3])
      tamper(storage, 'mc-compose/session/single-revision/head')

      expect(yield* Effect.flip(openSession('single-revision'))).toMatchObject({
        _tag: 'SessionCorruptError',
        sessionId: 'single-revision',
        liveFailure: { _tag: 'SaveDecodeError', repair: { lastHealthyRevisionAvailable: false } },
        checkpoint: 'absent',
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('leaves the live revision unchanged when the checkpoint copy fails', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      const saved = yield* saveRevision('checkpoint-failure', 'r1', 1, [3])
      storage.failChunkKey =
        'mc-compose/session/checkpoint-failure/checkpoint/revision/r1/dimension/overworld/chunk/0/0'

      expect(yield* Effect.flip(saveRevision('checkpoint-failure', 'r2', 2, [5]))).toMatchObject({
        _tag: 'StorageError',
        operation: 'put',
        key: 'mc-compose/session/checkpoint-failure/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
      })
      expect(yield* openSession('checkpoint-failure')).toEqual(Option.some({ _tag: 'Live', head: saved }))
      expect(yield* savedMarkers(saved)).toEqual([3])
      expect([...storage.keys].sort()).toEqual([
        'mc-compose/session/checkpoint-failure/head',
        'mc-compose/session/checkpoint-failure/revision/r1/dimension/overworld/chunk/0/0',
      ])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('restores the previous live revision and keeps the checkpoint when publishing fails', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      const saved = yield* saveRevision('publish-failure', 'r1', 1, [3])
      storage.failChunkKey = 'mc-compose/session/publish-failure/revision/r2/dimension/overworld/chunk/1/0'

      expect(yield* Effect.flip(saveRevision('publish-failure', 'r2', 2, [5, 6]))).toMatchObject({
        _tag: 'StorageError',
        key: 'mc-compose/session/publish-failure/revision/r2/dimension/overworld/chunk/1/0',
      })
      expect(yield* openSession('publish-failure')).toEqual(Option.some({ _tag: 'Live', head: saved }))
      expect(yield* savedMarkers(saved)).toEqual([3])
      // r2's first chunk was published before the second failed; it is gone again.
      expect([...storage.keys].sort()).toEqual([
        'mc-compose/session/publish-failure/checkpoint/head',
        'mc-compose/session/publish-failure/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
        'mc-compose/session/publish-failure/head',
        'mc-compose/session/publish-failure/revision/r1/dimension/overworld/chunk/0/0',
      ])
      tamper(storage, 'mc-compose/session/publish-failure/head')
      const opened = Option.getOrThrow(yield* openSession('publish-failure'))
      assert(opened._tag === 'Checkpoint')
      expect(opened.head.revision).toBe('r1')
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('lists and deletes sessions without treating checkpoint records as sessions', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('kept', 'r1', 1, [3])
      yield* saveRevision('kept', 'r2', 2, [5])
      yield* saveRevision('deleted', 'r1', 1, [3])
      yield* saveRevision('deleted', 'r2', 2, [5])

      expect((yield* listSessions()).map(({ sessionId, revision }) => [sessionId, revision])).toEqual([
        ['deleted', 'r2'],
        ['kept', 'r2'],
      ])
      expect((yield* listSessionEntries()).unavailable).toEqual([])
      yield* deleteSession('deleted')

      expect(storage.keys.filter((key) => key.startsWith('mc-compose/session/deleted/'))).toEqual([])
      expect([...storage.keys].sort()).toEqual([
        'mc-compose/session/kept/checkpoint/head',
        'mc-compose/session/kept/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
        'mc-compose/session/kept/head',
        'mc-compose/session/kept/revision/r2/dimension/overworld/chunk/0/0',
      ])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('rejects a third save of one revision id before writing anything', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('reused-revision', 'r1', 1, [3])
      const saved = yield* saveRevision('reused-revision', 'r1', 2, [5])
      const before = storedSnapshot(storage)

      // The checkpoint already holds r1 under the same revision-specific keys.
      expect(yield* Effect.flip(saveRevision('reused-revision', 'r1', 3, [7]))).toMatchObject({
        _tag: 'SessionManifestError',
        reason: 'duplicate-key',
        key: 'mc-compose/session/reused-revision/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
      })
      expect(storedSnapshot(storage)).toEqual(before)
      expect(yield* openSession('reused-revision')).toEqual(Option.some({ _tag: 'Live', head: saved }))
    }).pipe(Effect.provide(storage.layer))
  })

  const seedChunkVersion = (storage: ControlledStorage, key: string, version: number): void => {
    storage.setEnvelope(key, {
      format: CHUNK_FORMAT.name,
      version,
      payload: { written: 'by another build' },
    })
  }

  it.effect('refuses to open or overwrite a session whose live chunk a newer build wrote', () => {
    const storage = controlledStorage()
    const incompatible = {
      _tag: 'SessionIncompatibleError',
      reason: 'future-version',
      key: 'mc-compose/session/future-chunk/revision/r2/dimension/overworld/chunk/0/0',
      storedVersion: 4,
      currentVersion: 3,
    }
    return Effect.gen(function* () {
      yield* saveRevision('future-chunk', 'r1', 1, [3])
      yield* saveRevision('future-chunk', 'r2', 2, [5])
      seedChunkVersion(storage, 'mc-compose/session/future-chunk/revision/r2/dimension/overworld/chunk/0/0', 4)

      // The r1 checkpoint is readable, but must not stand in for the newer chunk.
      expect(yield* Effect.flip(openSession('future-chunk'))).toMatchObject(incompatible)
      const before = storedSnapshot(storage)
      const mutations = storage.mutationCount
      expect(yield* Effect.flip(saveRevision('future-chunk', 'r3', 3, [7]))).toMatchObject(incompatible)
      expect(storedSnapshot(storage)).toEqual(before)
      expect(storage.mutationCount).toBe(mutations)
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('refuses to open a session whose live chunk version has no migration path', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('legacy-chunk', 'r1', 1, [3])
      seedChunkVersion(storage, 'mc-compose/session/legacy-chunk/revision/r1/dimension/overworld/chunk/0/0', 2)

      expect(yield* Effect.flip(openSession('legacy-chunk'))).toMatchObject({
        _tag: 'SessionIncompatibleError',
        reason: 'unsupported-version',
        key: 'mc-compose/session/legacy-chunk/revision/r1/dimension/overworld/chunk/0/0',
        storedVersion: 2,
        currentVersion: 3,
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('reports an incompatible checkpoint chunk as the checkpoint failure', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('future-checkpoint-chunk', 'r1', 1, [3])
      yield* saveRevision('future-checkpoint-chunk', 'r2', 2, [5])
      tamper(storage, 'mc-compose/session/future-checkpoint-chunk/head')
      seedChunkVersion(
        storage,
        'mc-compose/session/future-checkpoint-chunk/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
        4,
      )

      expect(yield* Effect.flip(openSession('future-checkpoint-chunk'))).toMatchObject({
        _tag: 'SessionCorruptError',
        liveFailure: { _tag: 'SaveDecodeError', record: { _tag: 'Head' } },
        checkpoint: {
          _tag: 'SessionIncompatibleError',
          reason: 'future-version',
          key: 'mc-compose/session/future-checkpoint-chunk/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
          storedVersion: 4,
        },
      })
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('opens, lists, and checkpoints a migrated v17 head with chunks', () => {
    const storage = controlledStorage()
    const fixture = Schema.decodeUnknownSync(SaveEnvelopeSchema)(parseJson(fixtureEnvelopeText('session-v17-envelope.json')))
    if (!isRecord(fixture.payload)) throw new Error('the v17 fixture payload must be a record')
    const liveChunkKey = 'mc-compose/session/v17-fixture/revision/r1/dimension/overworld/chunk/0/0'
    storage.setEnvelope('mc-compose/session/v17-fixture/head', {
      format: SESSION_FORMAT_NAME,
      version: 17,
      payload: {
        ...fixture.payload,
        chunks: [{ dimension: 'overworld', coord: { cx: 0, cz: 0 }, key: liveChunkKey }],
      },
    })
    return Effect.gen(function* () {
      const chunkDraft = yield* encodeSave(CHUNK_FORMAT, chunk(0, 0, 3))
      storage.setEnvelope(liveChunkKey, Result.getOrThrow(sealSaveEnvelope(chunkDraft)))

      const opened = Option.getOrThrow(yield* openSession('v17-fixture'))
      assert(opened._tag === 'Live')
      expect(opened.head.revision).toBe('r1')
      expect(opened.head.chunks).toEqual([{ dimension: 'overworld', coord: coordOf(0, 0), key: liveChunkKey }])
      expect(yield* savedMarkers(opened.head)).toEqual([3])
      expect(yield* listSessionEntries()).toEqual({ sessions: [opened.head], unavailable: [] })

      yield* saveRevision('v17-fixture', 'r2', 2, [5])

      expect(storage.envelope('mc-compose/session/v17-fixture/checkpoint/head')).toMatchObject({ version: 17 })
      tamper(storage, 'mc-compose/session/v17-fixture/head')
      const fromCheckpoint = Option.getOrThrow(yield* openSession('v17-fixture'))
      assert(fromCheckpoint._tag === 'Checkpoint')
      expect(fromCheckpoint.head.state).toEqual(opened.head.state)
      expect(fromCheckpoint.head.chunks).toEqual([{
        dimension: 'overworld',
        coord: coordOf(0, 0),
        key: 'mc-compose/session/v17-fixture/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
      }])
      expect(yield* savedMarkers(fromCheckpoint.head)).toEqual([3])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('a save after a failed publish succeeds and keeps r1 retained', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('retry-after-failure', 'r1', 1, [3])
      storage.failChunkKey = 'mc-compose/session/retry-after-failure/revision/r2/dimension/overworld/chunk/0/0'
      yield* Effect.flip(saveRevision('retry-after-failure', 'r2', 2, [5]))
      storage.failChunkKey = undefined

      const saved = yield* saveRevision('retry-after-failure', 'r3', 3, [7])

      expect(yield* openSession('retry-after-failure')).toEqual(Option.some({ _tag: 'Live', head: saved }))
      expect([...storage.keys].sort()).toEqual([
        'mc-compose/session/retry-after-failure/checkpoint/head',
        'mc-compose/session/retry-after-failure/checkpoint/revision/r1/dimension/overworld/chunk/0/0',
        'mc-compose/session/retry-after-failure/head',
        'mc-compose/session/retry-after-failure/revision/r3/dimension/overworld/chunk/0/0',
      ])
      tamper(storage, 'mc-compose/session/retry-after-failure/head')
      const opened = Option.getOrThrow(yield* openSession('retry-after-failure'))
      assert(opened._tag === 'Checkpoint')
      expect(opened.head.revision).toBe('r1')
      expect(yield* savedMarkers(opened.head)).toEqual([3])
    }).pipe(Effect.provide(storage.layer))
  })

  const checkpointDamage = [
    { name: 'removed', damage: (storage: ControlledStorage, key: string) => storage.removeEnvelope(key) },
    { name: 'tampered', damage: tamper },
  ] as const
  for (const { name, damage } of checkpointDamage) {
    it.effect(`a save after a failed publish restores a ${name} checkpoint chunk before moving the live head`, () => {
      const storage = controlledStorage()
      const sessionId = `retry-${name}-checkpoint`
      return Effect.gen(function* () {
        yield* saveRevision(sessionId, 'r1', 1, [3])
        storage.failChunkKey = `mc-compose/session/${sessionId}/revision/r2/dimension/overworld/chunk/0/0`
        yield* Effect.flip(saveRevision(sessionId, 'r2', 2, [5]))
        storage.failChunkKey = undefined
        damage(storage, `mc-compose/session/${sessionId}/checkpoint/revision/r1/dimension/overworld/chunk/0/0`)

        yield* saveRevision(sessionId, 'r3', 3, [7])

        tamper(storage, `mc-compose/session/${sessionId}/head`)
        const opened = Option.getOrThrow(yield* openSession(sessionId))
        assert(opened._tag === 'Checkpoint')
        expect(opened.head.revision).toBe('r1')
        expect(yield* savedMarkers(opened.head)).toEqual([3])
      }).pipe(Effect.provide(storage.layer))
    })
  }

  it.effect('a save after a failed publish keeps the checkpoint when the live revision is damaged', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('retry-damaged-live', 'r1', 1, [3])
      storage.failChunkKey = 'mc-compose/session/retry-damaged-live/revision/r2/dimension/overworld/chunk/0/0'
      yield* Effect.flip(saveRevision('retry-damaged-live', 'r2', 2, [5]))
      storage.failChunkKey = undefined
      tamper(storage, 'mc-compose/session/retry-damaged-live/revision/r1/dimension/overworld/chunk/0/0')

      yield* saveRevision('retry-damaged-live', 'r3', 3, [7])

      tamper(storage, 'mc-compose/session/retry-damaged-live/head')
      const opened = Option.getOrThrow(yield* openSession('retry-damaged-live'))
      assert(opened._tag === 'Checkpoint')
      expect(opened.head.revision).toBe('r1')
      expect(yield* savedMarkers(opened.head)).toEqual([3])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('a save replacing a rewritten revision checkpoints its latest records', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('rewritten-revision', 'r1', 1, [3])
      const rewritten = yield* saveRevision('rewritten-revision', 'r1', 2, [4])

      yield* saveRevision('rewritten-revision', 'r2', 3, [5])

      tamper(storage, 'mc-compose/session/rewritten-revision/head')
      const opened = Option.getOrThrow(yield* openSession('rewritten-revision'))
      assert(opened._tag === 'Checkpoint')
      expect(opened.head.state).toEqual(rewritten.state)
      expect(yield* savedMarkers(opened.head)).toEqual([4])
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('does not copy a previous revision whose chunk is damaged over the checkpoint', () => {
    const storage = controlledStorage()
    return Effect.gen(function* () {
      yield* saveRevision('damaged-previous', 'r1', 1, [3])
      yield* saveRevision('damaged-previous', 'r2', 2, [5])
      tamper(storage, 'mc-compose/session/damaged-previous/revision/r2/dimension/overworld/chunk/0/0')

      yield* saveRevision('damaged-previous', 'r3', 3, [7])

      tamper(storage, 'mc-compose/session/damaged-previous/head')
      const opened = Option.getOrThrow(yield* openSession('damaged-previous'))
      assert(opened._tag === 'Checkpoint')
      expect(opened.head.revision).toBe('r1')
      expect(yield* savedMarkers(opened.head)).toEqual([3])
    }).pipe(Effect.provide(storage.layer))
  })
})

