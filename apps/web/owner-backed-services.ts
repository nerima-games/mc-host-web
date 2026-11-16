import type { Dimension, WorldRevision } from '@nerima-games/mc-kernel'
import {
  PlayerServiceSnapshotSchema,
  PlayerStorageSnapshotSchema,
  type Entity,
  type EntityId,
  type EntityManagerApi,
  type EntityRoster,
  type EntitySerialExhausted,
  type EntityStep,
  type InventoryServiceApi,
  type ItemStackFailure,
  type PlayerPose,
  type PlayerServiceApi,
  type PlayerServiceInputError,
  type PlayerStorageValidationError,
  type ReplicatedOwnerCandidate,
  type ReplicatedOwnerId,
  type ReplicatedOwnerUnknown,
  type ReplicatedSnapshot,
  type RosterRepair,
  type WorldCommitCoordinatorApi,
  type WorldCommitCoordinatorError,
} from '@nerima-games/mc-sim'
import {
  ExperienceOrbVitalsOwnerSnapshotSchema,
  GameplayEntityRosterSchema,
  restoreGameplayEntityMetadata,
  type GameplayEntityMetadataFailure,
  type GameplayEntityRoster,
  type InMemoryVitalsApi,
  type InMemoryWorld,
  type MobBehaviour,
  type MobEntity,
  type MobRoster,
} from '@nerima-games/mx-gameplay'
import { Effect, Option, Ref, type Schema } from 'effect'

/**
 * The coordinator members a view may use. `commitFromSnapshot` is left out on
 * purpose: the coordinator holds one permit, so a view operation reached from a
 * `commitFromSnapshot` builder would deadlock it (invariant I2). The view only
 * runs `revision`, `snapshot` and `commit` one after another.
 */
export type OwnerBackedCoordinator = Pick<WorldCommitCoordinatorApi, 'revision' | 'snapshot' | 'commit'>

export type OwnerBackedOwnerIds = Readonly<{
  player: ReplicatedOwnerId
  playerStorage: ReplicatedOwnerId
  vitals: ReplicatedOwnerId
  entities: ReplicatedOwnerId
}>

export type OwnerBackedServices = Pick<InMemoryWorld<MobBehaviour>, 'player' | 'inventory' | 'vitals' | 'entities'>

export type OwnerBackedEntityIdCollision = Readonly<{
  _tag: 'OwnerBackedEntityIdCollision'
  ids: ReadonlyArray<EntityId>
}>

export type OwnerBackedEntityRosterRepaired = Readonly<{
  _tag: 'OwnerBackedEntityRosterRepaired'
  repair: RosterRepair
}>

type OwnerSnapshotError = Schema.SchemaError | ReplicatedOwnerUnknown

export type OwnerBackedPlayerSyncError = OwnerSnapshotError | PlayerServiceInputError
export type OwnerBackedPlayerWriteError = OwnerBackedPlayerSyncError | WorldCommitCoordinatorError
export type OwnerBackedInventorySyncError = OwnerSnapshotError | PlayerStorageValidationError | ItemStackFailure
export type OwnerBackedInventoryWriteError = OwnerBackedInventorySyncError | WorldCommitCoordinatorError
export type OwnerBackedVitalsSyncError = OwnerSnapshotError
export type OwnerBackedVitalsWriteError = OwnerBackedVitalsSyncError | WorldCommitCoordinatorError
export type OwnerBackedEntitiesSyncError = OwnerSnapshotError | EntitySerialExhausted | OwnerBackedEntityRosterRepaired
export type OwnerBackedEntitiesWriteError =
  | OwnerBackedEntitiesSyncError
  | WorldCommitCoordinatorError
  | GameplayEntityMetadataFailure
  | OwnerBackedEntityIdCollision

type WithError<Member, Added> = Member extends Effect.Effect<infer A, infer E, infer R>
  ? Effect.Effect<A, E | Added, R>
  : Member extends (...args: infer P) => Effect.Effect<infer A, infer E, infer R>
    ? (...args: P) => Effect.Effect<A, E | Added, R>
    : never

type Widened<Api, Keys extends keyof Api, Added> = { readonly [Key in Keys]: WithError<Api[Key], Added> }

type PlayerReadKey = 'pose' | 'dimension' | 'cameraPose' | 'replicatedCandidate' | 'submitReplicatedCandidate'
type PlayerWriteKey = 'look' | 'moveTo' | 'setDimension' | 'restore' | 'reset'

export type OwnerBackedPlayer =
  & Widened<PlayerServiceApi, PlayerReadKey, OwnerBackedPlayerSyncError>
  & Widened<PlayerServiceApi, PlayerWriteKey, OwnerBackedPlayerWriteError>
  & Readonly<{
    snapshot: Effect.Effect<ReplicatedSnapshot<typeof PlayerServiceSnapshotSchema>, OwnerSnapshotError>
  }>

type InventoryReadKey = 'getSlot' | 'getHotbarSlots' | 'countOf' | 'snapshot' | 'equipmentSnapshot' | 'storageSnapshot'
type InventoryWriteKey =
  | 'add'
  | 'addStoredStack'
  | 'remove'
  | 'removeAt'
  | 'click'
  | 'setSlot'
  | 'moveStack'
  | 'quickMove'
  | 'sortInventory'
  | 'restoreStorage'
  | 'equipFromInventory'
  | 'unequipToInventory'
  | 'damageAt'
  | 'consumeAndDamageAt'
  | 'transferContainerItem'
  | 'restore'
  | 'reset'
  | 'craft'
type InventoryLocalKey =
  | 'createContainer'
  | 'createContainerAt'
  | 'containerSnapshot'
  | 'containerSnapshotAt'
  | 'containerStorageSnapshot'
  | 'restoreContainerStorage'
  | 'extractContainerItem'
  | 'extractOneContainerItemAt'
  | 'moveContainerItem'
  | 'moveOneContainerItemAt'
  | 'drainContainer'
  | 'recipes'
  | 'previewCraft'

export type OwnerBackedInventory =
  & Widened<InventoryServiceApi, InventoryReadKey, OwnerBackedInventorySyncError>
  & Widened<InventoryServiceApi, InventoryWriteKey, OwnerBackedInventoryWriteError>
  & Pick<InventoryServiceApi, InventoryLocalKey>

type VitalsReadKey = 'snapshot' | 'view'
type VitalsWriteKey = 'damage' | 'heal' | 'addExhaustion' | 'eat' | 'advanceFoodTimer' | 'respawn' | 'restore' | 'reset'

export type OwnerBackedVitals =
  & Widened<InMemoryVitalsApi, VitalsReadKey, OwnerBackedVitalsSyncError>
  & Widened<InMemoryVitalsApi, VitalsWriteKey, OwnerBackedVitalsWriteError>

type MobEntityManagerApi = EntityManagerApi<MobBehaviour>
type EntitiesReadKey = 'entities' | 'find' | 'count' | 'countOfKind' | 'snapshot'
type EntitiesWriteKey = 'spawn' | 'despawn' | 'restore' | 'reset'

/**
 * Only the player's current dimension is visible. `restore` installs a roster
 * into that dimension and `reset` empties that dimension; entities in other
 * dimensions and the shared serial counter are kept.
 */
export type OwnerBackedEntities =
  & Widened<MobEntityManagerApi, EntitiesReadKey, OwnerBackedEntitiesSyncError>
  & Widened<MobEntityManagerApi, EntitiesWriteKey, OwnerBackedEntitiesWriteError>
  & Readonly<{
    sweep: <A>(
      step: (entity: Entity<MobBehaviour>) => EntityStep<MobBehaviour, A>,
    ) => Effect.Effect<ReadonlyArray<A>, OwnerBackedEntitiesWriteError>
  }>

export type OwnerBackedWorld = Readonly<{
  player: OwnerBackedPlayer
  inventory: OwnerBackedInventory
  vitals: OwnerBackedVitals
  entities: OwnerBackedEntities
}>

export type OwnerBackedWorldOptions = Readonly<{
  coordinator: OwnerBackedCoordinator
  world: OwnerBackedServices
  ownerIds: OwnerBackedOwnerIds
}>

type Synced<Cache> = Readonly<{ revision: WorldRevision; cache: Cache }>

type OwnerCommit<Cache> = Readonly<{ changes: ReadonlyArray<ReplicatedOwnerCandidate>; cache: Cache }>

type OwnerSync<Cache, SyncError> = Readonly<{
  read: <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SyncError, R>
  write: <A, E, R, ChangeError>(
    operation: Effect.Effect<A, E, R>,
    toCommit: (cache: Cache) => Effect.Effect<OwnerCommit<Cache>, ChangeError>,
  ) => Effect.Effect<A, E | SyncError | ChangeError | WorldCommitCoordinatorError, R>
}>

// Each view keeps its own synced revision. Any commit (a stage, another view)
// bumps the one world revision, so a shared marker would let a view that did
// not reload treat another owner's change as already applied.
const makeOwnerSync = <Cache, SyncError>(
  coordinator: OwnerBackedCoordinator,
  load: Effect.Effect<Cache, SyncError>,
): Effect.Effect<OwnerSync<Cache, SyncError>> =>
  Effect.map(Ref.make(Option.none<Synced<Cache>>()), (state) => {
    const synced: Effect.Effect<Synced<Cache>, SyncError> = Effect.gen(function* () {
      const revision = yield* coordinator.revision
      const last = yield* Ref.get(state)
      if (Option.isSome(last) && last.value.revision === revision) return last.value
      const next: Synced<Cache> = { revision, cache: yield* load }
      yield* Ref.set(state, Option.some(next))
      return next
    })
    return {
      read: (operation) => Effect.andThen(synced, operation),
      write: (operation, toCommit) =>
        Effect.gen(function* () {
          const current = yield* synced
          // The local service runs ahead of the owner until the commit lands. Any
          // failure from here on leaves the view unsynced, so the next operation
          // reloads the owner instead of keeping the uncommitted local change.
          yield* Ref.set(state, Option.none())
          const result = yield* operation
          const next = yield* toCommit(current.cache)
          // I3: the revision read by this same operation; a conflict is returned, not retried.
          const delta = yield* coordinator.commit({
            expectedRevision: current.revision,
            expectedDimensions: [],
            changes: next.changes,
          })
          yield* Ref.set(state, Option.some({ revision: delta.revision, cache: next.cache }))
          return result
        }),
    }
  })

const playerOwnerState = (pose: PlayerPose, dimension: Dimension) => ({
  pose: {
    feetPosition: { dimension, x: pose.feetPosition.x, y: pose.feetPosition.y, z: pose.feetPosition.z },
    yawRadians: pose.yawRadians,
    pitchRadians: pose.pitchRadians,
  },
})

const makePlayerView = (
  coordinator: OwnerBackedCoordinator,
  player: PlayerServiceApi,
  ownerId: ReplicatedOwnerId,
): Effect.Effect<OwnerBackedPlayer> => {
  const ownerSnapshot = coordinator.snapshot(ownerId, PlayerServiceSnapshotSchema)
  const load = Effect.flatMap(ownerSnapshot, ({ state: { pose } }) =>
    // `restore` keeps every key of the pose it is given, so the owner's
    // dimension must not stay inside `feetPosition`.
    player.restore(
      {
        feetPosition: { x: pose.feetPosition.x, y: pose.feetPosition.y, z: pose.feetPosition.z },
        yawRadians: pose.yawRadians,
        pitchRadians: pose.pitchRadians,
      },
      pose.feetPosition.dimension,
    ))
  const toCommit = (): Effect.Effect<OwnerCommit<void>> =>
    Effect.map(Effect.all([player.pose, player.dimension]), ([pose, dimension]) => ({
      changes: [{ ownerId, state: playerOwnerState(pose, dimension) }],
      cache: undefined,
    }))
  return Effect.map(makeOwnerSync(coordinator, load), ({ read, write }): OwnerBackedPlayer => ({
    pose: read(player.pose),
    dimension: read(player.dimension),
    look: (deltaYaw, deltaPitch) => write(player.look(deltaYaw, deltaPitch), toCommit),
    moveTo: (feetPosition) => write(player.moveTo(feetPosition), toCommit),
    setDimension: (dimension) => write(player.setDimension(dimension), toCommit),
    cameraPose: read(player.cameraPose),
    restore: (pose, dimension) => write(player.restore(pose, dimension), toCommit),
    // Read from the view's own coordinator and owner id rather than the
    // service's Context lookup, so the view cannot read a different store.
    snapshot: ownerSnapshot,
    replicatedCandidate: read(player.replicatedCandidate),
    // After the reload the local state equals the owner, so the service
    // submits the owner's own state. Its commit moves the world revision, which
    // makes the next view operation reload.
    submitReplicatedCandidate: (expectedRevision, expectedDimensionRevision) =>
      read(player.submitReplicatedCandidate(expectedRevision, expectedDimensionRevision)),
    reset: write(player.reset, toCommit),
  }))
}

const makeInventoryView = (
  coordinator: OwnerBackedCoordinator,
  inventory: InventoryServiceApi,
  ownerId: ReplicatedOwnerId,
): Effect.Effect<OwnerBackedInventory> => {
  // `restoreStorage` replaces only the player storage; containers stay in the local Ref.
  const load = Effect.flatMap(
    coordinator.snapshot(ownerId, PlayerStorageSnapshotSchema),
    ({ state }) => inventory.restoreStorage(state),
  )
  const toCommit = (): Effect.Effect<OwnerCommit<void>> =>
    Effect.map(inventory.storageSnapshot, (state) => ({ changes: [{ ownerId, state }], cache: undefined }))
  return Effect.map(makeOwnerSync(coordinator, load), ({ read, write }): OwnerBackedInventory => ({
    add: (item, count) => write(inventory.add(item, count), toCommit),
    addStoredStack: (stack) => write(inventory.addStoredStack(stack), toCommit),
    remove: (item, count) => write(inventory.remove(item, count), toCommit),
    removeAt: (slotIndex, expectedItem, count) => write(inventory.removeAt(slotIndex, expectedItem, count), toCommit),
    click: (click) => write(inventory.click(click), toCommit),
    getSlot: (slotIndex) => read(inventory.getSlot(slotIndex)),
    getHotbarSlots: read(inventory.getHotbarSlots),
    setSlot: (slotIndex, slot) => write(inventory.setSlot(slotIndex, slot), toCommit),
    moveStack: (sourceIndex, targetIndex) => write(inventory.moveStack(sourceIndex, targetIndex), toCommit),
    quickMove: (slotIndex) => write(inventory.quickMove(slotIndex), toCommit),
    sortInventory: write(inventory.sortInventory, toCommit),
    countOf: (item) => read(inventory.countOf(item)),
    snapshot: read(inventory.snapshot),
    equipmentSnapshot: read(inventory.equipmentSnapshot),
    storageSnapshot: read(inventory.storageSnapshot),
    restoreStorage: (snapshot) => write(inventory.restoreStorage(snapshot), toCommit),
    equipFromInventory: (inventorySlot, equipmentSlot) =>
      write(inventory.equipFromInventory(inventorySlot, equipmentSlot), toCommit),
    unequipToInventory: (equipmentSlot, inventorySlot) =>
      write(inventory.unequipToInventory(equipmentSlot, inventorySlot), toCommit),
    damageAt: (location, amount) => write(inventory.damageAt(location, amount), toCommit),
    consumeAndDamageAt: (request) => write(inventory.consumeAndDamageAt(request), toCommit),
    createContainer: inventory.createContainer,
    createContainerAt: inventory.createContainerAt,
    containerSnapshot: inventory.containerSnapshot,
    containerSnapshotAt: inventory.containerSnapshotAt,
    containerStorageSnapshot: inventory.containerStorageSnapshot,
    restoreContainerStorage: inventory.restoreContainerStorage,
    transferContainerItem: (request) => write(inventory.transferContainerItem(request), toCommit),
    extractContainerItem: inventory.extractContainerItem,
    extractOneContainerItemAt: inventory.extractOneContainerItemAt,
    moveContainerItem: inventory.moveContainerItem,
    moveOneContainerItemAt: inventory.moveOneContainerItemAt,
    drainContainer: inventory.drainContainer,
    restore: (snapshot) => write(inventory.restore(snapshot), toCommit),
    reset: write(inventory.reset, toCommit),
    recipes: inventory.recipes,
    previewCraft: inventory.previewCraft,
    craft: (grid) => write(inventory.craft(grid), toCommit),
  }))
}

const makeVitalsView = (
  coordinator: OwnerBackedCoordinator,
  vitals: InMemoryVitalsApi,
  ownerId: ReplicatedOwnerId,
): Effect.Effect<OwnerBackedVitals> => {
  const load = Effect.flatMap(
    coordinator.snapshot(ownerId, ExperienceOrbVitalsOwnerSnapshotSchema),
    ({ state }) => vitals.restore(state.vitals),
  )
  const toCommit = (): Effect.Effect<OwnerCommit<void>> =>
    Effect.map(vitals.snapshot, (state) => ({ changes: [{ ownerId, state: { vitals: state } }], cache: undefined }))
  return Effect.map(makeOwnerSync(coordinator, load), ({ read, write }): OwnerBackedVitals => ({
    snapshot: read(vitals.snapshot),
    view: read(vitals.view),
    damage: (damage) => write(vitals.damage(damage), toCommit),
    heal: (amount) => write(vitals.heal(amount), toCommit),
    addExhaustion: (amount) => write(vitals.addExhaustion(amount), toCommit),
    eat: (foodPoints, saturationModifier) => write(vitals.eat(foodPoints, saturationModifier), toCommit),
    advanceFoodTimer: (dt, starvationHealthFloor) => write(vitals.advanceFoodTimer(dt, starvationHealthFloor), toCommit),
    respawn: write(vitals.respawn, toCommit),
    restore: (state) => write(vitals.restore(state), toCommit),
    reset: write(vitals.reset, toCommit),
  }))
}

type EntitiesCache = Readonly<{ owner: GameplayEntityRoster; dimension: Dimension }>

/**
 * Put the local (current-dimension) entities back among the owner's other
 * dimensions. Current-dimension slots are refilled in local order, so a write
 * that changed nothing reproduces the owner's order exactly.
 */
const mergeCurrentDimension = (
  owner: GameplayEntityRoster,
  dimension: Dimension,
  local: EntityRoster<MobBehaviour>,
): MobRoster => {
  const entities: Array<MobEntity> = []
  let nextLocal = 0
  for (const entity of owner.entities) {
    if (entity.dimension !== dimension) {
      entities.push(entity)
      continue
    }
    const replacement = local.entities[nextLocal]
    if (replacement !== undefined) {
      entities.push(replacement)
      nextLocal += 1
    }
  }
  entities.push(...local.entities.slice(nextLocal))
  // The serial is shared by every dimension. `restore` and `reset` can lower
  // the local counter, and a lowered counter would mint ids another dimension
  // already uses.
  const nextSerial = local.nextSerial >= owner.nextSerial ? local.nextSerial : owner.nextSerial
  return { entities, nextSerial }
}

const duplicateIds = (entities: ReadonlyArray<MobEntity>): ReadonlyArray<EntityId> => {
  const seen = new Set<EntityId>()
  const duplicates = new Set<EntityId>()
  for (const entity of entities) {
    if (seen.has(entity.id)) duplicates.add(entity.id)
    seen.add(entity.id)
  }
  return [...duplicates]
}

const makeEntitiesView = (
  coordinator: OwnerBackedCoordinator,
  entities: MobEntityManagerApi,
  ownerIds: Pick<OwnerBackedOwnerIds, 'entities' | 'player'>,
): Effect.Effect<OwnerBackedEntities> => {
  const load: Effect.Effect<EntitiesCache, OwnerBackedEntitiesSyncError> = Effect.gen(function* () {
    const owner = (yield* coordinator.snapshot(ownerIds.entities, GameplayEntityRosterSchema)).state
    const player = yield* coordinator.snapshot(ownerIds.player, PlayerServiceSnapshotSchema)
    const dimension = player.state.pose.feetPosition.dimension
    const repair = yield* entities.restore({
      entities: owner.entities.filter((entity) => entity.dimension === dimension),
      nextSerial: owner.nextSerial,
    })
    // A repair renumbers or drops owner entities in the local copy only, so the
    // next write would commit ids the owner never had.
    if (repair.discarded > 0 || repair.reidentified > 0) {
      const failure: OwnerBackedEntityRosterRepaired = { _tag: 'OwnerBackedEntityRosterRepaired', repair }
      return yield* Effect.fail(failure)
    }
    return { owner, dimension }
  })
  const toCommit = (
    cache: EntitiesCache,
  ): Effect.Effect<
    OwnerCommit<EntitiesCache>,
    EntitySerialExhausted | GameplayEntityMetadataFailure | OwnerBackedEntityIdCollision
  > =>
    Effect.gen(function* () {
      const local = yield* entities.snapshot
      const merged = mergeCurrentDimension(cache.owner, cache.dimension, local)
      const collisions = duplicateIds(merged.entities)
      if (collisions.length > 0) {
        const failure: OwnerBackedEntityIdCollision = { _tag: 'OwnerBackedEntityIdCollision', ids: collisions }
        return yield* Effect.fail(failure)
      }
      // The view stays synced after this commit, so the local counter must
      // match the committed one or the next spawn mints from the lowered value.
      if (merged.nextSerial !== local.nextSerial) {
        yield* entities.restore({ entities: local.entities, nextSerial: merged.nextSerial })
      }
      // The local restore drops dimension, kill credit, last hit tick and the
      // projectile bookkeeping; the previous owner state supplies them again.
      const owner = yield* Effect.fromResult(restoreGameplayEntityMetadata(merged, cache.owner, cache.dimension))
      return { changes: [{ ownerId: ownerIds.entities, state: owner }], cache: { owner, dimension: cache.dimension } }
    })
  return Effect.map(makeOwnerSync(coordinator, load), ({ read, write }): OwnerBackedEntities => ({
    spawn: (request) => write(entities.spawn(request), toCommit),
    despawn: (id) => write(entities.despawn(id), toCommit),
    entities: read(entities.entities),
    find: (id) => read(entities.find(id)),
    count: read(entities.count),
    countOfKind: (kind) => read(entities.countOfKind(kind)),
    sweep: (step) => write(entities.sweep(step), toCommit),
    snapshot: read(entities.snapshot),
    restore: (roster) => write(entities.restore(roster), toCommit),
    reset: write(entities.reset, toCommit),
  }))
}

/**
 * Views over the in-memory services whose source of truth is the coordinator's
 * owners: each operation reloads the owner when the world revision moved, and
 * each write commits the converted local state with the revision it read.
 *
 * The original service objects must not be handed out after this (I1), and no
 * view operation may run inside a `commitFromSnapshot` builder (I2).
 */
export const makeOwnerBackedWorld = ({
  coordinator,
  world,
  ownerIds,
}: OwnerBackedWorldOptions): Effect.Effect<OwnerBackedWorld> =>
  Effect.all({
    player: makePlayerView(coordinator, world.player, ownerIds.player),
    inventory: makeInventoryView(coordinator, world.inventory, ownerIds.playerStorage),
    vitals: makeVitalsView(coordinator, world.vitals, ownerIds.vitals),
    entities: makeEntitiesView(coordinator, world.entities, ownerIds),
  })
