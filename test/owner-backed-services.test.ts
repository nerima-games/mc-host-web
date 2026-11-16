import { EntityId, position, PositionAxis, WorldId } from '@nerima-games/mc-kernel'
import {
  EntityHealthPoints,
  EntityKind,
  makeWorldCommitCoordinator,
  PlayerServiceSnapshotSchema,
  PlayerStorageSnapshotSchema,
  WorldRevisionConflict,
  type EntityManagerApi,
  type InventoryServiceApi,
  type PlayerServiceApi,
  type ReplicatedOwnerCandidate,
  type WorldCommitCoordinatorApi,
} from '@nerima-games/mc-sim'
import {
  ExperienceOrbVitalsOwnerSnapshotSchema,
  GAMEPLAY_ENTITIES_OWNER_ID,
  GAMEPLAY_PLAYER_OWNER_ID,
  GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  GAMEPLAY_VITALS_OWNER_ID,
  GameplayEntityRosterSchema,
  gameplayOwnerRegistrations,
  makeInMemoryInventory,
  makeInMemoryWorld,
  totalOf,
  type InMemoryVitalsApi,
  type InMemoryWorld,
  type MobBehaviour,
} from '@nerima-games/mx-gameplay'
import { Effect } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  makeOwnerBackedWorld,
  type OwnerBackedCoordinator,
  type OwnerBackedEntities,
  type OwnerBackedInventory,
  type OwnerBackedPlayer,
  type OwnerBackedVitals,
  type OwnerBackedWorld,
} from '../apps/web/owner-backed-services'

const ownerIds = {
  player: GAMEPLAY_PLAYER_OWNER_ID,
  playerStorage: GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  vitals: GAMEPLAY_VITALS_OWNER_ID,
  entities: GAMEPLAY_ENTITIES_OWNER_ID,
}

type Harness = Readonly<{
  coordinator: WorldCommitCoordinatorApi
  world: InMemoryWorld<MobBehaviour>
  view: OwnerBackedWorld
}>

const makeHarness = async (
  wrap: (coordinator: WorldCommitCoordinatorApi) => OwnerBackedCoordinator = (coordinator) => coordinator,
): Promise<Harness> => {
  const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
    world: WorldId('owner-backed-services-test'),
    owners: gameplayOwnerRegistrations(),
  }))
  const world = await Effect.runPromise(makeInMemoryWorld<MobBehaviour>())
  const view = await Effect.runPromise(makeOwnerBackedWorld({ coordinator: wrap(coordinator), world, ownerIds }))
  return { coordinator, world, view }
}

// A stage-style direct owner commit against the current revision.
const commitOwners = (coordinator: WorldCommitCoordinatorApi, changes: ReadonlyArray<ReplicatedOwnerCandidate>) =>
  Effect.runSync(Effect.flatMap(coordinator.revision, (expectedRevision) =>
    coordinator.commit({ expectedRevision, expectedDimensions: [], changes })))

const at = (x: number, y: number, z: number) => position(PositionAxis(x), PositionAxis(y), PositionAxis(z))

const zombie = (x: number) => ({
  kind: EntityKind('zombie'),
  feetPosition: at(x, 64, 0),
  healthPoints: EntityHealthPoints(20),
  behaviour: undefined,
})

const ownerEntity = (id: string, dimension: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  id,
  kind: 'zombie',
  feetPosition: { x: 1, y: 64, z: 2 },
  healthPoints: 20,
  behaviour: undefined,
  dimension,
  ...extra,
})

const playerOwnerState = (dimension: string, x: number, y: number, z: number, yawRadians: number, pitchRadians: number) => ({
  pose: { feetPosition: { dimension, x, y, z }, yawRadians, pitchRadians },
})

const snapshotOf = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect)

describe('owner-backed views', () => {
  it('expose exactly the method sets of the services they wrap', async () => {
    expectTypeOf<keyof OwnerBackedPlayer>().toEqualTypeOf<keyof PlayerServiceApi>()
    expectTypeOf<keyof OwnerBackedInventory>().toEqualTypeOf<keyof InventoryServiceApi>()
    expectTypeOf<keyof OwnerBackedVitals>().toEqualTypeOf<keyof InMemoryVitalsApi>()
    expectTypeOf<keyof OwnerBackedEntities>().toEqualTypeOf<keyof EntityManagerApi<MobBehaviour>>()
    const { world, view } = await makeHarness()
    const names: ReadonlyArray<keyof OwnerBackedWorld> = ['player', 'inventory', 'vitals', 'entities']
    for (const name of names) {
      expect(Object.keys(view[name]).sort()).toEqual(Object.keys(world[name]).sort())
    }
  })

  describe('writes through a view reach the owner', () => {
    it('player', async () => {
      const { coordinator, view } = await makeHarness()
      Effect.runSync(view.player.moveTo(at(3.5, 70, -2.25)))
      Effect.runSync(view.player.setDimension('nether'))
      const owner = snapshotOf(coordinator.snapshot(GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema))
      expect(owner.state.pose.feetPosition).toEqual({ dimension: 'nether', x: 3.5, y: 70, z: -2.25 })
    })

    it('player storage', async () => {
      const { coordinator, view } = await makeHarness()
      expect(Effect.runSync(view.inventory.add('stone', 5))).toBe(0)
      const owner = snapshotOf(coordinator.snapshot(GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema))
      expect(totalOf(owner.state.inventory.slots, 'stone')).toBe(5)
    })

    it('vitals', async () => {
      const { coordinator, view } = await makeHarness()
      Effect.runSync(view.vitals.addExhaustion(1.5))
      const owner = snapshotOf(coordinator.snapshot(GAMEPLAY_VITALS_OWNER_ID, ExperienceOrbVitalsOwnerSnapshotSchema))
      expect(owner.state.vitals.exhaustion).toBe(1.5)
      expect(owner.state.vitals).toEqual(Effect.runSync(view.vitals.snapshot))
    })

    it('entities, tagged with the player dimension', async () => {
      const { coordinator, view } = await makeHarness()
      const spawned = Effect.runSync(view.entities.spawn(zombie(4)))
      const owner = snapshotOf(coordinator.snapshot(GAMEPLAY_ENTITIES_OWNER_ID, GameplayEntityRosterSchema))
      expect(owner.state.entities.map((entity) => [entity.id, entity.dimension])).toEqual([[spawned.id, 'overworld']])
    })
  })

  describe('owner commits in the stage shape are read through the view', () => {
    it('player, with the dimension split out of the pose', async () => {
      const { coordinator, world, view } = await makeHarness()
      Effect.runSync(view.player.pose)
      commitOwners(coordinator, [{ ownerId: GAMEPLAY_PLAYER_OWNER_ID, state: playerOwnerState('nether', 1.5, 80, -7, 0.5, 0.25) }])
      expect(Effect.runSync(view.player.dimension)).toBe('nether')
      expect(Effect.runSync(view.player.pose)).toEqual({ feetPosition: { x: 1.5, y: 80, z: -7 }, yawRadians: 0.5, pitchRadians: 0.25 })
      // `restore` keeps every key it is handed, so this shows the view passed a pose without `dimension`.
      expect(Object.keys(Effect.runSync(world.player.pose).feetPosition).sort()).toEqual(['x', 'y', 'z'])
    })

    it('player storage', async () => {
      const { coordinator, view } = await makeHarness()
      Effect.runSync(view.inventory.add('stone', 1))
      // A separate inventory only builds the storage value the stage would commit.
      const builder = await Effect.runPromise(makeInMemoryInventory())
      const stored = Effect.runSync(Effect.andThen(
        Effect.andThen(builder.restoreStorage(Effect.runSync(view.inventory.storageSnapshot)), builder.add('oak_planks', 7)),
        builder.storageSnapshot,
      ))
      commitOwners(coordinator, [{ ownerId: GAMEPLAY_PLAYER_STORAGE_OWNER_ID, state: stored }])
      expect(Effect.runSync(view.inventory.countOf('oak_planks'))).toBe(7)
      expect(Effect.runSync(view.inventory.countOf('stone'))).toBe(1)
    })

    it('vitals', async () => {
      const { coordinator, view } = await makeHarness()
      const current = Effect.runSync(view.vitals.snapshot)
      commitOwners(coordinator, [{ ownerId: GAMEPLAY_VITALS_OWNER_ID, state: { vitals: { ...current, healthPoints: 7 } } }])
      expect(Effect.runSync(view.vitals.snapshot).healthPoints).toBe(7)
    })

    it('entities, filtered to the player dimension', async () => {
      const { coordinator, view } = await makeHarness()
      commitOwners(coordinator, [{
        ownerId: GAMEPLAY_ENTITIES_OWNER_ID,
        state: { entities: [ownerEntity('zombie-1', 'overworld'), ownerEntity('zombie-2', 'nether')], nextSerial: 3 },
      }])
      expect(Effect.runSync(view.entities.entities).map((entity) => entity.id)).toEqual(['zombie-1'])
      commitOwners(coordinator, [{ ownerId: GAMEPLAY_PLAYER_OWNER_ID, state: playerOwnerState('nether', 0, 64, 0, 0, 0) }])
      expect(Effect.runSync(view.entities.entities).map((entity) => entity.id)).toEqual(['zombie-2'])
    })
  })

  it('returns WorldRevisionConflict when the owner moves between the read and the commit, and reloads afterwards', async () => {
    let interfered = false
    let interfere: Effect.Effect<unknown> = Effect.void
    const { coordinator, view } = await makeHarness((real) => ({
      revision: real.revision,
      snapshot: real.snapshot,
      // Another party commits once, after the view read the revision and before its own commit.
      commit: (request) => Effect.andThen(
        Effect.suspend(() => {
          if (interfered) return Effect.void
          interfered = true
          return interfere
        }),
        real.commit(request),
      ),
    }))
    const before = Effect.runSync(view.vitals.snapshot)
    interfere = Effect.sync(() =>
      commitOwners(coordinator, [{ ownerId: GAMEPLAY_VITALS_OWNER_ID, state: { vitals: { ...before, healthPoints: 3 } } }]))
    const revisionBefore = Effect.runSync(coordinator.revision)
    const failure = Effect.runSync(Effect.flip(view.vitals.addExhaustion(2)))
    expect(failure).toBeInstanceOf(WorldRevisionConflict)
    expect(failure).toMatchObject({ _tag: 'WorldRevisionConflict', expected: revisionBefore, actual: revisionBefore + 1 })
    // The rejected local change is dropped: the view reloads the owner the other party wrote.
    expect(Effect.runSync(view.vitals.snapshot)).toEqual({ ...before, healthPoints: 3 })
  })

  describe('entities across dimensions', () => {
    const seedOwner = (coordinator: WorldCommitCoordinatorApi) =>
      commitOwners(coordinator, [{
        ownerId: GAMEPLAY_ENTITIES_OWNER_ID,
        state: {
          entities: [
            ownerEntity('zombie-1', 'overworld', { killCredit: 'player', lastHitTick: 42 }),
            ownerEntity('zombie-2', 'nether', { killCredit: 'player-triggered-tnt' }),
            ownerEntity('zombie-3', 'overworld'),
          ],
          nextSerial: 10,
          resolvedMobProjectileIds: ['projectile-1'],
        },
      }])
    const ownerRoster = (coordinator: WorldCommitCoordinatorApi) =>
      snapshotOf(coordinator.snapshot(GAMEPLAY_ENTITIES_OWNER_ID, GameplayEntityRosterSchema)).state

    it('keeps other dimensions, metadata and owner order through a write', async () => {
      const { coordinator, view } = await makeHarness()
      seedOwner(coordinator)
      const seeded = ownerRoster(coordinator)
      expect(Effect.runSync(view.entities.despawn(EntityId('missing')))).toBe(false)
      expect(ownerRoster(coordinator)).toEqual(seeded)

      const spawned = Effect.runSync(view.entities.spawn(zombie(9)))
      expect(spawned.id).toBe('zombie-10')
      const owner = ownerRoster(coordinator)
      expect(owner.entities.map((entity) => [entity.id, entity.dimension])).toEqual([
        ['zombie-1', 'overworld'],
        ['zombie-2', 'nether'],
        ['zombie-3', 'overworld'],
        ['zombie-10', 'overworld'],
      ])
      expect(owner.entities[0]).toMatchObject({ killCredit: 'player', lastHitTick: 42 })
      expect(owner.entities[1]).toMatchObject({ killCredit: 'player-triggered-tnt' })
      expect(owner.resolvedMobProjectileIds).toEqual(['projectile-1'])
      expect(owner.nextSerial).toBe(11)
    })

    it('mints ids from one serial shared by every dimension', async () => {
      const { coordinator, view } = await makeHarness()
      seedOwner(coordinator)
      const inOverworld = Effect.runSync(view.entities.spawn(zombie(1)))
      Effect.runSync(view.player.setDimension('nether'))
      expect(Effect.runSync(view.entities.entities).map((entity) => entity.id)).toEqual(['zombie-2'])
      const inNether = Effect.runSync(view.entities.spawn(zombie(2)))
      expect([inOverworld.id, inNether.id]).toEqual(['zombie-10', 'zombie-11'])
      const ids = ownerRoster(coordinator).entities.map((entity) => entity.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('reset and restore act on the current dimension without lowering the shared serial', async () => {
      const { coordinator, view } = await makeHarness()
      seedOwner(coordinator)
      Effect.runSync(view.entities.reset)
      expect(ownerRoster(coordinator)).toMatchObject({ entities: [{ id: 'zombie-2', dimension: 'nether' }], nextSerial: 10 })
      Effect.runSync(view.entities.spawn(zombie(5)))
      expect(ownerRoster(coordinator).entities.map((entity) => entity.id)).toEqual(['zombie-2', 'zombie-10'])
    })

    it('reports an id that another dimension already uses instead of committing it', async () => {
      const { coordinator, view } = await makeHarness()
      seedOwner(coordinator)
      const seeded = ownerRoster(coordinator)
      const failure = Effect.runSync(Effect.flip(view.entities.restore({
        entities: [{ ...zombie(0), id: EntityId('zombie-2') }],
        nextSerial: Effect.runSync(view.entities.snapshot).nextSerial,
      })))
      expect(failure).toEqual({ _tag: 'OwnerBackedEntityIdCollision', ids: ['zombie-2'] })
      expect(ownerRoster(coordinator)).toEqual(seeded)
      expect(Effect.runSync(view.entities.entities).map((entity) => entity.id)).toEqual(['zombie-1', 'zombie-3'])
    })
  })

  it('round-trips the player pose and dimension unchanged', async () => {
    const { coordinator, view } = await makeHarness()
    const state = playerOwnerState('end', 12.25, 65, -3.5, 7.5, -0.75)
    commitOwners(coordinator, [{ ownerId: GAMEPLAY_PLAYER_OWNER_ID, state }])
    Effect.runSync(view.player.look(0, 0))
    expect(snapshotOf(coordinator.snapshot(GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema)).state).toEqual(state)
    expect(Effect.runSync(view.player.snapshot).state).toEqual(state)
  })

  it('keeps container contents when player storage is reloaded from the owner', async () => {
    const { coordinator, view } = await makeHarness()
    Effect.runSync(view.inventory.add('cobblestone', 10))
    expect(Effect.runSync(view.inventory.createContainer('chest-1'))).toMatchObject({ _tag: 'Created' })
    const playerSlot = Effect.runSync(view.inventory.snapshot).slots.findIndex((stack) => stack?.item === 'cobblestone')
    expect(Effect.runSync(view.inventory.transferContainerItem({
      direction: 'PlayerToContainer',
      containerId: 'chest-1',
      playerSlot,
      containerSlot: 0,
      count: 4,
    }))).toMatchObject({ _tag: 'Transferred' })
    const containers = Effect.runSync(view.inventory.containerStorageSnapshot)

    const storage = snapshotOf(coordinator.snapshot(GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state
    expect(totalOf(storage.inventory.slots, 'cobblestone')).toBe(6)
    commitOwners(coordinator, [{ ownerId: GAMEPLAY_PLAYER_STORAGE_OWNER_ID, state: storage }])
    expect(Effect.runSync(view.inventory.countOf('cobblestone'))).toBe(6)
    expect(Effect.runSync(view.inventory.containerStorageSnapshot)).toEqual(containers)
  })
})
