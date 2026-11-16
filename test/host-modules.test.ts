import { assert, describe, expect, it } from '@effect/vitest'
import { Context, Effect, Layer, Option, Ref, Schema } from 'effect'
import {
  DeltaTimeSecs,
  EpochMillis,
  FixedClockLayer,
  MonotonicTimeSecs,
  position,
  PositionAxis,
  WorldIdSchema,
  WorldWritePort,
} from '@nerima-games/mc-kernel'
import { composeGame } from '@nerima-games/mc-compose'
import {
  CropService,
  InventoryService,
  makeCropService,
  makeSimFrameState,
  makeTimeService,
  makeVehicleService,
  PlayerService,
  PlayerServiceSnapshotSchema,
  TimeService,
  VehicleService,
  type SimFrameState,
} from '@nerima-games/mc-sim'
import { EMPTY_SYNC_REPORT, InputService, InputServiceLayer, NO_CHUNK_SYNC, NO_DRAW_TARGET, type ChunkSyncPort } from '@nerima-games/mc-render'
import { RedstoneWorldRuntime, RedstoneWorldRuntimeLayer } from '@nerima-games/mx-redstone'
import { makeUiFrameState } from '@nerima-games/mx-ui'
import {
  GAMEPLAY_ENTITIES_OWNER_ID,
  GAMEPLAY_PLAYER_OWNER_ID,
  GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  GAMEPLAY_VITALS_OWNER_ID,
  gameplayOwnerRegistrations,
  makeGameplayFrameState,
  makeGeneratedWorld,
  type MobBehaviour,
} from '@nerima-games/mx-gameplay'
import {
  ChunkCapacity,
  ChunkStore,
  generatedChunkSource,
  makeChunkStore,
  NoiseSeed,
} from '@nerima-games/mc-worldgen'
import {
  makeHostServiceContext,
  MobEntityManager,
  registerHostModules,
  type HostGameModule,
  type HostModulesDeps,
  type HostServiceInstances,
} from '../apps/web/host-modules'
import { makeOwnerBackedHost } from '../apps/web/owner-backed-services'
import { makeHostWorldWrite } from '../apps/web/world-write-port'

// The browser twin of this list is e2e/smoke.e2e.ts #3b; both must change together.
const SMOKE_STAGE_ORDER = [
  'render:input',
  'sim:physics',
  'gameplay:vehicles',
  'gameplay:interactions',
  'gameplay:fire',
  'gameplay:survival-hunger',
  'gameplay:entities',
  'gameplay:ender-dragon',
  'gameplay:fluids',
  'redstone:power',
  'redstone:effects',
  'gameplay:time-weather',
  'render:camera-mirror',
  'render:chunk-sync',
  'render:post-fx',
  'render:draw',
  'ui:hud-sync',
  'ui:overlay-sync',
]

// InputService and RedstoneWorldRuntime are built once into a Context, as
// platform-adapters.ts does, so the scope of the test owns them. The player and
// entity services are wired as main.ts wires them: the owner-backed adapters
// over one coordinator, with the generated world's services behind the views.
const makeHost = Effect.gen(function* () {
  const chunkStore = yield* makeChunkStore(generatedChunkSource(NoiseSeed(1)), ChunkCapacity(16))
  const hostWorldWrite = yield* makeHostWorldWrite({
    world: yield* Schema.decodeEffect(WorldIdSchema)('host-modules-test'),
    owners: gameplayOwnerRegistrations(),
    chunkStores: { forDimension: () => chunkStore },
  })
  const generated = yield* makeGeneratedWorld<MobBehaviour>({ dimension: 'overworld' })
  const owned = yield* makeOwnerBackedHost({
    coordinator: hostWorldWrite.coordinator,
    world: generated,
    ownerIds: {
      player: GAMEPLAY_PLAYER_OWNER_ID,
      playerStorage: GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
      vitals: GAMEPLAY_VITALS_OWNER_ID,
      entities: GAMEPLAY_ENTITIES_OWNER_ID,
    },
  })
  const instances: HostServiceInstances = {
    time: yield* makeTimeService(),
    player: owned.stagePlayer,
    crops: yield* makeCropService(),
    vehicles: yield* makeVehicleService(),
    entities: owned.entityManager,
    chunkStore,
    worldWrite: hostWorldWrite.port,
    inputContext: yield* Layer.build(InputServiceLayer()),
    redstoneContext: yield* Layer.build(RedstoneWorldRuntimeLayer),
  }
  return { instances, owned, generated, coordinator: hostWorldWrite.coordinator }
})

const makeInstances = Effect.map(makeHost, ({ instances }) => instances)

const makeDeps = (
  instances: HostServiceInstances,
  chunkSync: ChunkSyncPort = NO_CHUNK_SYNC,
  simState?: SimFrameState,
) =>
  Effect.gen(function* () {
    const deps: HostModulesDeps = {
      services: makeHostServiceContext(instances),
      renderQuality: undefined,
      draw: NO_DRAW_TARGET,
      chunkSync,
      uiFrameState: yield* makeUiFrameState,
      simState: simState ?? (yield* makeSimFrameState),
      gameplayState: yield* makeGameplayFrameState,
      isActiveDimension: () => true,
      poweredRails: new Set<string>(),
      leverKeyOf: (lever) =>
        JSON.stringify([lever.dimension, lever.position.x, lever.position.y, lever.position.z]),
      getMountedVehicleId: () => undefined,
      setMountedVehicleId: () => undefined,
      getVehicleControls: () => ({ throttle: 0, steering: 0 }),
      multiplayer: undefined,
    }
    return deps
  })

describe('host modules', () => {
  it.effect('composes the stage order the browser smoke test asserts', () =>
    Effect.gen(function* () {
      const deps = yield* makeDeps(yield* makeInstances)

      // Compile-time: providing `services` discharges every registration requirement.
      const registered: Effect.Effect<ReadonlyArray<HostGameModule>, never, never> = registerHostModules(deps)
      const modules = yield* registered
      const game = yield* composeGame(modules)

      expect(game.plan.order).toStrictEqual(SMOKE_STAGE_ORDER)
    }))

  it.effect('resolves every host service tag to the instance the host passed in', () =>
    Effect.gen(function* () {
      const instances = yield* makeInstances
      const services = makeHostServiceContext(instances)

      expect(Context.get(services, TimeService)).toBe(instances.time)
      expect(Context.get(services, PlayerService)).toBe(instances.player)
      expect(Context.get(services, CropService)).toBe(instances.crops)
      expect(Context.get(services, VehicleService)).toBe(instances.vehicles)
      expect(Context.get(services, MobEntityManager)).toBe(instances.entities)
      expect(Context.get(services, ChunkStore)).toBe(instances.chunkStore)
      expect(Context.get(services, WorldWritePort)).toBe(instances.worldWrite)
      expect(Context.get(services, InputService)).toBe(Context.get(instances.inputContext, InputService))
      expect(Context.get(services, RedstoneWorldRuntime)).toBe(
        Context.get(instances.redstoneContext, RedstoneWorldRuntime),
      )
    }))

  it.effect('the registered sim:physics stage advances the host-owned TimeService', () =>
    Effect.gen(function* () {
      const instances = yield* makeInstances
      const modules = yield* registerHostModules(yield* makeDeps(instances))
      const physics = modules
        .find((module) => module.name === '@nerima-games/mc-sim')
        ?.frameStages.find((stage) => stage.id === 'sim:physics')
      assert.isDefined(physics)

      const before = yield* instances.time.snapshot
      yield* Effect.provide(
        physics.run(DeltaTimeSecs(0.05)),
        FixedClockLayer({ monotonicSecs: MonotonicTimeSecs(0), wallClockEpochMillis: EpochMillis(0) }),
      )
      const after = yield* instances.time.snapshot

      expect(after.ticks).toBe(before.ticks + 1)
      expect(after.dayLengthTicks).toBe(before.dayLengthTicks)
    }))

  it.effect('mc-render registers the only chunk-sync stage and it updates the host ChunkSyncPort', () =>
    Effect.gen(function* () {
      let updates = 0
      const chunkSync: ChunkSyncPort = {
        update: Effect.sync(() => {
          updates += 1
          return EMPTY_SYNC_REPORT
        }),
      }
      const modules = yield* registerHostModules(yield* makeDeps(yield* makeInstances, chunkSync))
      const chunkSyncStages = modules.flatMap((module) =>
        module.frameStages
          .filter((stage) => stage.id.endsWith(':chunk-sync'))
          .map((stage) => ({ module: module.name, stage })),
      )
      expect(chunkSyncStages.map(({ module, stage }) => `${module}/${stage.id}`)).toEqual([
        '@nerima-games/mc-render/render:chunk-sync',
      ])
      const [registered] = chunkSyncStages
      assert.isDefined(registered)

      yield* Effect.provide(
        registered.stage.run(DeltaTimeSecs(0.05)),
        FixedClockLayer({ monotonicSecs: MonotonicTimeSecs(0), wallClockEpochMillis: EpochMillis(0) }),
      )

      expect(updates).toBe(1)
    }))

  it.effect('gives the Context the owner-backed adapters and none of the generated world services', () =>
    Effect.gen(function* () {
      const { instances, owned, generated } = yield* makeHost
      const services = makeHostServiceContext(instances)

      expect(Context.get(services, PlayerService)).toBe(owned.stagePlayer)
      expect(Context.get(services, MobEntityManager)).toBe(owned.entityManager)
      // No registered module reads an InventoryService, so none is provided.
      expect(Option.isNone(Context.getOption(services, InventoryService))).toBe(true)
      const provided = [...services.mapUnsafe.values()]
      for (const raw of [generated.player, generated.inventory, generated.vitals, generated.entities]) {
        expect(provided).not.toContain(raw)
      }
    }))

  it.effect('a Context PlayerService write commits to the coordinator the host views read', () =>
    Effect.gen(function* () {
      const { instances, owned, coordinator } = yield* makeHost
      const player = Context.get(makeHostServiceContext(instances), PlayerService)
      const destination = position(PositionAxis(4.5), PositionAxis(80), PositionAxis(-6.5))

      yield* player.moveTo(destination)

      const committed = yield* coordinator.snapshot(GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema)
      expect(committed.state.pose.feetPosition).toEqual({ dimension: 'overworld', x: 4.5, y: 80, z: -6.5 })
      expect((yield* owned.views.player.pose).feetPosition).toEqual(destination)
    }))

  it.effect('the registered sim:physics stage writes the player through the same owner-backed adapter', () =>
    Effect.gen(function* () {
      const { instances, owned, coordinator } = yield* makeHost
      const simState = yield* makeSimFrameState
      const modules = yield* registerHostModules(yield* makeDeps(instances, NO_CHUNK_SYNC, simState))
      const physics = modules
        .find((module) => module.name === '@nerima-games/mc-sim')
        ?.frameStages.find((stage) => stage.id === 'sim:physics')
      assert.isDefined(physics)
      const destination = position(PositionAxis(-2.5), PositionAxis(90), PositionAxis(3.5))
      // A resolved position is applied with the stage's one `player.moveTo`.
      yield* Ref.set(simState.resolvedFeetPosition, Option.some(destination))

      yield* Effect.provide(
        physics.run(DeltaTimeSecs(0.05)),
        FixedClockLayer({ monotonicSecs: MonotonicTimeSecs(0), wallClockEpochMillis: EpochMillis(0) }),
      )

      const committed = yield* coordinator.snapshot(GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema)
      expect(committed.state.pose.feetPosition).toEqual({ dimension: 'overworld', x: -2.5, y: 90, z: 3.5 })
      expect((yield* owned.views.player.pose).feetPosition).toEqual(destination)
    }))
})
