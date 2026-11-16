import { Array as Arr, Option, Result } from 'effect'
import {
  chunkSnapshotOf,
  generatedChunkSource,
  NoiseSeed,
  type ChunkWithBlockStates,
  type ChunkSource,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import { EntitySerial, type EntitySerialExhausted } from '@nerima-games/mc-sim'
import {
  isDroppedItemBehaviour,
  isHostileMobSnapshot,
  repairRoster,
  type GameplayEntityRoster,
  type MobBehaviour,
  type MobEntity,
  type MobRoster,
} from '@nerima-games/mx-gameplay'

import type { DroppedItemLifetimeTracker } from './dropped-item-lifetime'
import type { DroppedItemMetadata } from './dropped-item-metadata'
import {
  normalizePersistedEntityRosters,
  persistedItemDropLifetime,
  type DimensionChunk,
  type PersistedEntityRoster,
  type SessionHead,
  type SessionState,
} from './session-persistence'
import { makeSessionChunkSourceFor } from './session-restoration'

const SAVED_DIMENSIONS: ReadonlyArray<Dimension> = ['overworld', 'nether', 'end']

/**
 * A loaded behaviour as the entities owner stores it. The save format carries
 * two host-only details the owner schema rejects: a dropped item's lifetime
 * (`elapsedSecs`, which `droppedItemLifetime` tracks instead) and a hostile
 * mob's absent inner behaviour, which JSON writes as `null` and the loader
 * turns back into an own `undefined` key. Neither changes the behaviour.
 */
const ownerBehaviourOf = (behaviour: MobBehaviour): MobBehaviour => {
  if (isDroppedItemBehaviour(behaviour)) {
    return {
      _tag: 'DroppedItem',
      item: behaviour.item,
      count: behaviour.count,
      durability: behaviour.durability,
      ...(behaviour.eligibleFromFrame === undefined ? {} : { eligibleFromFrame: behaviour.eligibleFromFrame }),
      ...(behaviour.customName === undefined ? {} : { customName: behaviour.customName }),
      ...(behaviour.enchantments === undefined ? {} : { enchantments: behaviour.enchantments }),
    }
  }
  if (isHostileMobSnapshot(behaviour) && behaviour.behaviour === undefined) {
    const { behaviour: _absent, ...withoutInner } = behaviour
    return withoutInner
  }
  return behaviour
}

export type SessionEntityRosterEntitiesDiscarded = Readonly<{
  _tag: 'SessionEntityRosterEntitiesDiscarded'
  discarded: number
}>

export type SessionEntityRosterMergeFailure = EntitySerialExhausted | SessionEntityRosterEntitiesDiscarded

export type SessionWorldInitialization<World> = {
  readonly activeSeed: number
  readonly initialKnownChunks: ReadonlyArray<DimensionChunk>
  readonly restored: { readonly chunks: ReadonlyArray<DimensionChunk> } | undefined
  readonly world: World
  readonly chunkSourceFor: (dimension: Dimension) => ChunkSource
  /**
   * Every dimension's saved roster as one roster, each entity carrying its
   * dimension: the entities owner's initial state.
   */
  readonly entities: MobRoster
  /**
   * The entities owner split back into the saved per-dimension rosters, with
   * the dropped-item lifetimes and metadata the host tracks.
   */
  readonly snapshotEntityRosters: (owner: GameplayEntityRoster) => SessionState['entities']
}

export const initializeSessionWorld = async <
  World,
  Head extends { readonly state: Pick<SessionHead['state'], 'seed' | 'entities'> } = SessionHead,
>(context: {
  readonly loadedSession: Option.Option<Head>
  readonly initialDimension: Dimension
  readonly worldSeed: number
  readonly loadSavedChunks: (
    session: Head,
    dimension: Dimension,
    fallback: ChunkSource,
  ) => Promise<{ readonly chunks: ReadonlyArray<DimensionChunk> }>
  readonly makeWorld: (input: {
    readonly seed: number
    readonly chunkSource: ChunkSource
    readonly dimension: Dimension
  }) => Promise<World>
  readonly restoreEntities: (world: World, roster: PersistedEntityRoster) => void
  readonly snapshotEntities: (world: World) => MobRoster
  readonly droppedItemLifetime: DroppedItemLifetimeTracker
  readonly droppedItemMetadata: Map<string, DroppedItemMetadata>
  readonly droppedItemMetadataKey: (dimension: Dimension, entityId: string) => string
  readonly droppedItemMetadataFromBehaviour: (behaviour: unknown) => DroppedItemMetadata
}): Promise<Result.Result<SessionWorldInitialization<World>, SessionEntityRosterMergeFailure>> => {
  const activeSeed = Option.isSome(context.loadedSession)
    ? context.loadedSession.value.state.seed
    : context.worldSeed
  const generatedSource = generatedChunkSource(NoiseSeed(activeSeed))
  const restored = Option.isSome(context.loadedSession)
    ? await context.loadSavedChunks(context.loadedSession.value, context.initialDimension, generatedSource)
    : undefined
  const initialKnownChunks = (restored?.chunks ?? []).map(({ dimension, chunk }) => ({
    dimension,
    chunk: chunkSnapshotOf(chunk),
  }))
  const persistedChunks = new Map<string, ChunkWithBlockStates>(
    (restored?.chunks ?? []).map(({ dimension, chunk }) => [
      `${dimension}:${String(chunk.coord.cx)},${String(chunk.coord.cz)}`,
      chunk,
    ]),
  )
  const chunkSourceFor = (dimension: Dimension): ChunkSource =>
    makeSessionChunkSourceFor(dimension, persistedChunks, generatedSource)
  const world = await context.makeWorld({
    seed: activeSeed,
    chunkSource: chunkSourceFor(context.initialDimension),
    dimension: context.initialDimension,
  })
  const restoredEntityRosters = normalizePersistedEntityRosters(
    Option.isSome(context.loadedSession) ? context.loadedSession.value.state.entities : undefined,
  )
  // Each saved roster goes through the world's entity manager first, which
  // repairs it the way any loaded roster is repaired (mob behaviours included).
  const canonicalRosters = SAVED_DIMENSIONS.map((dimension) => {
    context.restoreEntities(world, restoredEntityRosters[dimension])
    return { dimension, roster: context.snapshotEntities(world) }
  })
  // Saves written before the entities owner kept one id space per dimension,
  // so one id can name an entity in two dimensions. That is valid data in the
  // old format, not an invalid value, so it is migrated rather than rejected:
  // the host roster's own restore repair (mx-gameplay `repairRoster`) keeps the
  // id for its first holder (overworld, nether, end) and mints every later
  // holder a fresh `<kind>-<serial>` id that no saved entity uses, starting at
  // the highest saved serial, which is also the shared counter from here on.
  const tagged = canonicalRosters.flatMap(({ dimension, roster }) =>
    roster.entities.map((entity) => ({ dimension, entity })))
  const nextSerial = canonicalRosters.reduce(
    (highest, { roster }) => roster.nextSerial > highest ? roster.nextSerial : highest,
    EntitySerial(0),
  )
  const merged = repairRoster<MobBehaviour>(
    { entities: tagged.map(({ entity }) => entity), nextSerial },
    (_kind, behaviour) => behaviour,
  )
  if (Result.isFailure(merged)) return Result.fail(merged.failure)
  // Entities are matched to their dimensions by position, which holds only
  // while the repair keeps every entity.
  if (merged.success.repair.discarded > 0) {
    return Result.fail({ _tag: 'SessionEntityRosterEntitiesDiscarded', discarded: merged.success.repair.discarded })
  }
  const entities = Arr.zipWith(
    tagged,
    merged.success.roster.entities,
    ({ dimension }, entity): MobEntity => ({ ...entity, dimension }),
  )
  for (const dimension of SAVED_DIMENSIONS) {
    const drops = entities.filter((entity) =>
      entity.dimension === dimension && isDroppedItemBehaviour(entity.behaviour))
    context.droppedItemLifetime.restore(
      dimension,
      drops.map((entity) => ({
        entityId: entity.id,
        elapsedSecs: persistedItemDropLifetime(entity.behaviour).elapsedSecs,
      })),
    )
    for (const entity of drops) {
      context.droppedItemMetadata.set(
        context.droppedItemMetadataKey(dimension, entity.id),
        context.droppedItemMetadataFromBehaviour(entity.behaviour),
      )
    }
  }
  const rosterWithDroppedItemLifetimes = (
    dimension: Dimension,
    roster: PersistedEntityRoster,
  ): PersistedEntityRoster => ({
    ...roster,
    entities: roster.entities.map((entity) => {
      if (!isDroppedItemBehaviour(entity.behaviour)) return entity
      const metadata = context.droppedItemMetadata.get(
        context.droppedItemMetadataKey(dimension, entity.id),
      )
      return {
        ...entity,
        behaviour: {
          ...entity.behaviour,
          elapsedSecs: context.droppedItemLifetime.elapsed(dimension, entity.id),
          ...(metadata?.customName === undefined ? {} : { customName: metadata.customName }),
          ...(metadata?.enchantedItem === undefined
            ? {}
            : { enchantments: metadata.enchantedItem.enchantments }),
        },
      }
    }),
  })
  // The save format stays per dimension. Every saved roster carries the shared
  // serial, so reloading reproduces the owner's counter.
  const savedRosterOf = (owner: GameplayEntityRoster, dimension: Dimension): PersistedEntityRoster =>
    rosterWithDroppedItemLifetimes(dimension, {
      entities: owner.entities
        .filter((entity) => entity.dimension === dimension)
        .map(({ id, kind, feetPosition, healthPoints, behaviour }) => ({ id, kind, feetPosition, healthPoints, behaviour })),
      nextSerial: owner.nextSerial,
    })
  const snapshotEntityRosters = (owner: GameplayEntityRoster): SessionState['entities'] => ({
    overworld: savedRosterOf(owner, 'overworld'),
    nether: savedRosterOf(owner, 'nether'),
    end: savedRosterOf(owner, 'end'),
  })

  return Result.succeed({
    activeSeed,
    initialKnownChunks,
    restored,
    world,
    chunkSourceFor,
    entities: {
      entities: entities.map((entity) => ({ ...entity, behaviour: ownerBehaviourOf(entity.behaviour) })),
      nextSerial: merged.success.roster.nextSerial,
    },
    snapshotEntityRosters,
  })
}
