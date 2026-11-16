import { Context, Effect } from 'effect'
import { WorldWritePort, type QaNamespace, type SaveSliceRegistration } from '@nerima-games/mc-kernel'
import { renderModule, InputService, type DrawPort, type GraphicsQuality } from '@nerima-games/mc-render'
import {
  CropService,
  entityManagerTag,
  InventoryService,
  PlayerService,
  simStages,
  TimeService,
  VehicleService,
  type CropServiceApi,
  type EntityManager,
  type EntityManagerApi,
  type InventoryServiceApi,
  type PlayerServiceApi,
  type SimFrameState,
  type TimeServiceApi,
  type VehicleServiceApi,
} from '@nerima-games/mc-sim'
import {
  gameplayStages,
  type GameplayFrameState,
  type MobBehaviour,
  type VehicleControlInput,
} from '@nerima-games/mx-gameplay'
import { uiStages, type UiFrameState } from '@nerima-games/mx-ui'
import { redstoneModule, RedstoneWorldRuntime } from '@nerima-games/mx-redstone'
import { type MultiplayerHost } from '@nerima-games/mx-multiplayer'
import { ChunkStore, type ChunkStoreApi, type Dimension } from '@nerima-games/mc-worldgen'
import {
  EMPTY_MODULE_LAYER,
  registerModule,
  type GameModule,
  type StageRegistration,
} from '@nerima-games/mc-compose'
import { type PersistedLeverState } from './session-persistence'

/** mc-sim's EntityManager tag, typed for the host's mob behaviour. */
export const MobEntityManager: Context.Service<EntityManager, EntityManagerApi<MobBehaviour>> =
  entityManagerTag<MobBehaviour>()

/** Every service a registered module reads from its registration context. */
export type HostServices =
  | TimeService
  | PlayerService
  | CropService
  | InventoryService
  | VehicleService
  | EntityManager
  | ChunkStore
  | WorldWritePort
  | InputService
  | RedstoneWorldRuntime

/**
 * The service instances `main.ts` already owns. Every module registers against
 * one Context built from these, so sim, gameplay, render and redstone stages
 * reach the same instances the host reads and writes. The `layers` of
 * mc-sim, mc-render and mx-redstone build a new instance on every provide, so
 * no module Layer is built here.
 */
export type HostServiceInstances = {
  readonly time: TimeServiceApi
  readonly player: PlayerServiceApi
  readonly crops: CropServiceApi
  readonly inventory: InventoryServiceApi
  readonly vehicles: VehicleServiceApi
  readonly entities: EntityManagerApi<MobBehaviour>
  readonly chunkStore: ChunkStoreApi
  readonly worldWrite: WorldWritePort['Service']
  readonly inputContext: Context.Context<InputService>
  readonly redstoneContext: Context.Context<RedstoneWorldRuntime>
}

export const makeHostServiceContext = (instances: HostServiceInstances): Context.Context<HostServices> =>
  Context.mergeAll(
    instances.inputContext,
    instances.redstoneContext,
    Context.make(TimeService, instances.time),
    Context.make(PlayerService, instances.player),
    Context.make(CropService, instances.crops),
    Context.make(InventoryService, instances.inventory),
    Context.make(VehicleService, instances.vehicles),
    Context.make(MobEntityManager, instances.entities),
    Context.make(ChunkStore, instances.chunkStore),
    Context.make(WorldWritePort, instances.worldWrite),
  )

/**
 * The live state `main.ts` still owns (the mounted vehicle id, the current
 * vehicle controls, and the active dimension) crosses the boundary as closures
 * rather than snapshots, so a value reassigned later in the frame loop stays
 * visible to the stages registered here.
 */
export type HostModulesDeps = {
  readonly services: Context.Context<HostServices>
  readonly renderQuality: GraphicsQuality | undefined
  readonly draw: DrawPort
  readonly chunkSyncStage: StageRegistration
  readonly uiFrameState: UiFrameState
  readonly simState: SimFrameState
  readonly gameplayState: GameplayFrameState
  readonly isActiveDimension: (dimension: Dimension) => boolean
  readonly poweredRails: ReadonlySet<string>
  readonly leverKeyOf: (lever: Pick<PersistedLeverState, 'dimension' | 'position'>) => string
  readonly getMountedVehicleId: () => string | undefined
  readonly setMountedVehicleId: (id: string | undefined) => void
  readonly getVehicleControls: () => VehicleControlInput
  readonly multiplayer: { readonly host: MultiplayerHost } | undefined
}

/**
 * `gameplayStages`' commit services. The package root does not re-export the
 * type, so it is read from the public function's tenth parameter.
 */
export type GameplayCommitServices = NonNullable<Parameters<typeof gameplayStages>[9]>

/** A registered module whose stages were built from `HostServices`. */
export type HostGameModule = GameModule<
  never,
  unknown,
  never,
  QaNamespace,
  ReadonlyArray<SaveSliceRegistration>,
  HostServices
>

export const registerHostModules = (deps: HostModulesDeps): Effect.Effect<ReadonlyArray<HostGameModule>> => {
  const {
    services,
    renderQuality,
    draw,
    chunkSyncStage,
    uiFrameState,
    simState,
    gameplayState,
    isActiveDimension,
    poweredRails,
    leverKeyOf,
    getMountedVehicleId,
    setMountedVehicleId,
    getVehicleControls,
    multiplayer,
  } = deps

  // The host drives movement and jump intent itself, so the render factory
  // keeps its default `PlayerControlPort`; the camera mirror reads the shared
  // `PlayerService`.
  const render = registerModule({
    name: '@nerima-games/mc-render',
    layers: EMPTY_MODULE_LAYER,
    frameStages: renderModule(renderQuality, undefined, draw).frameStages,
  })

  const chunkSync = registerModule({
    name: '@nerima-games/mc-render/world-sync',
    layers: EMPTY_MODULE_LAYER,
    frameStages: Effect.succeed([chunkSyncStage]),
  })

  // `uiModule` allocates a UiFrameState the host cannot reach, so the UI stages
  // are built over the host's state. `uiModule` also adds a QA namespace whose
  // snapshot is always empty; the host registers none, as before.
  const ui = registerModule({
    name: '@nerima-games/mx-ui',
    layers: EMPTY_MODULE_LAYER,
    frameStages: Effect.succeed(uiStages(uiFrameState)),
  })

  // `redstoneModule` looks the runtime up with `serviceOption` and silently
  // falls back to private state when it is absent. Requiring the service first
  // turns a missing runtime into a type error instead.
  const redstone = registerModule({
    name: '@nerima-games/mx-redstone',
    layers: EMPTY_MODULE_LAYER,
    frameStages: Effect.gen(function* () {
      yield* RedstoneWorldRuntime
      return yield* redstoneModule.frameStages
    }),
  })

  // `simModule` and `gameplayModule` allocate frame state the host cannot reach
  // (`simState` and `gameplayState` are read and reset across main.ts), so these
  // two follow the factories' shape over the host-owned state.
  const sim = registerModule({
    name: '@nerima-games/mc-sim',
    layers: EMPTY_MODULE_LAYER,
    frameStages: Effect.gen(function* () {
      const time = yield* TimeService
      const player = yield* PlayerService
      const crops = yield* CropService
      return simStages(simState, time, player, crops)
    }),
  })

  const gameplay = registerModule({
    name: '@nerima-games/mx-gameplay',
    layers: EMPTY_MODULE_LAYER,
    frameStages: Effect.gen(function* () {
      const store = yield* ChunkStore
      const roster = yield* MobEntityManager
      const inventory = yield* InventoryService
      const player = yield* PlayerService
      const time = yield* TimeService
      const vehicles = yield* VehicleService
      return gameplayStages(
        gameplayState,
        store,
        roster,
        inventory,
        player,
        time,
        vehicles,
        {
          isActiveDimension,
          isPoweredRailAt: (dimension, position) => poweredRails.has(leverKeyOf({ dimension, position })),
          controlsForVehicle: (vehicle) =>
            String(vehicle.id) === getMountedVehicleId() ? getVehicleControls() : { throttle: 0, steering: 0 },
          onVehicleExit: (vehicle) => {
            if (String(vehicle.id) === getMountedVehicleId()) setMountedVehicleId(undefined)
          },
        },
        {
          // The host's pickup preserves metadata, durability and custom names
          // that the stage-level pickup does not; turning the stage pickup off
          // keeps the two from consuming the same inventory in one frame.
          droppedItemPickup: false,
          mobSimulation: multiplayer === undefined,
        },
      )
    }),
  })

  const multiplayerModules = multiplayer === undefined
    ? []
    : [registerModule({ name: '@nerima-games/mx-multiplayer', ...multiplayer.host.module })]

  return Effect.provide(
    Effect.all([render, chunkSync, ui, redstone, sim, gameplay, ...multiplayerModules]),
    services,
  )
}
