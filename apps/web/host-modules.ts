import { Context, Effect, Result } from 'effect'
import {
  WorldWritePort,
  type QaNamespace,
  type SaveSliceRegistration,
  type StageId,
  type StageRegistration,
} from '@nerima-games/mc-kernel'
import {
  renderModule,
  InputService,
  RENDER_STAGE_IDS,
  type ChunkSyncPort,
  type DrawPort,
  type GraphicsQuality,
} from '@nerima-games/mc-render'
import {
  entityManagerTag,
  makeCropService,
  PlayerService,
  simStages,
  TimeService,
  VehicleService,
  type EntityManager,
  type EntityManagerApi,
  type PlayerServiceApi,
  type SimFrameState,
  type TimeServiceApi,
  type VehicleServiceApi,
} from '@nerima-games/mc-sim'
import {
  GAMEPLAY_STAGE_IDS,
  gameplayStages,
  type GameplayBlockStateWorldApi,
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
  phaseOf,
  registerModule,
  STAGE_PHASE_INPUT,
  STAGE_PHASE_NETWORK_OUTBOUND,
  type GameModule,
  type StagePhase,
} from '@nerima-games/mc-compose'
import { type PersistedLeverState } from './session-persistence'

/** mc-sim's EntityManager tag, typed for the host's mob behaviour. */
export const MobEntityManager: Context.Service<EntityManager, EntityManagerApi<MobBehaviour>> =
  entityManagerTag<MobBehaviour>()

/** Every service a registered module reads from its registration context. */
export type HostServices =
  | TimeService
  | PlayerService
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
 *
 * `player` and `entities` are the owner-backed adapters
 * (`makeOwnerBackedStagePlayer`, `makeOwnerBackedEntityManager`), never the
 * in-memory services behind the host's views (I1). No registered module reads
 * an `InventoryService`, so none is provided.
 */
export type HostServiceInstances = {
  readonly time: TimeServiceApi
  readonly player: PlayerServiceApi
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
  readonly chunkSync: ChunkSyncPort
  readonly uiFrameState: UiFrameState
  readonly simState: SimFrameState
  readonly gameplayState: GameplayFrameState
  readonly gameplayCommit: GameplayCommitServices
  // Required: without it mx-gameplay refuses door and stair placement, records
  // crop-age projection as PortUnavailable, and never grows saplings.
  readonly gameplayBlockStateWorld: GameplayBlockStateWorldApi
  readonly isActiveDimension: (dimension: Dimension) => boolean
  readonly poweredRails: ReadonlySet<string>
  readonly leverKeyOf: (lever: Pick<PersistedLeverState, 'dimension' | 'position'>) => string
  readonly getMountedVehicleId: () => string | undefined
  readonly setMountedVehicleId: (id: string | undefined) => void
  readonly getVehicleControls: () => VehicleControlInput
  readonly multiplayer: { readonly host: MultiplayerHost } | undefined
  readonly isCreativeMode: boolean
}

/**
 * `gameplayStages`' commit services. The package root does not re-export the
 * type, so it is read from the public function's ninth parameter.
 */
export type GameplayCommitServices = NonNullable<Parameters<typeof gameplayStages>[8]>

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
    chunkSync,
    uiFrameState,
    simState,
    gameplayState,
    gameplayCommit,
    gameplayBlockStateWorld,
    isActiveDimension,
    poweredRails,
    leverKeyOf,
    getMountedVehicleId,
    setMountedVehicleId,
    getVehicleControls,
    multiplayer,
    isCreativeMode,
  } = deps

  // The host drives movement and jump intent itself, so the render factory
  // keeps its default `PlayerControlPort`; the camera mirror reads the shared
  // `PlayerService`. `chunkSync` is what mc-render's own `render:chunk-sync`
  // stage updates each frame.
  //
  // `render:input` is left out: the host frame reads the input service once and
  // ends that reading once (main.ts F2 and F7), and the canvas click handler
  // requests pointer lock. The stage would read and end the frame a second time.
  const render = registerModule({
    name: '@nerima-games/mc-render',
    layers: EMPTY_MODULE_LAYER,
    frameStages: Effect.map(
      renderModule(renderQuality, undefined, draw, undefined, chunkSync).frameStages,
      (stages) => stages.filter((stage) => stage.id !== RENDER_STAGE_IDS.input),
    ),
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
      // Only gameplay advances crop owners. This private empty service keeps
      // mc-sim's required crop tick from holding a second copy of their state.
      const crops = yield* makeCropService()
      return simStages(simState, time, player, crops)
    }),
  })

  const gameplay = registerModule({
    name: '@nerima-games/mx-gameplay',
    layers: EMPTY_MODULE_LAYER,
    frameStages: Effect.gen(function* () {
      const store = yield* ChunkStore
      const roster = yield* MobEntityManager
      const time = yield* TimeService
      const vehicles = yield* VehicleService
      // mx-gameplay 0.11.0 drops `_inventory` and `_player` without reading
      // them, so no inventory or player service needs to reach the stages here.
      const stages = gameplayStages(
        gameplayState,
        store,
        roster,
        undefined,
        undefined,
        time,
        {
          service: vehicles,
          environment: {
            isActiveDimension,
            isPoweredRailAt: (dimension, position) => poweredRails.has(leverKeyOf({ dimension, position })),
            controlsForVehicle: (vehicle) =>
              String(vehicle.id) === getMountedVehicleId() ? getVehicleControls() : { throttle: 0, steering: 0 },
            onVehicleExit: (vehicle) => {
              if (String(vehicle.id) === getMountedVehicleId()) setMountedVehicleId(undefined)
            },
          },
        },
        {
          // The host's pickup preserves metadata, durability and custom names
          // that the stage-level pickup does not; turning the stage pickup off
          // keeps the two from consuming the same inventory in one frame.
          droppedItemPickup: false,
          mobSimulation: multiplayer === undefined,
        },
        gameplayCommit,
        gameplayBlockStateWorld,
      )
      // The survival-hunger stage ticks the vitals owner on every frame and
      // has no option to stop. Hunger is local only in single-player survival:
      // in multiplayer the server's vitals overwrite the owner, and creative has
      // no hunger. Both are fixed before registration, so the stage keeps its
      // slot (`gameplay:entities` runs after it) with a run that does nothing.
      if (multiplayer === undefined && !isCreativeMode) return stages
      return stages.map((stage) =>
        stage.id === GAMEPLAY_STAGE_IDS.survivalHunger ? { ...stage, run: () => Effect.void } : stage)
    }),
  })

  const multiplayerModules = multiplayer === undefined
    ? []
    : [registerModule({ name: '@nerima-games/mx-multiplayer', ...multiplayer.host.module })]

  return Effect.provide(
    Effect.all([render, ui, redstone, sim, gameplay, ...multiplayerModules]),
    services,
  )
}

/**
 * The composed order split into the stages a fixed 20 Hz tick runs and the
 * stages a render frame runs. Each keeps its `plan.order` order.
 */
export type HostStageSplit = {
  readonly tickStages: ReadonlyArray<StageRegistration>
  readonly frameStages: ReadonlyArray<StageRegistration>
}

export type HostStageSplitError =
  | { readonly _tag: 'StageInInputPhase'; readonly stage: StageId }
  | { readonly _tag: 'TickStageAfterFrameStage'; readonly stage: StageId; readonly after: StageId }
  | { readonly _tag: 'StageNotRegisteredOnce'; readonly stage: StageId; readonly registrations: number }
  | { readonly _tag: 'SkeletonWithoutNetworkOutbound' }

/**
 * Frame stages are those whose phase comes after `network:outbound` in
 * `skeleton` (in the standard skeleton, camera mirror through HUD sync). A stage outside every
 * phase, such as `gameplay:block-state-rules` or a mod's stage, runs per tick:
 * presentation run per tick only draws late, but simulation run per frame
 * would advance the world once per frame.
 *
 * Startup fails closed on any of:
 * 1. a stage left in the input phase (the host reads input itself);
 * 2. a tick stage ordered `after` a frame stage, which the split would reverse;
 * 3. an id in `order` that is not registered exactly once, so it cannot land
 *    in exactly one of the two groups.
 * It also fails when `skeleton` has no `network:outbound` phase, because the
 * boundary would then be unknown.
 */
export const splitStages = (
  stages: ReadonlyArray<StageRegistration>,
  order: ReadonlyArray<StageId>,
  skeleton: ReadonlyArray<StagePhase>,
): Result.Result<HostStageSplit, HostStageSplitError> => {
  const boundary = skeleton.indexOf(STAGE_PHASE_NETWORK_OUTBOUND)
  if (boundary < 0) return Result.fail({ _tag: 'SkeletonWithoutNetworkOutbound' })
  const isFrameStage = (id: StageId): boolean => {
    const phase = phaseOf(skeleton, id)
    return phase !== undefined && skeleton.indexOf(phase) > boundary
  }
  const tickStages: Array<StageRegistration> = []
  const frameStages: Array<StageRegistration> = []
  for (const id of order) {
    const registered = stages.filter((stage) => stage.id === id)
    const [stage] = registered
    if (stage === undefined || registered.length !== 1) {
      return Result.fail({ _tag: 'StageNotRegisteredOnce', stage: id, registrations: registered.length })
    }
    if (phaseOf(skeleton, id) === STAGE_PHASE_INPUT) {
      return Result.fail({ _tag: 'StageInInputPhase', stage: id })
    }
    if (isFrameStage(id)) {
      frameStages.push(stage)
    } else {
      const after = stage.after?.find(isFrameStage)
      if (after !== undefined) return Result.fail({ _tag: 'TickStageAfterFrameStage', stage: id, after })
      tickStages.push(stage)
    }
  }
  return Result.succeed({ tickStages, frameStages })
}
