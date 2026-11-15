import { assert, describe, expect, it } from '@effect/vitest'
import { Context, Effect, Layer } from 'effect'
import {
  DeltaTimeSecs,
  EpochMillis,
  FixedClockLayer,
  MonotonicTimeSecs,
  StageId,
} from '@nerima-games/mc-kernel'
import { composeGame, type StageRegistration } from '@nerima-games/mc-compose'
import {
  CropService,
  InventoryService,
  makeCropService,
  makeEntityManager,
  makeInventoryService,
  makePlayerService,
  makeSimFrameState,
  makeTimeService,
  makeVehicleService,
  PlayerService,
  TimeService,
  VehicleService,
} from '@nerima-games/mc-sim'
import { InputService, InputServiceLayer, NO_DRAW_TARGET } from '@nerima-games/mc-render'
import { RedstoneWorldRuntime, RedstoneWorldRuntimeLayer } from '@nerima-games/mx-redstone'
import { makeUiFrameState } from '@nerima-games/mx-ui'
import { makeGameplayFrameState, type MobBehaviour } from '@nerima-games/mx-gameplay'
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
  'compose:chunk-sync',
  'render:chunk-sync',
  'render:post-fx',
  'render:draw',
  'ui:hud-sync',
  'ui:overlay-sync',
]

// InputService and RedstoneWorldRuntime are built once into a Context, as
// platform-adapters.ts does, so the scope of the test owns them.
const makeInstances = Effect.gen(function* () {
  const instances: HostServiceInstances = {
    time: yield* makeTimeService(),
    player: yield* makePlayerService(),
    crops: yield* makeCropService(),
    inventory: yield* makeInventoryService(),
    vehicles: yield* makeVehicleService(),
    entities: yield* makeEntityManager<MobBehaviour>(),
    chunkStore: yield* makeChunkStore(generatedChunkSource(NoiseSeed(1)), ChunkCapacity(16)),
    inputContext: yield* Layer.build(InputServiceLayer()),
    redstoneContext: yield* Layer.build(RedstoneWorldRuntimeLayer),
  }
  return instances
})

const makeDeps = (instances: HostServiceInstances) =>
  Effect.gen(function* () {
    const chunkSyncStage: StageRegistration = {
      id: StageId('compose:chunk-sync'),
      after: [StageId('render:camera-mirror')],
      run: () => Effect.void,
    }
    const deps: HostModulesDeps = {
      services: makeHostServiceContext(instances),
      renderQuality: undefined,
      draw: NO_DRAW_TARGET,
      chunkSyncStage,
      uiFrameState: yield* makeUiFrameState,
      simState: yield* makeSimFrameState,
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
      expect(Context.get(services, InventoryService)).toBe(instances.inventory)
      expect(Context.get(services, VehicleService)).toBe(instances.vehicles)
      expect(Context.get(services, MobEntityManager)).toBe(instances.entities)
      expect(Context.get(services, ChunkStore)).toBe(instances.chunkStore)
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
})
