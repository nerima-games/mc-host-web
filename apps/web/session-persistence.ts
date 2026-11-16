import { Data, Effect, Option, Result, Schema, SchemaIssue, SchemaTransformation } from 'effect'
import type { YieldableError } from 'effect/Cause'
import { isValidWitherRuntimeSnapshot, type WitherRuntimeSnapshot } from '@nerima-games/mc-server/shared'

import { ChunkAxis, isItemStack, isItemType, type ChunkCoord } from '@nerima-games/mc-kernel'
import {
  loadFrom,
  SaveKey,
  saveTo,
  StoragePort,
  defineFormat,
  SaveFormatVersion,
  type SaveDecodeError,
  type SaveFormat,
  type SaveFormatMigration,
  type StorageError,
} from '@nerima-games/mc-save'
import {
  isValidTimeState,
  isValidVitals,
  isValidWeatherState,
  durabilityForItem,
  maxStackCountForItem,
  validateContainerStorageSnapshot,
  validateFurnaceSnapshot,
  validatePlayerStorageSnapshot,
  validateCropSnapshot,
  type ContainerStorageSnapshot,
  type CropSnapshot,
  BREWING_FUEL_CHARGES,
  BREWING_FUEL_ITEM,
  BREWING_MAX_FUEL_CHARGES,
  LegacyItemStackSchema,
  itemStack,
  validateBrewingSnapshot,
  type BrewingState,
  type ItemStackFailure,
  type Durability,
  type EquipmentItem,
  type FurnaceState,
  type PlayerStorage,
  type TimeState,
  type WeatherState,
  type Vehicle,
  validateVehicleSnapshot,
} from '@nerima-games/mc-sim'
import {
  CHUNK_FORMAT,
  chunkSnapshotOf,
  type ChunkSource,
  type ChunkStoreApi,
  type ChunkWithBlockStates,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import {
  emptyVillagerTradeState,
  collectBrewingBottle,
  isValidBrewingStandState,
  isValidStatusEffectState,
  isValidVillagerTradeState,
  decodeEnchantedItem,
  EnderDragonEncounterSnapshotSchema,
  initialEnderDragonEncounter,
  type EnderDragonEncounterSnapshot,
  type Enchantment,
  type PlayerVitals,
  type BrewingStandState,
  type StatusEffectState,
  type VillagerProfession,
  type VillagerTradeState,
} from '@nerima-games/mx-gameplay'

export const SESSION_FORMAT_NAME = '@nerima-games/mc-compose/session'
export const SESSION_FORMAT_VERSION = 18

// Effect 4 runs a schema's checks on encode as well as decode, so a plain
// `check` keeps the old "validate before encoding too" guarantee.
const invariant = <T>(issueFor: (value: T) => string | undefined) =>
  Schema.makeFilter<T>((value) => issueFor(value))

// Swaps happen on the whole field value before the target schema sees it, so
// the target still validates the restored domain value in both directions.
const makeBoundaryCodec = <Target extends Schema.Top>(
  target: Target,
  decodeValue: (input: unknown) => unknown,
  encodeValue: (input: unknown) => unknown,
) =>
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.Unknown, SchemaTransformation.transform({ decode: decodeValue, encode: encodeValue })),
    Schema.decodeTo(target, SchemaTransformation.passthrough({ strict: false })),
  )

const WitherRuntimeSnapshotSchema = Schema.declare(isValidWitherRuntimeSnapshot, {
  expected: 'Wither runtime snapshot that satisfies persistence invariants',
})

// v17 stored mx-gameplay's `BrewingStandState`, whose `{bottle,ingredient,brewing}` are `X |
// undefined` (never `null` — see `node_modules/@nerima-games/mx-gameplay/dist/
// domain/brewing.d.ts`), and mc-save's integrity checksum rejects a bare
// `undefined` anywhere in the encoded payload (`integrity-canonical.ts`'s
// `canonicalize`; see the longer `optionalKey` comment further down in this
// file for the same gap on optional fields). Swapping `undefined` for `null`
// on encode and back on decode is unambiguous here because these three fields
// never use `null` for anything else.
const restoreBrewingUndefined = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return {
    ...record,
    bottle: record['bottle'] === null ? undefined : record['bottle'],
    ingredient: record['ingredient'] === null ? undefined : record['ingredient'],
    brewing: record['brewing'] === null ? undefined : record['brewing'],
  }
}

// Untyped because `makeBoundaryCodec` swaps on the raw field value before the
// target schema has validated it.
const encodeBrewingUndefined = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return {
    ...record,
    bottle: record['bottle'] ?? null,
    ingredient: record['ingredient'] ?? null,
    brewing: record['brewing'] ?? null,
  }
}

const V17BrewingStandStateSchema = makeBoundaryCodec(
  Schema.declare(isValidBrewingStandState, { expected: 'Brewing stand state that satisfies gameplay invariants' }),
  restoreBrewingUndefined,
  encodeBrewingUndefined,
)

const StatusEffectStateSchema = Schema.declare(isValidStatusEffectState, {
  expected: 'Status effects that satisfy gameplay invariants',
})

const VillagerTradeStateSchema = Schema.declare(isValidVillagerTradeState, {
  expected: 'Villager trades that satisfy gameplay invariants',
})

export type SessionPosition = {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type PersistedEntity = {
  readonly id: string
  readonly kind: string
  readonly feetPosition: SessionPosition
  readonly healthPoints: number
  readonly behaviour: unknown
}

export type PersistedItemDropLifetime = {
  readonly elapsedSecs: number
}

export type PersistedItemDropMetadata = {
  readonly customName?: string
  readonly enchantments?: ReadonlyArray<Enchantment>
}

export const persistedItemDropMetadata = (behaviour: unknown): PersistedItemDropMetadata => {
  const drop = asRecord(behaviour)
  if (drop === undefined) return {}

  const customName = drop['customName']
  const enchantedItem = decodeEnchantedItem({
    item: drop['item'],
    durability: drop['durability'] ?? null,
    enchantments: drop['enchantments'],
  })
  return {
    ...(typeof customName === 'string' && customName.trim().length > 0 ? { customName } : {}),
    ...(enchantedItem.ok
      ? { enchantments: enchantedItem.value.enchantments.map((enchantment) => ({ ...enchantment })) }
      : {}),
  }
}

export const persistedItemDropLifetime = (behaviour: unknown): PersistedItemDropLifetime => {
  const elapsedSecs = asRecord(behaviour)?.['elapsedSecs']
  return {
    elapsedSecs: typeof elapsedSecs === 'number' && Number.isFinite(elapsedSecs)
      ? Math.max(0, elapsedSecs)
      : 0,
  }
}

// Same undefined-vs-null gap as `normalizePersistedEntityRoster`'s own
// entity-level swap below, one object deeper: mx-gameplay's
// `HostileMobSnapshot.behaviour: CreeperFuse | EndermanFlinch |
// EcosystemMobState | undefined` (`mob-frame.d.ts`) names a mob this
// repository has no fuse/flinch/ecosystem state for yet, and a zombie is
// exactly that mob — only `OVERWORLD_ECOSYSTEM_HOSTILE_KINDS` and
// `NETHER_HOSTILE_KINDS` are ecosystem-governed, so a zombie's nested
// `behaviour` stays `undefined` for its whole lifetime. mc-save's integrity
// checksum rejects that `undefined` exactly as it rejects the entity-level
// one, but it sits a `MobBehaviour` union member two objects deep, so the
// shallow entity-level swap never reaches it. Restrict the swap to
// `HostileMobSnapshot`'s own nested field — other `MobBehaviour` members
// (`CreeperFuse`, `DroppedItemBehaviour`, ...) use `null`/absence for
// unrelated reasons and must not be touched here.
const restoreHostileMobBehaviour = (behaviour: unknown): unknown => {
  const record = asRecord(behaviour)
  if (record === undefined || record['_tag'] !== 'HostileMob') return behaviour
  return { ...record, behaviour: record['behaviour'] === null ? undefined : record['behaviour'] }
}

const normalizePersistedEntityBehaviour = (kind: string, behaviour: unknown): unknown => {
  if (kind !== 'dropped_item') return behaviour
  const drop = asRecord(behaviour)
  if (drop === undefined) return behaviour

  const item = drop['item']
  const count = drop['count']
  if (
    typeof item !== 'string'
    || !isItemType(item)
    || typeof count !== 'number'
    || !Number.isInteger(count)
    || count <= 0
    || count > maxStackCountForItem(item)
  ) return behaviour

  const enchantedItem = decodeEnchantedItem({
    item,
    durability: Object.hasOwn(drop, 'durability') ? drop['durability'] : durabilityForItem(item),
    enchantments: Object.hasOwn(drop, 'enchantments') ? drop['enchantments'] : [],
  })
  if (!enchantedItem.ok || (enchantedItem.value.durability !== null && count !== 1)) return behaviour

  const eligibleFromFrame = drop['eligibleFromFrame']
  const customName = drop['customName']
  return {
    _tag: 'DroppedItem',
    item: enchantedItem.value.item,
    count,
    durability: enchantedItem.value.durability,
    ...(typeof eligibleFromFrame === 'number'
      && Number.isInteger(eligibleFromFrame)
      && eligibleFromFrame >= 0
      ? { eligibleFromFrame }
      : {}),
    ...(typeof customName === 'string' && customName.trim().length > 0 ? { customName } : {}),
    enchantments: enchantedItem.value.enchantments.map((enchantment) => ({ ...enchantment })),
    elapsedSecs: persistedItemDropLifetime(drop).elapsedSecs,
  }
}

export type PersistedEntityRoster = {
  readonly entities: ReadonlyArray<PersistedEntity>
  readonly nextSerial: number
}

export type PersistedEntityRosters = Readonly<Record<Dimension, PersistedEntityRoster>>

export const EMPTY_ENTITY_ROSTER: PersistedEntityRoster = { entities: [], nextSerial: 0 }

export const EMPTY_ENTITY_ROSTERS: PersistedEntityRosters = {
  overworld: EMPTY_ENTITY_ROSTER,
  nether: EMPTY_ENTITY_ROSTER,
  end: EMPTY_ENTITY_ROSTER,
}

export type PersistedVillager = {
  readonly id: string
  readonly profession: VillagerProfession
  readonly dimension: Dimension
  readonly feetPosition: SessionPosition
}

export type PersistedVillagerState = {
  readonly residents: ReadonlyArray<PersistedVillager>
  readonly trades: VillagerTradeState
}

export const EMPTY_VILLAGER_STATE: PersistedVillagerState = {
  residents: [],
  trades: emptyVillagerTradeState(),
}

export const normalizePersistedEntityRoster = (value: unknown): PersistedEntityRoster => {
  const roster = asRecord(value)
  if (roster === undefined || !Array.isArray(roster['entities'])) return EMPTY_ENTITY_ROSTER

  const entities: Array<PersistedEntity> = []
  for (const value of roster['entities']) {
    const entity = asRecord(value)
    const feetPosition = asRecord(entity?.['feetPosition'])
    const kind = entity?.['kind']
    const id = entity?.['id']
    const x = feetPosition?.['x']
    const y = feetPosition?.['y']
    const z = feetPosition?.['z']
    const healthPoints = entity?.['healthPoints']
    if (
      entity === undefined
      || typeof kind !== 'string'
      || kind.trim().length === 0
      || typeof id !== 'string'
      || typeof x !== 'number'
      || !Number.isFinite(x)
      || typeof y !== 'number'
      || !Number.isFinite(y)
      || typeof z !== 'number'
      || !Number.isFinite(z)
      || typeof healthPoints !== 'number'
      || !Number.isFinite(healthPoints)
    ) continue
    entities.push({
      id,
      kind,
      feetPosition: { x, y, z },
      healthPoints,
      // mx-gameplay's `MobBehaviour` union includes `undefined` itself — "a
      // pig keeps its `undefined`" is how an ordinary passive mob with no
      // active behaviour is represented, not an edge case — and JSON has no
      // way to write a literal `undefined`, so the wire form of "no
      // behaviour" is `null`. Swap it back before `normalizePersistedEntityBehaviour`
      // sees it; see `PersistedEntityRostersSchema`'s `encode` below for the
      // opposite direction.
      behaviour: normalizePersistedEntityBehaviour(
        kind,
        restoreHostileMobBehaviour(entity['behaviour'] === null ? undefined : entity['behaviour']),
      ),
    })
  }

  const nextSerial = roster['nextSerial']
  return {
    entities,
    nextSerial: typeof nextSerial === 'number' && Number.isFinite(nextSerial)
      ? Math.max(0, Math.floor(nextSerial))
      : 0,
  }
}

export const normalizePersistedEntityRosters = (value: unknown): PersistedEntityRosters => {
  const rosters = asRecord(value)
  return {
    overworld: normalizePersistedEntityRoster(rosters?.['overworld']),
    nether: normalizePersistedEntityRoster(rosters?.['nether']),
    end: normalizePersistedEntityRoster(rosters?.['end']),
  }
}

export type PersistedLeverState = {
  readonly dimension: Dimension
  readonly position: SessionPosition
  readonly active: boolean
}

export type PersistedFurnaceState = {
  readonly dimension: Dimension
  readonly position: SessionPosition
  readonly state: FurnaceState
}

export type PersistedPortalState = {
  readonly dimension: Dimension
  readonly position: SessionPosition
}

export type PersistedEndPortalFrameState = {
  readonly position: SessionPosition
  readonly facing: 'north' | 'south' | 'east' | 'west'
  readonly eye: boolean
}

export type PersistedEndState = {
  readonly frames: ReadonlyArray<PersistedEndPortalFrameState>
  readonly portalComplete: boolean
  readonly dragon: EnderDragonEncounterSnapshot
  readonly exitPortalMaterialized: boolean
  readonly dragonEggRewarded: boolean
}

export const EMPTY_END_STATE: PersistedEndState = {
  frames: [],
  portalComplete: false,
  dragon: initialEnderDragonEncounter(),
  exitPortalMaterialized: false,
  dragonEggRewarded: false,
}

const PositionSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  z: Schema.Number,
})

const BlockCoordinateSchema = Schema.Finite.check(
  invariant<number>((value) => Number.isInteger(value) ? undefined : 'Block coordinate must be an integer'),
)

const BlockPositionSchema = Schema.Struct({
  x: BlockCoordinateSchema,
  y: BlockCoordinateSchema,
  z: BlockCoordinateSchema,
})

export type SessionState = {
  readonly seed: number
  readonly dimension: Dimension
  readonly player: {
    readonly feetPosition: SessionPosition
    readonly yawRadians: number
    readonly pitchRadians: number
  }
  readonly storage: PlayerStorage
  readonly containerStorage: ContainerStorageSnapshot
  readonly vitals: PlayerVitals
  readonly time: TimeState
  readonly weather: WeatherState
  readonly redstone: {
    readonly levers: ReadonlyArray<PersistedLeverState>
  }
  readonly furnaces: ReadonlyArray<PersistedFurnaceState>
  readonly portals: ReadonlyArray<PersistedPortalState>
  readonly crops: CropSnapshot
  readonly entities: PersistedEntityRosters
  readonly villagers: PersistedVillagerState
  readonly brewing: BrewingState
  readonly statusEffects: StatusEffectState
  readonly end: PersistedEndState
  readonly workstations?: {
    readonly enchantmentSeed: number
    readonly customNames: Readonly<Record<string, string>>
    readonly enchantedItems: Readonly<Record<string, string>>
    readonly deathDropDimension?: Dimension | undefined
    readonly respawn: {
      readonly dimension: 'overworld'
      readonly position: SessionPosition
    } | null
  } | undefined
  readonly wither?: WitherRuntimeSnapshot | undefined
  readonly vehicles?: ReadonlyArray<Vehicle> | undefined
  readonly mountedVehicleId?: string | null | undefined
}

const FiniteNumberSchema = Schema.Finite

// Same undefined-vs-null gap as `UndefinedSlotSchema`/`V17BrewingStandStateSchema`/
// `PersistedEntityRostersSchema` in this file, but on a REQUIRED field rather than an
// absent one: `PlayerVitals.lastDamageCause: DamageCause | undefined` is
// always present (there is no death cause yet, not an omitted property), so
// `Schema.optionalKey` — which is about KEY absence —
// does not apply here. `Schema.UndefinedOr` lets a present `undefined` VALUE
// through validation (that is the whole point of the field's type), which is
// exactly what mc-save's integrity checksum then rejects. The struct/filter
// stays untouched; only the `lastDamageCause` value is swapped at the
// boundary, same as the other three fixes above.
const restoreVitalsLastDamageCause = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return {
    ...record,
    lastDamageCause: record['lastDamageCause'] === null ? undefined : record['lastDamageCause'],
  }
}

const encodeVitalsLastDamageCause = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return { ...record, lastDamageCause: record['lastDamageCause'] ?? null }
}

// mx-gameplay's `PlayerVitals` is mc-sim's `Vitals`, whose branded fields have
// exactly `isValidVitals` as their runtime contract (mx-gameplay's
// `isValidPlayerVitals` delegates to it), so the guard narrows the
// structurally checked record to that branded type.
const isPersistablePlayerVitals = (value: unknown): value is PlayerVitals => isValidVitals(value)

const PlayerVitalsSchema = makeBoundaryCodec(
  Schema.Struct({
    healthPoints: FiniteNumberSchema,
    maxHealthPoints: FiniteNumberSchema,
    hungerPoints: FiniteNumberSchema,
    maxHungerPoints: FiniteNumberSchema,
    saturation: FiniteNumberSchema,
    exhaustion: FiniteNumberSchema,
    foodTimerSecs: FiniteNumberSchema,
    totalExperience: FiniteNumberSchema,
    lastDamageCause: Schema.UndefinedOr(Schema.String),
  }).pipe(Schema.refine(isPersistablePlayerVitals, { expected: 'Player vitals that satisfy gameplay invariants' })),
  restoreVitalsLastDamageCause,
  encodeVitalsLastDamageCause,
)

const TimeStateSchema = Schema.Struct({
  ticks: FiniteNumberSchema,
  dayLengthTicks: FiniteNumberSchema,
}).check(invariant<TimeState>((value) => isValidTimeState(value)
  ? undefined
  : 'Time state violates simulation invariants'))

const WeatherStateSchema = Schema.Struct({
  weather: Schema.Literals(['clear', 'rain', 'thunder']),
  remainingSecs: FiniteNumberSchema,
}).pipe(Schema.refine(
  (value): value is WeatherState => isValidWeatherState(value),
  { expected: 'Weather state that satisfies simulation invariants' },
))

const DimensionSchema = Schema.Literals(['overworld', 'nether', 'end'])

const PersistedEntitySchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  feetPosition: PositionSchema,
  healthPoints: FiniteNumberSchema,
  behaviour: Schema.Unknown,
})

const PersistedEntityRosterSchema = Schema.Struct({
  entities: Schema.Array(PersistedEntitySchema),
  nextSerial: Schema.Number,
})

// Same undefined-vs-null gap as `UndefinedSlotSchema`/`V17BrewingStandStateSchema`
// in this file, one level further down: an entity's `behaviour` is `unknown` here
// (there is no shared schema for the whole `MobBehaviour` union across every
// mx-gameplay mob kind), so nothing upstream catches a passive mob's
// `behaviour: undefined` — "a pig keeps its `undefined`" — before mc-save's
// integrity checksum does. `normalizePersistedEntityRoster` already restores
// `null` back to `undefined` on decode (see its comment); this is the
// opposite direction.
//
// `encodeHostileMobBehaviour` is the same swap again, one object further in:
// see `restoreHostileMobBehaviour`'s comment above for why a zombie's own
// nested `behaviour` field is `undefined` for its whole lifetime and why the
// swap is restricted to `HostileMobSnapshot`.
const encodeHostileMobBehaviour = (behaviour: unknown): unknown => {
  const record = asRecord(behaviour)
  if (record === undefined || record['_tag'] !== 'HostileMob') return behaviour
  return { ...record, behaviour: record['behaviour'] ?? null }
}

const encodePersistedEntityRosters = (rosters: unknown): unknown => {
  if (rosters === null || typeof rosters !== 'object') return rosters
  const encodeRoster = (roster: unknown): unknown => {
    if (roster === null || typeof roster !== 'object') return roster
    const record = roster as Record<string, unknown>
    const entities = record['entities']
    if (!Array.isArray(entities)) return roster
    return {
      ...record,
      entities: entities.map((entity: unknown) => {
        if (entity === null || typeof entity !== 'object') return entity
        const entityRecord = entity as Record<string, unknown>
        return { ...entityRecord, behaviour: encodeHostileMobBehaviour(entityRecord['behaviour']) ?? null }
      }),
    }
  }
  const record = rosters as Record<string, unknown>
  return {
    overworld: encodeRoster(record['overworld']),
    nether: encodeRoster(record['nether']),
    end: encodeRoster(record['end']),
  }
}

const PersistedEntityRostersSchema = makeBoundaryCodec(
  Schema.Struct({
    overworld: PersistedEntityRosterSchema,
    nether: PersistedEntityRosterSchema,
    end: PersistedEntityRosterSchema,
  }),
  normalizePersistedEntityRosters,
  encodePersistedEntityRosters,
)

// Every item stack is persisted in mc-sim's `LegacyItemStackSchema` form
// (`components: null` for the item's default components, otherwise the
// components with `undefined` written as `null`); the host adds no stack codec
// of its own.
//
// mc-sim models an empty player inventory or furnace slot as `undefined`
// (`Slot = ItemStack | undefined`), which mc-save's checksum cannot store, so
// this is the one place such a slot is written as `null` and read back.
// Container and equipment slots already use `null` and need no swap.
const UndefinedSlotSchema = Schema.NullOr(LegacyItemStackSchema).pipe(Schema.decodeTo(
  Schema.UndefinedOr(Schema.toType(LegacyItemStackSchema)),
  SchemaTransformation.transform({
    decode: (slot) => slot ?? undefined,
    encode: (slot) => slot ?? null,
  }),
))

const isDurability = (value: unknown): value is Durability => {
  const record = asRecord(value)
  return typeof record?.['current'] === 'number' && typeof record['max'] === 'number'
}

const isStoredStack = (value: unknown): value is EquipmentItem => {
  const record = asRecord(value)
  return record !== undefined
    && isItemStack({ item: record['item'], count: record['count'], components: record['components'] })
    && (record['durability'] === null || isDurability(record['durability']))
}

// Equipment and container stacks carry a `durability` next to the stack
// fields; the stack part goes through `LegacyItemStackSchema` and the
// durability is copied as recorded. The full storage validators below check
// the durability values.
const StoredStackSchema = Schema.Unknown.pipe(Schema.decodeTo(
  Schema.declare(isStoredStack, { expected: 'Item stack with its durability' }),
  SchemaTransformation.transformEffect({
    decode: (wire: unknown) => {
      const durability = asRecord(wire)?.['durability']
      return Schema.decodeUnknownEffect(LegacyItemStackSchema)(wire).pipe(
        Effect.mapError((error) => error.issue),
        Effect.flatMap((stack) =>
          durability === null || isDurability(durability)
            ? Effect.succeed({ ...stack, durability })
            : Effect.fail(new SchemaIssue.InvalidValue(
              { message: 'Stored stack durability must be null or { current, max }' },
              durability,
            ))),
      )
    },
    encode: ({ durability, ...stack }: EquipmentItem) =>
      Schema.encodeEffect(LegacyItemStackSchema)(stack).pipe(
        Effect.mapError((error) => error.issue),
        Effect.map((encoded): unknown => ({ ...asRecord(encoded), durability })),
      ),
  }),
))

const StoredSlotSchema = Schema.NullOr(StoredStackSchema)

const isPersistablePlayerStorage = (value: unknown): value is PlayerStorage =>
  validatePlayerStorageSnapshot(value)._tag === 'Valid'

const PlayerStorageSchema = Schema.Struct({
  inventory: Schema.Struct({ slots: Schema.Array(UndefinedSlotSchema) }),
  equipment: Schema.Struct({
    slots: Schema.Struct({
      head: StoredSlotSchema,
      chest: StoredSlotSchema,
      legs: StoredSlotSchema,
      feet: StoredSlotSchema,
      offhand: StoredSlotSchema,
    }),
  }),
  inventoryDurability: Schema.Array(Schema.Unknown),
}).pipe(Schema.refine(isPersistablePlayerStorage, { expected: 'Player storage that satisfies persistence invariants' }))

const isPersistableContainerStorage = (value: unknown): value is ContainerStorageSnapshot =>
  validateContainerStorageSnapshot(value)._tag === 'Valid'

const ContainerStorageSchema = Schema.Struct({
  version: Schema.Literal(3),
  containers: Schema.Array(Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    slots: Schema.Array(StoredSlotSchema),
  })),
}).pipe(Schema.refine(isPersistableContainerStorage, {
  expected: 'Container storage that satisfies persistence invariants',
}))

const isPersistableCropSnapshot = (value: unknown): value is CropSnapshot =>
  validateCropSnapshot(value)._tag === 'Valid'

const CropSnapshotSchema = Schema.declare(isPersistableCropSnapshot, {
  expected: 'Crop snapshot that satisfies persistence invariants',
})

const isPersistableFurnaceState = (value: unknown): value is FurnaceState =>
  validateFurnaceSnapshot(value)._tag === 'Valid'

const FurnaceStateSchema = Schema.Struct({
  station: Schema.String,
  input: UndefinedSlotSchema,
  fuel: UndefinedSlotSchema,
  output: UndefinedSlotSchema,
  fuelTimeRemainingSecs: Schema.Finite,
  fuelTimeTotalSecs: Schema.Finite,
  cookProgressSecs: Schema.Finite,
}).pipe(Schema.refine(isPersistableFurnaceState, {
  expected: 'Furnace state that satisfies simulation invariants',
}))

const isPersistableBrewingState = (value: unknown): value is BrewingState =>
  validateBrewingSnapshot(value)._tag === 'Valid'

const BrewingStateSchema = Schema.Struct({
  bottles: Schema.Tuple([UndefinedSlotSchema, UndefinedSlotSchema, UndefinedSlotSchema]),
  ingredient: UndefinedSlotSchema,
  fuel: UndefinedSlotSchema,
  fuelCharges: Schema.Finite,
  brewProgressSecs: Schema.Finite,
}).pipe(Schema.refine(isPersistableBrewingState, {
  expected: 'Brewing state that satisfies simulation invariants',
}))

const PersistedFurnaceSchema = Schema.Struct({
  dimension: DimensionSchema,
  position: BlockPositionSchema,
  state: FurnaceStateSchema,
})

const PersistedFurnacesSchema = Schema.Array(PersistedFurnaceSchema).check(
  invariant<ReadonlyArray<typeof PersistedFurnaceSchema.Type>>((furnaces) => {
    const keys = new Set<string>()
    for (const furnace of furnaces) {
      const key = JSON.stringify([
        furnace.dimension,
        furnace.position.x,
        furnace.position.y,
        furnace.position.z,
      ])
      if (keys.has(key)) return 'Furnace positions must be unique within each dimension'
      keys.add(key)
    }
    return undefined
  }),
)

const PersistedPortalsSchema = Schema.Array(
  Schema.Struct({
    dimension: DimensionSchema,
    position: BlockPositionSchema,
  }),
)

const PersistedVillagerStateSchema = Schema.Struct({
  residents: Schema.Array(Schema.Struct({
    id: Schema.String.check(Schema.isMinLength(1)),
    profession: Schema.Literals(['farmer', 'toolsmith']),
    dimension: DimensionSchema,
    feetPosition: PositionSchema,
  })),
  trades: VillagerTradeStateSchema,
})

// mx-gameplay publishes this schema as a decoder only (its encoding services
// are unknown); its encoded and decoded forms are the same plain record, so
// the type guard it provides is the whole persistence contract.
const EnderDragonSnapshotSchema = Schema.declare(Schema.is(EnderDragonEncounterSnapshotSchema), {
  expected: 'Ender dragon encounter snapshot',
})

const PersistedEndStateSchema = Schema.Struct({
  frames: Schema.Array(Schema.Struct({
    position: BlockPositionSchema,
    facing: Schema.Literals(['north', 'south', 'east', 'west']),
    eye: Schema.Boolean,
  })),
  portalComplete: Schema.Boolean,
  dragon: EnderDragonSnapshotSchema,
  exitPortalMaterialized: Schema.Boolean,
  dragonEggRewarded: Schema.Boolean,
})

// Every optional field below uses `Schema.optionalKey`: mc-save's integrity
// checksum canonicalizes the encoded payload and rejects a bare `undefined`
// anywhere in it — it is not one of the supported value kinds (see
// `integrity-canonical.ts`'s `canonicalize`, which fails for anything that is
// not a string/boolean/finite-or-non-finite number/null/plain object/array/
// Uint8Array). `optionalKey` omits an absent property instead of encoding an
// explicit `undefined` key, which is also what `exactOptionalPropertyTypes`
// already expects of every `?:` field in `SessionState`.
const isPersistableVehicles = (value: unknown): value is ReadonlyArray<Vehicle> => {
  if (!Array.isArray(value)) return false
  const highestSerial = value.reduce((highest: number, vehicle: unknown) => {
    const candidate = asRecord(vehicle)
    const id = candidate?.['id']
    if (typeof id !== 'string') return highest
    const match = /^v:(\d+)$/.exec(id)
    return match === null ? highest : Math.max(highest, Number(match[1]))
  }, -1)
  return validateVehicleSnapshot({ vehicles: value, nextSerial: highestSerial + 1 })._tag === 'Valid'
}

const PersistedVehiclesSchema = Schema.declare(isPersistableVehicles, {
  expected: 'Vehicles that satisfy simulation invariants',
})

const SessionStateSchema = Schema.Struct({
  seed: Schema.Number,
  dimension: DimensionSchema,
  player: Schema.Struct({
    feetPosition: PositionSchema,
    yawRadians: Schema.Number,
    pitchRadians: Schema.Number,
  }),
  storage: PlayerStorageSchema,
  containerStorage: ContainerStorageSchema,
  vitals: PlayerVitalsSchema,
  time: TimeStateSchema,
  weather: WeatherStateSchema,
  redstone: Schema.Struct({
    levers: Schema.Array(Schema.Struct({
      dimension: DimensionSchema,
      position: PositionSchema,
      active: Schema.Boolean,
    })),
  }),
  furnaces: PersistedFurnacesSchema,
  portals: PersistedPortalsSchema,
  crops: CropSnapshotSchema,
  entities: PersistedEntityRostersSchema,
  villagers: PersistedVillagerStateSchema,
  brewing: BrewingStateSchema,
  statusEffects: StatusEffectStateSchema,
  end: PersistedEndStateSchema,
  workstations: Schema.optionalKey(Schema.Struct({
    enchantmentSeed: Schema.Number,
    customNames: Schema.Record(Schema.String, Schema.String),
    enchantedItems: Schema.Record(Schema.String, Schema.String),
    deathDropDimension: Schema.optionalKey(DimensionSchema),
    respawn: Schema.NullOr(Schema.Struct({
      dimension: Schema.Literal('overworld'),
      position: PositionSchema,
    })),
  })),
  wither: Schema.optionalKey(WitherRuntimeSnapshotSchema),
  vehicles: Schema.optionalKey(PersistedVehiclesSchema),
  mountedVehicleId: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

/**
 * The on-disk shape of a `SessionState`, produced by `SessionStateSchema`'s
 * own encode step. Tests that seed a `StoragePort` directly with a hand-built
 * envelope (bypassing `saveSession`, to exercise `loadSession`'s rejection
 * paths in isolation) start from this and override single fields with
 * malformed encoded values.
 */
export const toStoredSessionState = (state: SessionState): Result.Result<unknown, Schema.SchemaError> =>
  Schema.encodeUnknownResult(SessionStateSchema)(state)

export type SessionChunkManifestEntry = {
  readonly dimension: Dimension
  readonly coord: ChunkCoord
  readonly key: string
}

export type DimensionChunk = {
  readonly dimension: Dimension
  readonly chunk: ChunkWithBlockStates
}

export type SessionMode = 'survival' | 'creative'

export const MAX_WORLD_NAME_LENGTH = 128

export const normalizeWorldName = (name: string): string | undefined => {
  const normalized = name.trim()
  return normalized.length > 0 && normalized.length <= MAX_WORLD_NAME_LENGTH
    ? normalized
    : undefined
}

export type SessionMetadata = {
  readonly name: string
  readonly mode: SessionMode
}

export type SessionHead = {
  readonly sessionId: string
  readonly revision: string
  readonly metadata: SessionMetadata
  readonly state: SessionState
  readonly chunks: ReadonlyArray<SessionChunkManifestEntry>
}

const ChunkManifestEntrySchema = Schema.Struct({
  dimension: DimensionSchema,
  coord: Schema.Struct({
    cx: Schema.Number.pipe(Schema.fromBrand('ChunkAxis', ChunkAxis)),
    cz: Schema.Number.pipe(Schema.fromBrand('ChunkAxis', ChunkAxis)),
  }),
  key: Schema.String.check(Schema.isMinLength(1)),
})

const SessionHeadSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  revision: Schema.String.check(Schema.isMinLength(1)),
  metadata: Schema.Struct({
    name: Schema.String.check(invariant<string>((name) =>
      normalizeWorldName(name) === name
        ? undefined
        : `World name must be normalized and at most ${String(MAX_WORLD_NAME_LENGTH)} characters`)),
    mode: Schema.Literals(['survival', 'creative']),
  }),
  state: SessionStateSchema,
  chunks: Schema.Array(ChunkManifestEntrySchema),
})

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined

// v17 is the last format written against mc-sim 0.4 (Effect 3). Only the
// fields whose shape changed are described here; every other key is carried
// to the v18 schema untouched, which then validates the whole payload. Older
// versions (v1-v16) have no migration and stay unreadable.
const V17_SESSION_FORMAT_VERSION = 17

// mc-sim 0.4's `FurnaceState`. Slots are `ItemStack | null`.
const V17FurnaceStateSchema = Schema.Struct({
  input: Schema.Unknown,
  fuel: Schema.Unknown,
  output: Schema.Unknown,
  cookElapsedSecs: Schema.Finite,
  burnRemainingSecs: Schema.Finite,
})

const V17Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const

// v17 stack slots (`null` or `{ item, count }`, plus `durability` for
// equipment and container stacks) are carried as recorded and only gain
// `components` below.
const V17SessionHeadSchema = Schema.StructWithRest(
  Schema.Struct({
    state: Schema.StructWithRest(
      Schema.Struct({
        storage: Schema.StructWithRest(
          Schema.Struct({
            inventory: Schema.StructWithRest(Schema.Struct({ slots: Schema.Array(Schema.Unknown) }), V17Rest),
            equipment: Schema.StructWithRest(
              Schema.Struct({ slots: Schema.Record(Schema.String, Schema.Unknown) }),
              V17Rest,
            ),
          }),
          V17Rest,
        ),
        containerStorage: Schema.StructWithRest(
          Schema.Struct({
            version: Schema.Literal(2),
            containers: Schema.Array(Schema.StructWithRest(
              Schema.Struct({ slots: Schema.Array(Schema.Unknown) }),
              V17Rest,
            )),
          }),
          V17Rest,
        ),
        furnaces: Schema.Array(Schema.Struct({
          dimension: Schema.Unknown,
          position: Schema.Unknown,
          state: V17FurnaceStateSchema,
        })),
        brewing: V17BrewingStandStateSchema,
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

// v17 had no item component concept, so every recorded stack has the item's
// default components. `components: null` is how mc-sim's
// `LegacyItemStackSchema` records exactly that; empty slots stay as recorded.
const migrateV17Slot = (slot: unknown): unknown => {
  const stack = asRecord(slot)
  return stack === undefined ? slot : { ...stack, components: null }
}

// The container snapshot version that v18 records. mc-sim 0.11's v3 differs
// from v2 only in each stored stack's `components`.
const V18_CONTAINER_STORAGE_VERSION = 3

// Unrecorded v18 furnace fields, built only from the v17 record:
// - station: 'furnace'. mc-sim 0.4 furnaces had no station; only normal
//   furnaces existed.
// - cookProgressSecs: cookElapsedSecs.
// - fuelTimeRemainingSecs: burnRemainingSecs.
// - fuelTimeTotalSecs: burnRemainingSecs. v17 never recorded the burning
//   fuel's total, so the remainder stands in for it. Only the flame-fraction
//   display changes; the time until the fuel runs out does not.
const migrateV17FurnaceState = (state: typeof V17FurnaceStateSchema.Type) => ({
  station: 'furnace',
  input: migrateV17Slot(state.input),
  fuel: migrateV17Slot(state.fuel),
  output: migrateV17Slot(state.output),
  fuelTimeRemainingSecs: state.burnRemainingSecs,
  fuelTimeTotalSecs: state.burnRemainingSecs,
  cookProgressSecs: state.cookElapsedSecs,
})

type SessionV17MigrationFailure =
  | {
    readonly _tag: 'V17BrewingFuelOverflow'
    readonly fuelUnits: number
    readonly fuelItemCount: number
    readonly maxStackCount: number
  }
  | { readonly _tag: 'V17BrewingStackRejected'; readonly item: string; readonly error: ItemStackFailure }
  | { readonly _tag: 'V17BrewingStackUnencodable'; readonly item: string; readonly error: Schema.SchemaError }

const v17BrewingStack = (
  item: Parameters<typeof itemStack>[0],
  count: number,
): Result.Result<unknown, SessionV17MigrationFailure> =>
  Result.flatMap(
    Result.mapError(itemStack(item, count), (error) => ({ _tag: 'V17BrewingStackRejected' as const, item, error })),
    (stack) => Result.mapError(
      Schema.encodeResult(LegacyItemStackSchema)(stack),
      (error) => ({ _tag: 'V17BrewingStackUnencodable' as const, item, error }),
    ),
  )

// mx-gameplay 0.6's single-slot brewing stand -> mc-sim 0.11's `BrewingState`,
// in its v18 encoded form:
// - A brew in progress is completed now: its `output` becomes the bottle,
//   exactly as the old stand's completion replaced its input bottle. The old
//   build had already consumed the ingredient and one fuel unit when the brew
//   started, so both stay consumed and progress restarts at 0. Under
//   BREWING_DURATION_SECS (20 s) of brewing time is skipped.
// - The bottle goes to slot 0; slots 1 and 2 stay empty. Its item comes from
//   mx-gameplay's own `collectBrewingBottle`, so no potion table lives here.
// - Fuel: one old fuel unit paid for one brew, and one new fuel charge pays
//   for one brew, so `fuelCharges = min(fuelUnits, BREWING_MAX_FUEL_CHARGES)`.
//   The excess goes into the fuel slot as ceil(excess / BREWING_FUEL_CHARGES)
//   blaze powder: truncating would lose brews the player paid for, and
//   converting every unit to a blaze powder (or every powder to charges)
//   would multiply them by BREWING_FUEL_CHARGES; rounding up adds at most
//   BREWING_FUEL_CHARGES - 1 brews. A count over one stack is a typed failure.
const migrateV17Brewing = (
  stand: BrewingStandState,
): Result.Result<unknown, SessionV17MigrationFailure> => Result.gen(function* () {
  const completed: BrewingStandState = stand.brewing === undefined
    ? stand
    : { ...stand, bottle: { potion: stand.brewing.output }, brewing: undefined }

  let bottle: unknown = null
  if (completed.bottle !== undefined) {
    const [, collected] = collectBrewingBottle(completed)
    // A stand with a bottle and no brew in progress is always collectable
    // (mx-gameplay `collectBrewingBottle` rejects only 'Brewing' and 'Empty').
    if (collected._tag !== 'Collected') throw new Error(`v17 brewing bottle was not collectable: ${collected.reason}`)
    bottle = yield* v17BrewingStack(collected.returned.item, collected.returned.count)
  }

  const ingredient = completed.ingredient === undefined ? null : yield* v17BrewingStack(completed.ingredient, 1)

  const fuelCharges = Math.min(completed.fuelUnits, BREWING_MAX_FUEL_CHARGES)
  const fuelItemCount = Math.ceil((completed.fuelUnits - fuelCharges) / BREWING_FUEL_CHARGES)
  const maxStackCount = maxStackCountForItem(BREWING_FUEL_ITEM)
  if (fuelItemCount > maxStackCount) {
    return yield* Result.fail({
      _tag: 'V17BrewingFuelOverflow' as const,
      fuelUnits: completed.fuelUnits,
      fuelItemCount,
      maxStackCount,
    })
  }
  const fuel = fuelItemCount === 0 ? null : yield* v17BrewingStack(BREWING_FUEL_ITEM, fuelItemCount)

  return { bottles: [bottle, null, null], ingredient, fuel, fuelCharges, brewProgressSecs: 0 }
})

const migrateV17SessionHead = (
  payload: unknown,
): Result.Result<unknown, Schema.SchemaError | SessionV17MigrationFailure> =>
  Result.flatMap(Schema.decodeUnknownResult(V17SessionHeadSchema)(payload), (head) =>
    Result.map(migrateV17Brewing(head.state.brewing), (brewing) => ({
      ...head,
      state: {
        ...head.state,
        storage: {
          ...head.state.storage,
          inventory: { ...head.state.storage.inventory, slots: head.state.storage.inventory.slots.map(migrateV17Slot) },
          equipment: {
            ...head.state.storage.equipment,
            slots: Object.fromEntries(
              Object.entries(head.state.storage.equipment.slots).map(([slot, stack]) => [slot, migrateV17Slot(stack)]),
            ),
          },
        },
        containerStorage: {
          ...head.state.containerStorage,
          version: V18_CONTAINER_STORAGE_VERSION,
          containers: head.state.containerStorage.containers.map((container) => ({
            ...container,
            slots: container.slots.map(migrateV17Slot),
          })),
        },
        furnaces: head.state.furnaces.map((furnace) => ({
          ...furnace,
          state: migrateV17FurnaceState(furnace.state),
        })),
        brewing,
      },
    })))

// Built directly rather than through `defineFormatMigration` so a migration
// failure stays a typed `Result` failure instead of a thrown value.
const SESSION_V17_MIGRATION: SaveFormatMigration = {
  fromVersion: SaveFormatVersion(V17_SESSION_FORMAT_VERSION),
  migrate: migrateV17SessionHead,
}

// `defineFormat` only rejects a malformed name, version, or migration chain;
// all three are the constants above, so a failure here is a programming error.
export const SESSION_FORMAT: SaveFormat<SessionHead, unknown> = Result.getOrThrow(defineFormat({
  name: SESSION_FORMAT_NAME,
  version: SESSION_FORMAT_VERSION,
  schema: SessionHeadSchema,
  migrations: [SESSION_V17_MIGRATION],
}))

type SessionManifestErrorFields = {
  readonly reason: 'duplicate-coordinate' | 'missing-chunk'
  readonly dimension: Dimension
  readonly coord: ChunkCoord
  readonly key: string
}

export type SessionManifestError = YieldableError &
  SessionManifestErrorFields & { readonly _tag: 'SessionManifestError' }

export const SessionManifestError: new (fields: SessionManifestErrorFields) => SessionManifestError =
  Data.TaggedError('SessionManifestError')

export type SessionPersistenceError =
  | StorageError
  | SaveDecodeError
  | InstanceType<typeof SessionManifestError>

export const sessionHeadKey = (sessionId: string): SaveKey =>
  SaveKey(`mc-compose/session/${encodeURIComponent(sessionId)}/head`)

export const sessionChunkKey = (
  sessionId: string,
  revision: string,
  dimension: Dimension,
  coord: ChunkCoord,
): SaveKey =>
  SaveKey(
    `mc-compose/session/${encodeURIComponent(sessionId)}/revision/${encodeURIComponent(revision)}/dimension/${encodeURIComponent(dimension)}/chunk/${String(coord.cx)}/${String(coord.cz)}`,
  )

export const loadSession = (
  sessionId: string,
): Effect.Effect<Option.Option<SessionHead>, SessionPersistenceError, StoragePort> =>
  loadFrom(SESSION_FORMAT, sessionHeadKey(sessionId))

const SESSION_KEY_PREFIX = 'mc-compose/session/'
const SESSION_HEAD_KEY_PATTERN = /^mc-compose\/session\/([^/]+)\/head$/u

const sessionIdFromHeadKey = (key: SaveKey): string | undefined => {
  const match = SESSION_HEAD_KEY_PATTERN.exec(key)
  if (match === null) return undefined

  try {
    const sessionId = decodeURIComponent(match[1]!)
    return sessionHeadKey(sessionId) === key ? sessionId : undefined
  } catch {
    return undefined
  }
}

/** Enumerate valid session heads, ignoring malformed keys and independently corrupted sessions. */
export const listSessions = (): Effect.Effect<
  ReadonlyArray<SessionHead>,
  StorageError,
  StoragePort
> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const keys = yield* storage.keys
    const sessionIds = keys
      .map(sessionIdFromHeadKey)
      .filter((sessionId): sessionId is string => sessionId !== undefined)
      .sort()

    const sessions = yield* Effect.forEach(sessionIds, (sessionId) =>
      loadSession(sessionId).pipe(
        Effect.map(Option.filter((head) => head.sessionId === sessionId)),
        Effect.matchEffect({
          onFailure: () => Effect.succeed(Option.none<SessionHead>()),
          onSuccess: Effect.succeed,
        }),
      ),
    )
    return sessions.flatMap(Option.toArray)
  })

/** Remove every record belonging to one encoded session key prefix. */
export const deleteSession = (
  sessionId: string,
): Effect.Effect<void, StorageError, StoragePort> =>
  Effect.gen(function* () {
    const storage = yield* StoragePort
    const prefix = `${SESSION_KEY_PREFIX}${encodeURIComponent(sessionId)}/`
    const keys = yield* storage.keys
    yield* Effect.forEach(
      keys.filter((key) => key.startsWith(prefix)),
      (key) => storage.remove(key),
      { discard: true },
    )
  })

export type SaveSessionInput = {
  readonly sessionId: string
  readonly revision: string
  readonly metadata: SessionMetadata
  readonly state: SessionState
  readonly chunks: ReadonlyArray<DimensionChunk>
}

/** Write revision chunks first, atomically publish their manifest, then collect the old revision. */
export const saveSession = (
  input: SaveSessionInput,
): Effect.Effect<SessionHead, SessionPersistenceError, StoragePort> =>
  Effect.gen(function* () {
    const manifest = input.chunks.map(
      ({ dimension, chunk }): SessionChunkManifestEntry => ({
        dimension,
        coord: chunk.coord,
        key: sessionChunkKey(input.sessionId, input.revision, dimension, chunk.coord),
      }),
    )
    const duplicate = duplicateManifestEntry(manifest)
    if (duplicate !== undefined) {
      return yield* new SessionManifestError({
        reason: 'duplicate-coordinate',
        dimension: duplicate.dimension,
        coord: duplicate.coord,
        key: duplicate.key,
      })
    }

    const storage = yield* StoragePort
    const headKey = sessionHeadKey(input.sessionId)
    const previousSession = yield* loadSession(input.sessionId)
    const previousHeadEnvelope = yield* storage.get(headKey)
    const previousChunkEnvelopes = yield* Effect.forEach(manifest, (entry) =>
      storage.get(SaveKey(entry.key)).pipe(
        Effect.map((envelope) => ({ key: SaveKey(entry.key), envelope })),
      ),
    )

    const nextHead: SessionHead = {
      sessionId: input.sessionId,
      revision: input.revision,
      metadata: input.metadata,
      state: input.state,
      chunks: manifest,
    }

    yield* Effect.gen(function* () {
      yield* Effect.forEach(input.chunks, ({ chunk }, index) =>
        saveTo(CHUNK_FORMAT, SaveKey(manifest[index]!.key), chunk),
      )
      yield* saveTo(SESSION_FORMAT, headKey, nextHead)
    }).pipe(
      Effect.matchEffect({
        onFailure: (saveError) => Effect.gen(function* () {
          yield* (Option.isSome(previousHeadEnvelope)
            ? storage.put(headKey, previousHeadEnvelope.value)
            : storage.remove(headKey)
          ).pipe(Effect.matchEffect({ onFailure: () => Effect.void, onSuccess: () => Effect.void }))
          yield* Effect.forEach(
            previousChunkEnvelopes,
            ({ key, envelope }) =>
              (Option.isSome(envelope)
                ? storage.put(key, envelope.value)
                : storage.remove(key)
              ).pipe(Effect.matchEffect({ onFailure: () => Effect.void, onSuccess: () => Effect.void })),
            { discard: true },
          )
          return yield* Effect.fail(saveError)
        }),
        onSuccess: Effect.succeed,
      }),
    )

    if (Option.isSome(previousSession)) {
      const retainedKeys = new Set(manifest.map(({ key }) => key))
      yield* Effect.forEach(
        previousSession.value.chunks,
        ({ key }) =>
          retainedKeys.has(key)
            ? Effect.void
            : storage.remove(SaveKey(key)).pipe(
                Effect.matchEffect({ onFailure: () => Effect.void, onSuccess: () => Effect.void }),
              ),
        { discard: true },
      )
    }
    return nextHead
  })

const coordId = (dimension: Dimension, coord: ChunkCoord): string =>
  `${dimension}:${String(coord.cx)},${String(coord.cz)}`

const duplicateManifestEntry = (
  entries: ReadonlyArray<SessionChunkManifestEntry>,
): SessionChunkManifestEntry | undefined => {
  const coords = new Set<string>()
  for (const entry of entries) {
    const id = coordId(entry.dimension, entry.coord)
    if (coords.has(id)) return entry
    coords.add(id)
  }
  return undefined
}

export type LoadedSessionChunks = {
  readonly source: ChunkSource
  readonly chunks: ReadonlyArray<DimensionChunk>
}

/** Validate and preload the manifest so streaming never reaches asynchronous storage. */
export const makeSessionChunkSource = (
  head: SessionHead,
  dimension: Dimension,
  fallback: ChunkSource,
): Effect.Effect<LoadedSessionChunks, SessionPersistenceError, StoragePort> =>
  Effect.gen(function* () {
    const duplicate = duplicateManifestEntry(head.chunks)
    if (duplicate !== undefined) {
      return yield* new SessionManifestError({
        reason: 'duplicate-coordinate',
        dimension: duplicate.dimension,
        coord: duplicate.coord,
        key: duplicate.key,
      })
    }

    const savedChunks = new Map<string, DimensionChunk>()
    for (const entry of head.chunks) {
      const loaded = yield* loadFrom(CHUNK_FORMAT, SaveKey(entry.key))
      if (Option.isNone(loaded)) {
        return yield* new SessionManifestError({
          reason: 'missing-chunk',
          dimension: entry.dimension,
          coord: entry.coord,
          key: entry.key,
        })
      }
      savedChunks.set(coordId(entry.dimension, entry.coord), {
        dimension: entry.dimension,
        chunk: chunkSnapshotOf(loaded.value),
      })
    }

    return {
      source: (coord) => {
        const saved = savedChunks.get(coordId(dimension, coord))
        return saved === undefined
          ? fallback(coord)
          : Effect.sync(() => chunkSnapshotOf(saved.chunk))
      },
      chunks: [...savedChunks.values()].map(({ dimension: savedDimension, chunk }) => ({
        dimension: savedDimension,
        chunk: chunkSnapshotOf(chunk),
      })),
    }
  })

export const snapshotResidentChunks = (
  store: Pick<ChunkStoreApi, 'loadedCoords' | 'snapshot'>,
): Effect.Effect<ReadonlyArray<ChunkWithBlockStates>> =>
  Effect.gen(function* () {
    const coords = yield* store.loadedCoords
    const snapshots = yield* Effect.forEach(coords, store.snapshot)
    return snapshots.filter((chunk): chunk is ChunkWithBlockStates => chunk !== undefined)
  })
