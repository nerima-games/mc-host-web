import { readFileSync } from 'node:fs'

import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Result, Schema } from 'effect'

import {
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
  equipFromInventory,
  itemStack,
  storageFromInventory,
  validateCropSnapshot,
  validateVehicleSnapshot,
  OccupantId,
  type CropSnapshot,
  type Vehicle,
} from '@nerima-games/mc-sim'
import {
  CHUNK_SIZE_XZ,
  ChunkAxis,
  ItemDamage,
  RepairCost,
  chunkCoord,
  itemStackEqualsIgnoringCount,
  type ChunkCoord,
} from '@nerima-games/mc-kernel'
import {
  CHUNK_VOLUME,
  type ChunkSource,
  type ChunkWithBlockStates,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import {
  SPAWN_PLAYER_VITALS,
  emptyBrewingStandState,
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
  listSessions,
  loadSession,
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
  type SessionMetadata,
  type SessionState,
} from '../apps/web/session-persistence'

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
  brewing: emptyBrewingStandState(),
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
          healthPoints: 300,
          chargeRemainingSecs: 4,
          feetPosition: { x: 2.5, y: 66, z: -3.5 },
          velocity: { x: 0, y: 0, z: 0 },
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
  readonly keys: ReadonlyArray<string>
  readonly envelope: (key: string) => SaveEnvelope | undefined
  readonly setEnvelope: (key: string, envelope: SaveEnvelope | SeededEnvelope) => void
}

const controlledStorage = (): ControlledStorage => {
  const entries = new Map<string, SaveEnvelope>()
  const state = {
    failChunkKey: undefined as string | undefined,
    failNextHeadWrite: false,
    failChunkRemoves: false,
    chunkWriteCount: 0,
  }
  const storage: StorageService = {
    get: (key) => Effect.succeed(Option.fromNullishOr(entries.get(key))),
    put: (key, envelope) =>
      Effect.suspend(() => {
        if (String(key).includes('/chunk/')) state.chunkWriteCount += 1
        if (state.failChunkKey === String(key)) {
          return Effect.fail(new StorageError({ operation: 'put', key }))
        }
        if (state.failNextHeadWrite && String(key).endsWith('/head')) {
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
            if (state.failNextHeadWrite && String(key).endsWith('/head')) {
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
    get keys() {
      return [...entries.keys()]
    },
    envelope: (key) => entries.get(key),
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
      const error = yield* Effect.flip(loadSession(sessionId))
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
      storedStateWith(state, { brewing: { fuelUnits: -1, bottle: null, ingredient: null, brewing: null } }),
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
        const error = yield* Effect.flip(loadSession(`invalid-gameplay-snapshot-${String(index)}`))
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
          _tag: 'SaveDecodeError',
          format: SESSION_FORMAT_NAME,
          version,
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
      const error = yield* Effect.flip(loadSession(sessionId))
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
      const error = yield* Effect.flip(loadSession(sessionId))
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
      const error = yield* Effect.flip(loadSession(sessionId))
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
        const error = yield* Effect.flip(loadSession(`invalid-portal-${String(index)}`))
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
        const error = yield* Effect.flip(loadSession(`invalid-crops-${String(index)}`))
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
        _tag: 'SaveDecodeError',
        format: SESSION_FORMAT_NAME,
        version: SESSION_FORMAT_VERSION + 1,
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
        const error = yield* Effect.flip(loadSession(`${prefix}-${String(index)}`))
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
      const error = yield* Effect.flip(loadSession(sessionId))
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
      const error = yield* Effect.flip(loadSession(sessionId))
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
        const error = yield* Effect.flip(loadSession(`invalid-metadata-${String(index)}`))
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
      const error = yield* Effect.flip(loadSession('invalid-storage-durability'))

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
      const error = yield* Effect.flip(loadSession('invalid-time'))

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
      const error = yield* Effect.flip(loadSession('invalid-weather'))

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
      const error = yield* Effect.flip(loadSession('invalid-vitals'))

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
      const decodeError = yield* Effect.flip(loadSession(decodeSessionId))
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
      const error = yield* Effect.flip(loadSession('unknown-item'))

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
      expect(storage.keys.filter((key) => key.includes('/chunk/'))).toHaveLength(1)
    }).pipe(Effect.provide(storage.layer))
  })

  it.effect('keeps storage bounded across revisions and collects chunks for an empty manifest', () => {
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

      expect(storage.keys.filter((key) => key.includes('/chunk/'))).toEqual([
        sessionChunkKey('bounded', 'r2', 'overworld', coordOf(2, 0)),
      ])

      yield* saveSession({
        sessionId: 'bounded',
        revision: 'r3',
        state: sessionState(3),
        chunks: [],
      })
      expect(storage.keys).toEqual([sessionHeadKey('bounded')])
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
      expect(storage.keys.filter((key) => key.includes('/chunk/'))).toHaveLength(2)
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
    const fixtureEnvelope = (name: string): SaveEnvelope => {
      const parsed: unknown = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
      return Schema.decodeUnknownSync(SaveEnvelopeSchema)(parsed)
    }

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
        expect(loaded.state.brewing).toEqual(emptyBrewingStandState())
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
  })
})
