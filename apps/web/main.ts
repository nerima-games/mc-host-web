/**
 * The browser entry point. THE HOST.
 *
 * Current composition host boundary.
 *
 * ---------------------------------------------------------------------------
 * What this file is, under the prime directive
 * ---------------------------------------------------------------------------
 *
 * `index.ts` says the only code added to the published compose core is Layer
 * composition and the stage order table. This file is neither — it is the
 * HOST, the thing `docs/porting.md` §2 names and `domain/composition.ts` keeps
 * referring to as "the host has the type to discharge it". It is an application
 * entry point, so its runtime dependencies are checked as app code rather than
 * being part of the published core.
 *
 * So the rule this file lives under is not "no game rules" (it has none) but
 * "nothing here may be a rule some module should have owned". Concretely it
 * does five things:
 *
 *   1. builds the platform adapters (clock, browser input),
 *   2. registers each module, discharging what registration requires,
 *   3. calls `composeGame`,
 *   4. mounts the screens mx-ui hands back,
 *   5. drives `runFrameWith` from `requestAnimationFrame`.
 *
 * ---------------------------------------------------------------------------
 * COMPOSED MODULES AND THE REMAINING NETWORK BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * `mc-render`, `mx-ui`, `mx-redstone`, `mx-gameplay` and `mx-multiplayer` are
 * composed. Gameplay supplies its public production services, including the
 * generated chunk store shared with the renderer. The host constructs the
 * browser WebSocket transport and supplies it to the multiplayer module.
 *
 * ---------------------------------------------------------------------------
 * THERE IS A RENDERER NOW, AND THIS FILE STILL DOES NOT DRAW
 * ---------------------------------------------------------------------------
 *
 * This paragraph used to say "mc-render draws nothing yet", and
 * `docs/e2e-triage.md` #1 (`WebGL2 canvas is present and active`) was `fixme`
 * because of it. mc-render now has `application/world-renderer.ts`, and the
 * WebGL2 context on `#game-canvas` is created BY IT — `new WebGLRenderer({
 * canvas })`, inside mc-render, from mc-render's own transcribed parameters.
 *
 * What this file adds is item (1) of the five above and nothing else: `three`
 * is a PLATFORM LIBRARY, supplied here exactly as `window`, `document` and the
 * canvas already are. mc-render describes the seven constructors it needs as
 * structural types in `application/three-surface.ts` and imports `three`
 * nowhere; the host is the only place that can hold the real namespace, because
 * the host is the only place that knows it is in a browser.
 *
 * The line that would have been the violation is still not written. There is no
 * `canvas.getContext(...)` here, no scene, no geometry and no draw call — this
 * file cannot draw a triangle, and `domain/composition.ts` is why. Passing a
 * library to a module that decides what to do with it is wiring; deciding what
 * to draw is a rule, and rules belong to modules.
 *
 * ---------------------------------------------------------------------------
 * THERE IS A WORLD NOW. THIS PARAGRAPH USED TO SAY THE PICTURE WAS A BLUE FIELD
 * ---------------------------------------------------------------------------
 *
 * It read: "No chunk geometry reaches the renderer because no world reaches
 * this page", and it argued that mc-worldgen and mc-meshing COULD NOT be
 * resolved here, for the reason under "WHY THREE MODULES AND NOT SIX".
 *
 * HALF OF THAT WAS RIGHT AND THE HALF THAT WAS WRONG IS THE INTERESTING ONE.
 * The wall was real at the initial package pins: registering `gameplayModule`
 * needed a `ChunkStore`, an `EntityManager` and an `InventoryService`, while
 * the only implementations visible to this host were test doubles. That is
 * historical context now. The current public `mx-gameplay` API supplies the
 * production services used below. DRAWING TERRAIN NEVER NEEDED
 * `gameplayModule`; it needed chunk geometry, and geometry is data.
 *
 * The blocker was stated as a CATEGORY ("registering a module needs services")
 * over a set that included a case which registers nothing — the fourth time
 * this project has recorded that shape (§0.1 of the residual-work document
 * counts the others).
 *
 * WHAT IS ON THE SCREEN: a deterministic generated world, streamed around the
 * player through mx-gameplay's public world constructor. Gameplay collision,
 * block edits and mc-render meshing all observe the same mc-worldgen store;
 * dirty chunk notifications are the only render synchronization path.
 */
import { type Brand, Cause, Context, Effect, Exit, Layer, Option, Ref, Result, Schema, Scope } from 'effect'
import {
  AngleRadians,
  BLOCK_PROPERTY_DEFAULTS,
  BREWING_TIME_SECS,
  BlockAxis,
  BlockAddressSchema,
  BlockId,
  blockPosition,
  blockPositionKeyOf,
  blockTypeOfId,
  DeltaTimeSecs,
  DimensionIdSchema,
  InterpolationFraction,
  EntityIdSchema,
  SimulationTick,
  SimulationTickSchema,
  blockPositionOfPosition,
  chunkCoordOfBlock,
  isEmpty,
  PositionAxis,
  position as worldPosition,
  propertyOfBlockId,
  resolvedBlockOfId,
  WorldIdSchema,
  type BlockPosition,
  type BlockPositionKey,
  type ChunkCoord,
  type MonotonicTimeSecs,
  type Position as Vec3,
} from '@nerima-games/mc-kernel'
import {
  aabbOfCollisionShape,
  blockEnvironmentFromKernel,
  BlockLength,
  BlocksPerSecond,
  HalfHeight,
  type BlockIdAt,
} from '@nerima-games/mc-physics'
import {
  addExperience as addVitalsExperience,
  containerIdAt,
  ExperienceDelta,
  emptyPlayerStorage,
  itemStack,
  makeBrewingService,
  DomainEventBus,
  DomainEventBusLayer,
  EventSubscriberCapacitySchema,
  makeSimFrameState,
  makeTimeService,
  makeWeatherService,
  makeVehicleService,
  maxStackCountForItem,
  resetLandingImpact,
  OccupantId,
  WorldCommitCoordinator,
  EntityId as SimEntityId,
  type BrewingState,
  type ItemStack,
  type SimPhysicsConfig,
  type WeatherState,
  type Vehicle,
} from '@nerima-games/mc-sim'
import {
  InputService,
  attachChunkStoreRenderer,
  chunkKeyOf,
  makeChunkStoreLightColor,
  wrapHotbarSelection,
  type DrawPort,
} from '@nerima-games/mc-render'
import { BLOCK, type ChunkStoreRegistryApi } from '@nerima-games/mc-worldgen'
import { makeRedstoneContainerRuntime } from './redstone-container-runtime'
import { makeScreenshotRuntime } from './screenshot'
import { makeMusicRuntime } from './music-runtime'
import {
  activeDimensionChunkSync,
  budgetedRendererStore,
  drainChunkRenderFaults,
  makeChunkStreaming,
  showDimensionChunks,
  type DimensionChunkContext,
} from './chunk-streaming'
import {
  NETHER_PORTAL_BLOCK_ID,
  OBSIDIAN_BLOCK_ID,
} from './qa-fixtures'
import { trackChunkLightColor } from './render-lighting'
import {
  advancePlayerSwimmingRuntime,
  initialPlayerSwimmingRuntimeState,
} from './player-swimming-runtime'
import {
  createAnvilView,
  createChestStorageView,
  createEnchantingTableView,
  createCrosshairView,
  createFurnaceView,
  createHudView,
  createInventoryView,
  createLoadingStatus,
  createLoadingView,
  createSaveIndicator,
  IDLE_SAVE_STATUS,
  loadingScreenView,
  loadingStatus,
  makeUiFrameState,
  saveStatus,
  saveStatusMessage,
  UiMessageTextSchema,
  type LoadingStageProgress,
  type LoadingStatus,
  type LoadingView,
  type SaveState,
  type SaveStatus,
  type ChestStorageSlotTarget,
  type FurnaceSlotId,
  type InventoryInteractionTarget,
  type InventoryDragTarget,
  type EquipmentSlotId,
} from '@nerima-games/mx-ui'
import {
  advanceFishing,
  advanceMiningProgress,
  bowCharge,
  bowDamage,
  bowDamageWithEnchantments,
  canFireBow,
  cancelFishing,
  durabilityWearWithEnchantments,
  drainMeleeAttackResults,
  drainPortalTravels,
  drainPlayerDamages,
  drainPlayerHeals,
  drainVillagerTradeResults,
  EYE_LEVEL_OFFSET,
  fishingPhase,
  GAMEPLAY_BREWING_OWNER_ID,
  GAMEPLAY_CROPS_OWNER_ID,
  GAMEPLAY_DROPPED_ITEMS_OWNER_ID,
  GAMEPLAY_ENTITIES_OWNER_ID,
  GAMEPLAY_PLAYER_OWNER_ID,
  GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  GAMEPLAY_STATUS_EFFECTS_OWNER_ID,
  GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
  GAMEPLAY_VITALS_OWNER_ID,
  gameplayOwnerRegistrations,
  GameplayVillagerTradeSnapshotSchema,
  getPlayerMovementSpeedMultiplier,
  insertBrewingBottle,
  insertBrewingFuel,
  insertBrewingIngredient,
  INITIAL_ENVIRONMENTAL_CONTACT_DAMAGE_STATE,
  makeGameplayFrameStateForOwner,
  makeGeneratedWorld,
  isDroppedItemBehaviour,
  isHoeItem,
  isIgnitionItem,
  isPlaceableItem,
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  requestBlockBreak,
  requestFurnaceAdvance,
  requestMeleeAttack,
  requestPotatoHarvest,
  requestTargetedSoilTill,
  requestTargetedItemUse,
  requestVillagerTrade,
  resolveBowHits,
  resolveFallDamage,
  resolveTargetedPrimaryAttack,
  restoreStatusEffects,
  setPortalCandidates,
  solidityFromStore,
  spawnDroppedItems,
  snapshotStatusEffects,
  collectBrewingPotion,
  useBrewingPotion,
  miningLootContextForItem,
  type IgnitionItemType,
  type EnvironmentalContact,
  type HoeItemType,
  type ItemUseResult,
  type MobBehaviour,
  type MobDropEvent,
  type MiningProgressState,
  type PlaceableItemType,
  type VillagerTradeResult,
  type BrewingBottle,
  type BrewingIngredient,
  type FishingSession,
} from '@nerima-games/mx-gameplay'
import {
  encodeFrame,
  WorldId,
  type AuthoritativeEntityState,
} from '@nerima-games/mx-multiplayer'
import {
  AudioBackendPort,
  AudioEventId,
  AudioVolume,
  decodeMusicScenePlaylistManifest,
  MinecraftSoundNamespace,
  parseMinecraftSoundsJson,
} from '@nerima-games/mc-audio'
import { makeBrowserPreview } from './browser-preview.js'
import {
  advanceBowUse,
  IDLE_BOW_USE,
  type BowUseState,
} from './bow-use'
import { isDroppedItemPickupEligible } from './dropped-item-pickup'
import { droppedItemMetadataFromBehaviour } from './dropped-item-metadata'
import { createItemMetadataStore } from './item-metadata-store'
import {
  decodeProjectedEnchantedItem,
  projectEnchantedItem,
} from './enchanted-item-state'
import {
  advanceProjectileRuntime,
  initialProjectileRuntimeState,
  launchRuntimeProjectile,
  projectileRenderDescriptors,
  recoverProjectile,
} from './projectile-runtime'
import {
  advanceEyeOfEnderRuntime,
  eyeOfEnderRenderDescriptors,
  initialEyeOfEnderRuntimeState,
} from './eye-of-ender-runtime'
import {
  advanceWitherRuntime,
  damageRuntimeWither,
  initialSleepClientState,
  restoreWitherRuntime,
  type SleepClientState,
  snapshotWitherRuntime,
  witherRenderDescriptors,
} from '@nerima-games/mc-server/shared'
import {
  composeGame,
  EMPTY_MODULE_LAYER,
} from '@nerima-games/mc-compose'
import { BrowserClockLayer, browserClock } from './clock'
import { createDebugOverlayRuntime } from './debug-overlay-runtime'
import {
  connectMultiplayer,
  createMultiplayerClient,
  multiplayerRegistrationTokenKey,
  type DecodedVehicle,
  type MultiplayerClientContext,
} from './multiplayer-client'
import {
  horizontalListenerForward,
} from './audio-runtime'
import {
  EMPTY_BLOCK_BREAK_COUNTERS,
  observeBlockBreakCompletion,
  recordBlockBreakRequest,
  type BlockBreakCounters,
} from './mining-completion'
import {
  consumeNativeInput,
  EMPTY_NATIVE_INPUT_QUEUE,
  enqueueNativeMouseButton,
  type NativeInputQueueState,
} from './native-input-queue'
import { selectedHotbarAfterInput } from './player-experience'
import { createDroppedItemLifetimeTracker } from './dropped-item-lifetime'
import { createSessionSaveCoordinator, snapshotOwnedSessionState } from './session-save-coordinator'
import {
  advanceFootstepRuntime,
  initialFootstepRuntimeState,
} from './footstep-runtime'
import {
  initialSleepRuntimeState,
  leaveSleep,
  validRespawnLocation,
  type BedRespawnLocation,
} from './sleep-runtime'
import {
  DEFAULT_PLAYER_SETTINGS,
  PLAYER_BINDING_ACTIONS,
  initialPlayerSettingsWrites,
  playerSettingsWriteFailed,
  playerSettingsWriteSucceeded,
  queuePlayerSettingsWrite,
  savePlayerSettings,
  type PlayerSettingsV1,
} from './settings'
import { createSettingsView, PLAYER_SETTINGS_LOAD_FAILURE_MESSAGE } from './settings-view'
import { browserGamepadSource, makeHostGamepadInput } from './gamepad-input'
import {
  advanceTouchLook,
  consumeTouchLook,
  createTouchControlRoster,
  TOUCH_CONTROL_ACTIONS,
  TOUCH_LOOK_CONTROLLER_IDLE,
  type TouchControlAction,
} from './touch-input'
import {
  makeSessionChunkSource,
  saveSession,
  snapshotResidentChunks,
  type DimensionChunk,
  type PersistedFurnaceState,
  type PersistedLeverState,
  type PersistedPortalState,
  type PersistedEndPortalFrameState,
  type PersistedVillager,
  type SessionPosition,
  type SessionState,
} from './session-persistence'
import {
  gameplayOwnerInitialState,
  restoreInitialWorld,
  restoreLoadedSessionServices,
} from './session-restoration'
import { initializeSessionWorld } from './session-world'
import { makeOwnerBackedHost, type OwnerBackedOwnerIds } from './owner-backed-services'
import { makeFrameBoundary } from './frame-boundary-queue'
import {
  readSessionRoute,
  type SessionRoute,
} from './session-navigation'
import {
  RequestedSessionNotFoundError,
  makePlatformAdapters,
  type SettingsWriteQueue,
} from './platform-adapters'
import {
  makeHostServiceContext,
  registerHostModules,
  type GameplayCommitServices,
} from './host-modules'
import { makeHostWorldWrite } from './world-write-port'
import { makeHostGameplayBlockStateWorld } from './gameplay-block-state-world'
import {
  bootTitleMenu,
  installPlayerOnboarding,
  onboardingFailureMessage,
  playerControlHints,
  type OnboardingPersistenceFailure,
} from './title-menu'
import {
  handleLocalPlayerDeath as handleLocalPlayerDeathUi,
  installPlayerPauseMenu,
  renderCrosshair as renderCrosshairUi,
  renderPlayerHud,
  respawnPlayer as respawnPlayerUi,
} from './player-ui-h4a'
import { createPlayerUiRuntime, type PlayerUiRuntimeContext } from './player-ui-runtime'
import {
  createPlayerFramePreparation,
  createPlayerSessionRuntime,
  installPlayerLifecycle,
  installPlayerQaSurface,
} from './player-session-runtime'
import { runTickFrameInput } from './tick/frame-input'
import { mutableState, type H5aTickContext } from './tick/h5a-context'
import { runTickPlayerMovement } from './tick/player-movement'
import type { H5bPostFrameContext } from './tick/h5b-context'
import { runTickPostFrame } from './tick/post-frame'
import type { H5cTickContext } from './tick/h5c-context'
import { runFramePresentation, runTickPostFrameGameplay } from './tick/post-frame-gameplay'

/**
 * plan.md §3.4's measured clamp, applied by the DELTA'S PRODUCER.
 *
 * `@nerima-games/mc-kernel` contract is explicit that this is not part of the
 * `DeltaTimeSecs` brand and is not applied by mc-compose: "It is a simulation
 * invariant belonging to whoever produces the delta". The host produces it, so
 * the host clamps it — and without the clamp a backgrounded tab returns for its
 * first frame with a delta of several seconds, which every integrator in the
 * roster would step straight through a wall.
 */
const FIRST_FRAME_SECS = 0.016
const MIN_FRAME_SECS = 0.001
const MAX_FRAME_SECS = 0.05

const clampDelta = (raw: number): DeltaTimeSecs =>
  DeltaTimeSecs(Math.min(Math.max(MIN_FRAME_SECS, raw), MAX_FRAME_SECS))

/** How often the FPS readout is recomputed. Long enough to be a rate, short enough to watch. */

/**
 * How fast the player walks, jumps and turns.
 *
 * These are host-side browser tuning values. mc-sim owns the simulation
 * contract and accepts this physics configuration; keeping the values here
 * makes this product composition's tuning explicit.
 */
const WALK_SPEED_M_PER_S = 4.3
/**
 * Jump take-off speed, m/s.
 *
 * Was 8.4 (`0.42 blocks/tick x 20 ticks/s`, vanilla Java's own tick-rate
 * conversion) until it was measured against gravity and found to send an
 * ordinary jump 3.5+ blocks into the air — real enough to trigger this
 * package's `ceil(fallDistance - 3)` fall-damage rule on every single jump.
 *
 * That is not a fall-damage bug; it is this constant. `@nerima-games/mc-physics`'s
 * `GRAVITY_Y = -9.82` is independently CITED to the reference implementation's
 * own source (`docs/public-api.md`'s constants table: `packages/game/
 * application/game-state-support.ts:10`, wired at `game-state-service.ts:104`),
 * and that doc quotes the reference's own integrator
 * (`physics-world-service.ts:39-54`) verbatim: a continuous, per-second,
 * semi-implicit-Euler stepper — `velocity.y += gravityY * deltaTime` — not
 * Minecraft Java's discrete 20-tick/`0.08 blocks/tick^2` model. The old 8.4 was
 * derived FROM that discrete tick model and never re-validated against the
 * continuous one actually running here, which is why combining a
 * correctly-cited gravity with an uncited jump speed produced an apex three
 * times too high. `8.4` has no citation anywhere in this repo's history, in
 * mc-sim's, or in mc-physics's — grepped across all three for `JUMP_SPEED`,
 * `jumpVelocity`, `0.42` and the reference paths above.
 *
 * `5.0` is chosen to reproduce the vanilla-standard ~1.25-block jump height
 * under the verified -9.82 gravity: simulated directly against
 * `@nerima-games/mc-physics`'s own `integrateBody` (not the idealized
 * no-drag parabola formula) across delta times from 60fps down to the
 * MAX_DELTA_SECS=0.05 floor, apex lands at 1.15-1.23 blocks — comfortably
 * clear of the safe-fall threshold with margin for terrain and frame-timing
 * variance, and not a number invented from scratch: it is what recovers the
 * genre's well-known jump feel once gravity is taken as given. It is still
 * PROVISIONAL: no file in this org's accessible repos cites the reference
 * implementation's own jump-velocity constant the way GRAVITY_Y is cited, so
 * this value should be superseded the moment that citation surfaces.
 */
const JUMP_SPEED_M_PER_S = 5.0
/**
 * Sprint horizontal speed, m/s.
 *
 * `@nerima-games/mc-physics` already prices sprint in its own
 * `MovementConfig`/`applyMovementInput` (`sprintMultiplier`, gated on
 * `forward > 0`, the same gate this file applies below) — but
 * `@nerima-games/mc-sim`'s stage never calls that function; its stage
 * hand-rolls movement straight off `SimPhysicsConfig.walkSpeed`
 * (`mc-sim/dist/stages/registration.js`: `vx = ... * config.walkSpeed`), and
 * that config has no sprint field at all. So sprint has to be applied here,
 * at the host, the same way an active Speed status effect already is (see
 * `getPlayerMovementSpeedMultiplier` below): by substituting the effective
 * walkSpeed sent into `SimPhysicsConfig` for the frame.
 *
 * The value is not invented. `@nerima-games/mc-physics`'s own
 * `test/resolve.test.ts` names its `REFERENCE_TOP_SPEED` as "the fastest the
 * reference's player ever moves horizontally: a sprint (5.612) times the
 * sprint-jump multiplier (1.2)", citing
 * `packages/entity/application/movement-service.ts:25-32` in the reference
 * implementation. 5.612 is the plain-sprint half of that product; the extra
 * 1.2x sprint-jump boost is a separate mechanic this change does not add.
 */
const SPRINT_SPEED_M_PER_S = 5.612
/**
 * How tall an obstacle the player climbs by walking into it, no jump needed.
 *
 * mc-physics resolves X/Z/Y sequentially, so ANY vertical overlap between the
 * player's box and a block's collision box blocks horizontal movement on that
 * axis, however thin the box is — a 1/16-tall plate reads as just as much of
 * a wall as a full cube unless the host arms step-up (`tryStepUp`,
 * resolve-support.ts). That mechanism defaults to off (stepHeight 0); mc-
 * physics's own test suite names both the mechanism and this exact value as
 * the authority: `resolve.test.ts`'s "with no step height injected, the same
 * slab is a wall" states outright that the value is mc-sim's — i.e. the
 * host's — to arm, the same way WALK_SPEED_M_PER_S above is, and 0.6 is what
 * that suite uses throughout as the vanilla-accurate reference. A full block
 * is still 1.0 tall, well past this, so ordinary one-block terrain steps
 * still require a jump, unchanged.
 */
const PLAYER_STEP_HEIGHT_M = 0.6
const LOOK_SENSITIVITY = 0.0022
const WORLD_SEED = 20260728
const AUTOSAVE_INTERVAL_MS = 5_000
const SAVE_DEBOUNCE_MS = 500
const CRAFTING_STALE_RETRY_LIMIT = 4

const EQUIPMENT_ONLY_ITEM_TYPES = [
  'iron_helmet',
  'iron_chestplate',
  'iron_leggings',
  'iron_boots',
] as const satisfies ReadonlyArray<ItemStack['item']>

type EquipmentOnlyItemType = (typeof EQUIPMENT_ONLY_ITEM_TYPES)[number]

type SwordItem =
  | 'wooden_sword'
  | 'stone_sword'
  | 'iron_sword'
  | 'diamond_sword'

const SWORD_ITEM_NAMES: ReadonlySet<string> = new Set<SwordItem>([
  'wooden_sword',
  'stone_sword',
  'iron_sword',
  'diamond_sword',
])

const isSwordItem = (item: ItemStack['item']): item is SwordItem =>
  SWORD_ITEM_NAMES.has(item)

type GameplayUseItemType = Exclude<ItemStack['item'], EquipmentOnlyItemType>
type LegacyGameplayItemType = Exclude<ItemStack['item'], 'arrow' | 'bow'>
type GameplayItemType = Parameters<typeof isPlaceableItem>[0]
type GameplayHoeItemType = Parameters<typeof requestTargetedSoilTill>[4]
type GameplayIgnitionItemType = Parameters<typeof requestTargetedItemUse>[4]

const isGameplayHoeItem = (item: ItemStack['item']): item is GameplayHoeItemType =>
  isHoeItem(item)

const isGameplayIgnitionItem = (
  item: ItemStack['item'],
): item is GameplayIgnitionItemType => isIgnitionItem(item)

const EQUIPMENT_ONLY_ITEM_NAMES: ReadonlySet<string> = new Set(EQUIPMENT_ONLY_ITEM_TYPES)

const isGameplayUseItemType = (item: ItemStack['item']): item is GameplayUseItemType =>
  !EQUIPMENT_ONLY_ITEM_NAMES.has(item)

const isLegacyGameplayItemType = (item: ItemStack['item']): item is LegacyGameplayItemType =>
  item !== 'arrow' && item !== 'bow'

const isPlaceableGameplayItem = (item: ItemStack['item']): item is PlaceableItemType =>
  isGameplayUseItemType(item) &&
  isLegacyGameplayItemType(item) &&
  isPlaceableItem(item)

type InventoryMode = 'player' | 'craftingTable' | 'furnace' | 'chest' | 'anvil' | 'enchanting'

const INVENTORY_PRESENTATIONS = {
  player: { label: 'Inventory', width: 2, height: 2 },
  craftingTable: { label: 'Crafting Table', width: 3, height: 3 },
  furnace: { label: 'Furnace', width: 0, height: 0 },
  chest: { label: 'Chest', width: 0, height: 0 },
  anvil: { label: 'Anvil', width: 0, height: 0 },
  enchanting: { label: 'Enchanting Table', width: 0, height: 0 },
} as const

const enqueueSettingsWrite = (
  queue: SettingsWriteQueue,
  write: () => Promise<void>,
  onSuccess: () => void,
  onFailure: (error: unknown) => void,
): void => {
  queue.tail = queue.tail
    .then(write)
    .then(() => {
      queue.failure = undefined
      onSuccess()
    })
    .catch((error: unknown) => {
      queue.failure = { error }
      onFailure(error)
    })
}

const drainSettingsWrites = async (queue: SettingsWriteQueue): Promise<void> => {
  await queue.tail
  if (queue.failure !== undefined) throw queue.failure.error
}

const requireElement = (id: string): HTMLElement => {
  const element = document.getElementById(id)
  if (element === null) {
    throw new Error(`index.html is missing #${id}`)
  }
  return element
}

/**
 * The same, narrowed to a canvas.
 *
 * `instanceof` and not a cast. `makeWorldRenderer` is generic in the canvas
 * type — mc-render cannot name `HTMLCanvasElement` — so THIS call site is where
 * the real type is supplied and where a `<div id="game-canvas">` would
 * otherwise sail through into `new WebGLRenderer` and fail somewhere inside
 * three with a message about a null context.
 */
const requireCanvas = (id: string): HTMLCanvasElement => {
  const element = requireElement(id)
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error(`#${id} is a ${element.tagName}, not a <canvas>`)
  }
  return element
}

/**
 * Report a boot failure where BOTH a human and Playwright can see it.
 *
 * `data-mc-compose-boot` is the machine-readable half. docs/e2e-triage.md #3
 * and #7 ask "no fatal startup errors", and a page that failed to boot silently
 * looks exactly like a page that booted and drew nothing — which is precisely
 * the confusion a smoke test exists to remove.
 */
let sessionLoading: { readonly view: LoadingView; status: LoadingStatus } | undefined
const reportLoading = (progress: LoadingStageProgress): void => {
  if (sessionLoading === undefined) return
  const next = createLoadingStatus(progress, sessionLoading.status.startedAtSecs)
  if (Result.isFailure(next)) {
    console.error('[mc-compose] invalid loading progress', next.failure)
    return
  }
  sessionLoading.status = next.success
  sessionLoading.view.render(loadingScreenView(next.success, Effect.runSync(browserClock.monotonicSecs)))
}

const failBoot = (reason: string, detail?: unknown): void => {
  // UiMessageTextSchema is an unchecked string brand, so decoding a string cannot fail.
  reportLoading({ kind: 'failed', reason: Result.getOrThrow(Schema.decodeUnknownResult(UiMessageTextSchema)(reason)) })
  document.body.setAttribute('data-mc-compose-boot', 'failed')
  const banner = requireElement('boot-status')
  banner.textContent = `boot failed: ${reason}`
  banner.setAttribute('data-boot-error', reason)
  console.error(`[mc-compose] boot failed: ${reason}`, detail)
}

const bootTitle = async (): Promise<void> => bootTitleMenu({
  document,
  window,
  indexedDB,
  crypto,
  requireElement,
  enqueueSettingsWrite,
  drainSettingsWrites,
  multiplayerRegistrationTokenKey,
  hot: (import.meta as ImportMeta & {
    readonly hot?: { readonly dispose: (handler: () => void) => void }
  }).hot,
})

const bootGame = async (
  route: SessionRoute,
): Promise<void> => {
  const gameplayScope = Effect.runSync(Scope.make())
  let bootOwnsGameplayScope = true
  try {
  const { sessionId } = route
  const gameShell = requireElement('game-shell')
  const pauseRoot = requireElement('pause-root')
  const sessionOnboarding = requireElement('session-onboarding')
  const settingsRoot = requireElement('settings-root')
  gameShell.hidden = false
  document.body.setAttribute('data-mc-compose-route', 'session')
  // The minimum visible time is measured from here, when the screen appears.
  sessionLoading = {
    view: createLoadingView(document, requireElement('loading-root')),
    status: loadingStatus({ kind: 'preparing' }, Effect.runSync(browserClock.monotonicSecs)),
  }
  reportLoading({ kind: 'preparing', stage: 'reading', progress: 0 })
  document.body.setAttribute('data-session-id', sessionId)
  const canvas = requireCanvas('game-canvas')
  // Starting the download is all the browser lets the page observe; it cannot
  // confirm the file reached the disk. A throw here becomes the capture's
  // ScreenshotSaveFailure.
  const screenshots = makeScreenshotRuntime({
    canvas,
    save: (blob, filename) => {
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = filename
      link.hidden = true
      document.body.append(link)
      try {
        link.click()
      } finally {
        link.remove()
        // Revoking in the click's own task can cancel the download it started.
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
      }
    },
  })
  const handleScreenshotKey = (event: KeyboardEvent): void => {
    if (event.code !== 'F2' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    const requested = screenshots.request(new Date())
    if (Result.isFailure(requested)) console.error('Screenshot request rejected', requested.failure)
  }
  canvas.addEventListener('keydown', handleScreenshotKey)
  const hudParent = requireElement('hud-root')
  const saveIndicator = createSaveIndicator(document, requireElement('save-indicator-root'))
  let saveIndicatorStatus: SaveStatus = IDLE_SAVE_STATUS
  const enterSaveState = (state: SaveState): void => {
    saveIndicatorStatus = saveStatus(state, Effect.runSync(browserClock.monotonicSecs))
    saveIndicator.render(saveStatusMessage(saveIndicatorStatus, saveIndicatorStatus.sinceSecs))
  }
  const captionsParent = requireElement('sound-captions')
  const inventoryParent = requireElement('inventory-root')
  const tradeParent = requireElement('trade-root')
  const brewingParent = requireElement('brewing-root')
  const touchControlsParent = requireElement('touch-controls')
  const touchLookSurface = requireElement('touch-look-surface')
  const fpsValue = requireElement('fps-value')
  const multiplayerStatus = requireElement('multiplayer-status')
  const multiplayerChat = requireElement('multiplayer-chat')
  const multiplayerChatLog = requireElement('multiplayer-chat-log')
  const multiplayerChatForm = requireElement('multiplayer-chat-form')
  const multiplayerChatInput = requireElement('multiplayer-chat-input')
  if (!(multiplayerStatus instanceof HTMLOutputElement)
    || !(multiplayerChat instanceof HTMLElement)
    || !(multiplayerChatLog instanceof HTMLOListElement)
    || !(multiplayerChatForm instanceof HTMLFormElement)
    || !(multiplayerChatInput instanceof HTMLInputElement)) {
    throw new Error('index.html has invalid multiplayer game controls')
  }
  fpsValue.setAttribute('data-fps-source', 'mx-ui-frame-dt')
  const stageList = requireElement('stage-order')
  let inventoryOpen = false
  let tradeOpen = false
  let brewingOpen = false
  let brewingStatus = ''
  let activeVillagerId: string | undefined
  let tradeStatus = ''
  let nextVillagerTradeRequestId = 0
  let inventoryMode: InventoryMode = 'player'
  let enchantmentSeed = WORLD_SEED
  const {
    customNames,
    enchantedItems,
    droppedItemMetadata,
    droppedItemMetadataKey,
    equipmentMetadataKey,
    containerMetadataKey,
    containerMetadataLocation,
    sameItemMetadata,
    copyItemMetadata,
    deleteItemMetadata,
    deleteContainerMetadata,
    moveItemMetadata,
  } = createItemMetadataStore()
  const droppedItemLifetime = createDroppedItemLifetimeTracker()
  let respawnLocation: BedRespawnLocation | null = null
  let sleepRuntimeState = initialSleepRuntimeState()
  let anvilName = ''
  let anvilStatus = ''
  let enchantingStatus = ''
  let paused = false

  const touchControlTargets = Object.fromEntries(TOUCH_CONTROL_ACTIONS.map((action) => {
    const target = gameShell.querySelector<HTMLElement>(`[data-touch-action="${action}"]`)
    if (target === null) throw new Error(`Missing touch control: ${action}`)
    return [action, target]
  })) as Record<TouchControlAction, HTMLElement>
  const touchControls = createTouchControlRoster(touchControlTargets)
  const touchAvailable = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  let touchLookState = TOUCH_LOOK_CONTROLLER_IDLE

  const contactFrom = (touch: Touch) => ({
    identifier: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
  })
  const matchingLookContact = (event: TouchEvent): Touch | undefined =>
    Array.from(event.changedTouches).find(
      (touch) => touch.identifier === touchLookState.activeIdentifier,
    )

  touchLookSurface.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches.item(0)
    if (touch === null) return
    event.preventDefault()
    touchLookState = advanceTouchLook(touchLookState, 'start', contactFrom(touch))
  }, { passive: false })
  touchLookSurface.addEventListener('touchmove', (event) => {
    const touch = matchingLookContact(event)
    if (touch === undefined) return
    event.preventDefault()
    touchLookState = advanceTouchLook(touchLookState, 'move', contactFrom(touch))
  }, { passive: false })
  touchLookSurface.addEventListener('touchend', (event) => {
    const touch = matchingLookContact(event)
    if (touch === undefined) return
    event.preventDefault()
    touchLookState = advanceTouchLook(touchLookState, 'end', contactFrom(touch))
  }, { passive: false })
  touchLookSurface.addEventListener('touchcancel', (event) => {
    const touch = matchingLookContact(event)
    if (touch === undefined) return
    event.preventDefault()
    touchLookState = advanceTouchLook(touchLookState, 'cancel', contactFrom(touch))
  }, { passive: false })

  // -------------------------------------------------------------------------
  // 1. Platform adapters
  // -------------------------------------------------------------------------
  //
  // Storage, audio, input, redstone, and renderer are constructed in
  // `./platform-adapters` and returned as one typed struct. The two closures
  // keep the adapters' pointer-lock / modal predicates reading this host's
  // live UI state instead of a stale copy of it.
  const adapters = await makePlatformAdapters({
    route,
    canvas,
    touchControls,
    allowsPointerLock: () => !inventoryOpen && !tradeOpen && !brewingOpen && !paused,
    uiModalOpen: () => inventoryOpen || tradeOpen || brewingOpen,
  })
  const {
    storageContext,
    runStorage,
    settingsWrites,
    audio,
    endAudio,
    weatherAudio,
    queueEndAudio,
    placementAudio,
    loadedSession,
    sessionMetadata,
    isCreativeMode,
    initialDimension,
    inputContext,
    redstoneRuntime,
    atlasTexture,
    softwareRenderer,
    worldRenderer,
  } = adapters
  reportLoading({ kind: 'preparing', stage: 'generation', progress: 0.25 })
  let playerSettingsWrites = initialPlayerSettingsWrites(adapters.playerSettings)
  const onboardingParent = document.createElement('div')
  const onboardingStatus = document.createElement('p')
  onboardingStatus.setAttribute('role', 'status')
  sessionOnboarding.append(onboardingParent, onboardingStatus)
  const reportOnboardingFailure = (failure: OnboardingPersistenceFailure): void => {
    onboardingStatus.textContent = onboardingFailureMessage(failure)
    console.error('[mc-compose] controls persistence failed', failure)
  }
  const onboarding = installPlayerOnboarding({
    document,
    parent: onboardingParent,
    getStorage: () => window.localStorage,
    getQuickControls: () => playerControlHints(playerSettingsWrites.applied.bindings).quickControls,
    getAllControls: () => playerControlHints(playerSettingsWrites.applied.bindings).allControls,
    onFailure: reportOnboardingFailure,
  })
  if (Result.isFailure(onboarding)) {
    reportOnboardingFailure(onboarding.failure)
  } else {
    const controlsButton = document.createElement('button')
    controlsButton.setAttribute('type', 'button')
    controlsButton.setAttribute('data-session-action', 'show-controls')
    controlsButton.textContent = 'Controls'
    controlsButton.addEventListener('click', () => onboarding.success.showControls())
    sessionOnboarding.appendChild(controlsButton)
  }
  // mc-audio ships no production music playlist or ambient sound definition.
  // Until the host has those assets, the empty manifest and registry keep
  // music and ambient silent: mc-audio plays nothing for a scene without a
  // playlist and substitutes no default track.
  const musicAssets = Result.all({
    scenePlaylists: decodeMusicScenePlaylistManifest({}),
    ambientRegistry: parseMinecraftSoundsJson({}, { namespace: MinecraftSoundNamespace('minecraft') }),
  })
  if (Result.isFailure(musicAssets)) {
    failBoot('music asset decoding failed', musicAssets.failure)
    return
  }
  // Built on the same backend instance as `audio`, whose master gain already
  // applies masterVolume. MUSIC_VOLUME is the music-only level, which no
  // setting controls yet; passing masterVolume there would apply it twice.
  const music = Effect.runSync(Effect.provideService(
    makeMusicRuntime({ ...musicAssets.success, randomSource: Math.random }),
    AudioBackendPort,
    adapters.audioBackend,
  ))
  const MUSIC_VOLUME = AudioVolume(1)

  type Dimension = SessionState['dimension']

  // -------------------------------------------------------------------------
  // 2a. The generated world, shared by gameplay and rendering
  // -------------------------------------------------------------------------
  //
  // ONE CONSTRUCTION. The gameplay adapter and the renderer-facing worldgen
  // store returned here wrap the same store instance, so a mined block cannot
  // disappear from collision while remaining visible (or vice versa).
  const restoredWorkstations = Option.isSome(loadedSession)
    ? loadedSession.value.state.workstations
    : undefined
  const resolveMetadataStack = (key: string) => {
    if (!Option.isSome(loadedSession)) return undefined
    const storage = loadedSession.value.state.storage
    if (/^\d+$/.test(key)) {
      const slot = Number(key)
      const stack = storage.inventory.slots[slot]
      if (stack === undefined) return undefined
      return { stack, durability: storage.inventoryDurability[slot] ?? undefined }
    }
    if (key.startsWith('equipment:')) {
      const slot = key.slice('equipment:'.length)
      if (!(slot in storage.equipment.slots)) return undefined
      const item = storage.equipment.slots[slot as EquipmentSlotId]
      if (item === null || item === undefined) return undefined
      return { stack: item, durability: item.durability }
    }
    const location = containerMetadataLocation(key)
    if (location === undefined) return undefined
    const stack = loadedSession.value.state.containerStorage.containers
      .find((container) => container.id === location.containerId)
      ?.slots[location.slot]
    return stack === null || stack === undefined
      ? undefined
      : { stack, durability: stack.durability ?? undefined }
  }
  for (const [slot, name] of Object.entries(restoredWorkstations?.customNames ?? {})) {
    if (resolveMetadataStack(slot) === undefined) continue
    customNames.set(slot, name)
  }
  for (const [slot, encoded] of Object.entries(restoredWorkstations?.enchantedItems ?? {})) {
    const resolved = resolveMetadataStack(slot)
    if (resolved === undefined) continue
    const restored = decodeProjectedEnchantedItem(encoded, resolved.stack, resolved.durability)
    if (restored !== null) enchantedItems.set(slot, restored)
  }
  const restoredRespawn = restoredWorkstations?.respawn
  // The session stores plain coordinates; a respawn point needs finite
  // position axes and an integral bed cell, and a failed check fails the boot.
  const restoredRespawnLocation: Result.Result<BedRespawnLocation | null, Brand.BrandError> = restoredRespawn == null
    ? Result.succeed(null)
    : Result.gen(function* () {
        const position = worldPosition(
          yield* PositionAxis.result(restoredRespawn.position.x),
          yield* PositionAxis.result(restoredRespawn.position.y),
          yield* PositionAxis.result(restoredRespawn.position.z),
        )
        const bedPosition = blockPosition(
          yield* BlockAxis.result(Math.floor(position.x)),
          yield* BlockAxis.result(Math.floor(position.y) - 1),
          yield* BlockAxis.result(Math.floor(position.z)),
        )
        return { dimension: 'overworld', position, bedPosition }
      })
  if (Result.isFailure(restoredRespawnLocation)) {
    failBoot('respawn location decoding failed', restoredRespawnLocation.failure)
    return
  }
  respawnLocation = restoredRespawnLocation.success
  const sessionWorldResult = await initializeSessionWorld({
    loadedSession,
    initialDimension,
    worldSeed: WORLD_SEED,
    loadSavedChunks: (session, dimension, fallback) => runStorage(
      Effect.provide(makeSessionChunkSource(session, dimension, fallback), storageContext),
    ),
    makeWorld: ({ seed, chunkSource, dimension }) => Effect.runPromise(
      makeGeneratedWorld<MobBehaviour>({ seed, chunkSource, dimension }),
    ),
    restoreEntities: (targetWorld, roster) => Effect.runSync(
      targetWorld.entities.restore(roster as Parameters<typeof targetWorld.entities.restore>[0]),
    ),
    snapshotEntities: (targetWorld) => Effect.runSync(targetWorld.entities.snapshot),
    droppedItemLifetime,
    droppedItemMetadata,
    droppedItemMetadataKey,
    droppedItemMetadataFromBehaviour,
  })
  if (Result.isFailure(sessionWorldResult)) {
    failBoot('saved entity rosters could not be merged', sessionWorldResult.failure)
    return
  }
  const {
    activeSeed,
    initialKnownChunks,
    restored,
    world: generatedWorld,
    chunkSourceFor,
    entities: initialEntities,
    snapshotEntityRosters,
  } = sessionWorldResult.success
  enchantmentSeed = restoredWorkstations?.enchantmentSeed ?? activeSeed
  // Read before the owners exist: the generated spawn seeds a new session's
  // player owner and stays the respawn fallback.
  const initialSpawnPose = await Effect.runPromise(generatedWorld.player.pose)
  const initialSpawnDimension = await Effect.runPromise(generatedWorld.player.dimension)
  const loadedSessionState = Option.isSome(loadedSession) ? loadedSession.value.state : undefined
  const time = await Effect.runPromise(makeTimeService())
  const weather = await Effect.runPromise(makeWeatherService())
  // The owners are the only store of the player, its storage, vitals,
  // entities, villager trades and the brewing stand, so the loaded session (or
  // the generated world) seeds them here and nothing restores them later.
  const ownerInitialState = gameplayOwnerInitialState(
    loadedSessionState,
    {
      pose: initialSpawnPose,
      dimension: initialSpawnDimension,
      storage: await Effect.runPromise(generatedWorld.inventory.storageSnapshot),
      vitals: await Effect.runPromise(generatedWorld.vitals.snapshot),
    },
    initialEntities,
  )
  if (Result.isFailure(ownerInitialState)) {
    failBoot('saved player pose decoding failed', ownerInitialState.failure)
    return
  }
  const gameplayOwners = gameplayOwnerRegistrations(ownerInitialState.success)
  if (Result.isFailure(gameplayOwners)) {
    failBoot('gameplay owner registration failed', gameplayOwners.failure)
    return
  }
  // The one registry behind the coordinator's commits and gameplay's
  // block-state reads, so a state rule reads what its commit is checked against.
  const hostChunkStores: ChunkStoreRegistryApi = {
    // `getOrCreateDimensionChunkContext` is declared further down. This is
    // safe because mc-sim calls `forDimension` only on observe and commit, and
    // the gameplay block-state port only inside a frame stage, never while
    // either is being built.
    forDimension: (dimension) => getOrCreateDimensionChunkContext(dimension).chunkStore,
  }
  const hostWorldWriteExit = await Effect.runPromiseExit(
    Effect.flatMap(
      Schema.decodeEffect(WorldIdSchema)(sessionId),
      (worldId) => makeHostWorldWrite({
        world: worldId,
        owners: gameplayOwners.success,
        chunkStores: hostChunkStores,
      }),
    ),
  )
  if (Exit.isFailure(hostWorldWriteExit)) {
    failBoot('world commit coordinator creation failed', Cause.squash(hostWorldWriteExit.cause))
    return
  }
  const hostWorldWrite = hostWorldWriteExit.value
  const ownerIds: OwnerBackedOwnerIds = {
    player: GAMEPLAY_PLAYER_OWNER_ID,
    playerStorage: GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
    vitals: GAMEPLAY_VITALS_OWNER_ID,
    entities: GAMEPLAY_ENTITIES_OWNER_ID,
  }
  // From here on the generated world's player, inventory, vitals and entities
  // are reached only through these (I1): the views for host code, the stage
  // adapters for the registration Context.
  const ownerBacked = await Effect.runPromise(makeOwnerBackedHost({
    coordinator: hostWorldWrite.coordinator,
    world: generatedWorld,
    ownerIds,
  }))
  const world = {
    chunkStore: generatedWorld.chunkStore,
    worldgenChunkStore: generatedWorld.worldgenChunkStore,
    ...ownerBacked.views,
  }
  const debugMount = document.createElement('div')
  gameShell.appendChild(debugMount)
  const debugOverlay = createDebugOverlayRuntime(document, debugMount, Effect.gen(function* () {
    return {
      cameraPose: yield* world.player.cameraPose.pipe(Effect.provide(BrowserClockLayer)),
      dimension: (yield* world.player.snapshot).state.pose.feetPosition.dimension,
      worldTime: yield* time.snapshot,
      loadedChunkCount: (yield* worldRenderer.chunkKeys).length,
      gpuTimingSupported: undefined,
      latestGpuTimeMs: undefined,
      qualityPreset: undefined,
      biome: undefined,
      faultCount: undefined,
    }
  }))
  const unbindDebugOverlayKey = adapters.bindDebugOverlayToggle(() => { debugOverlay.toggle() })
  // Containers are not owner state, so they are still restored locally.
  await restoreInitialWorld(loadedSessionState, isCreativeMode, {
    restoreContainerStorage: (state) =>
      Effect.runPromise(world.inventory.restoreContainerStorage(state.containerStorage)),
    addCreativeStartingItems: async () => {
      await Effect.runPromise(world.inventory.add('redstone_dust', 16))
      await Effect.runPromise(world.inventory.add('lever', 4))
      await Effect.runPromise(world.inventory.add('redstone_lamp', 8))
      await Effect.runPromise(world.inventory.add('piston', 4))
    },
  })
  // A WorldWriteBatch names its dimension by the branded DimensionId. Every
  // host Dimension is a DimensionIdSchema input, so the three ids are decoded
  // once here and a decode failure stops the boot like any other.
  const dimensionIdsExit = await Effect.runPromiseExit(Effect.all({
    overworld: Schema.decodeEffect(DimensionIdSchema)('overworld'),
    nether: Schema.decodeEffect(DimensionIdSchema)('nether'),
    end: Schema.decodeEffect(DimensionIdSchema)('end'),
  }))
  if (Exit.isFailure(dimensionIdsExit)) {
    failBoot('dimension id decoding failed', Cause.squash(dimensionIdsExit.cause))
    return
  }
  const dimensionIds = dimensionIdsExit.value
  // The one host write path into the world: each call is one port batch, and
  // both revisions are read right before applyBatch. Callers submit unique
  // positions (the port rejects duplicates as WorldWriteInvalidBatch). A
  // WorldWriteConflict is returned, not retried: a retry would read the new
  // revisions and overwrite the write that caused the conflict.
  const writeBlocksThroughPort: PlayerUiRuntimeContext['writeBlocks'] = (dimension, edits) =>
    Effect.gen(function* () {
      const { coordinator, port } = hostWorldWrite
      yield* port.applyBatch({
        world: coordinator.worldId,
        expectedWorldRevision: yield* coordinator.revision,
        dimension: dimensionIds[dimension],
        expectedDimensionRevision: yield* coordinator.dimensionRevision(dimension),
        edits,
      })
    })
  const gameplayBrewingService = await Effect.runPromise(makeBrewingService(GAMEPLAY_BREWING_OWNER_ID))
  const gameplayEventContext = await Effect.runPromise(Layer.buildWithScope(
    DomainEventBusLayer(Schema.decodeUnknownSync(EventSubscriberCapacitySchema)(256)),
    gameplayScope,
  ))
  // The one set of commit services every reader of the gameplay owners shares.
  const gameplayCommit: GameplayCommitServices = {
    coordinator: hostWorldWrite.coordinator,
    playerOwnerId: GAMEPLAY_PLAYER_OWNER_ID,
    playerStorageOwnerId: GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
    cropOwnerId: GAMEPLAY_CROPS_OWNER_ID,
    droppedItemsOwnerId: GAMEPLAY_DROPPED_ITEMS_OWNER_ID,
    entitiesOwnerId: GAMEPLAY_ENTITIES_OWNER_ID,
    vitalsOwnerId: GAMEPLAY_VITALS_OWNER_ID,
    statusEffectsOwnerId: GAMEPLAY_STATUS_EFFECTS_OWNER_ID,
    villagerTradesOwnerId: GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
    brewingOwnerId: GAMEPLAY_BREWING_OWNER_ID,
    brewingService: gameplayBrewingService,
    eventBus: Context.get(gameplayEventContext, DomainEventBus),
  }
  // State reads and stateful edits (doors, stairs, crop ages, saplings) for
  // the gameplay stages, committed through the same coordinator.
  const gameplayBlockStateWorld = makeHostGameplayBlockStateWorld({
    coordinator: hostWorldWrite.coordinator,
    chunkStores: hostChunkStores,
    dimensionIds,
  })
  const snapshotGameplayVillagerTrades = gameplayCommit.coordinator
    .snapshot(GAMEPLAY_VILLAGER_TRADES_OWNER_ID, GameplayVillagerTradeSnapshotSchema)
    .pipe(Effect.map(({ state }) => state))
  const snapshotGameplayBrewing = gameplayBrewingService.snapshot
    .pipe(Effect.provideService(WorldCommitCoordinator, gameplayCommit.coordinator))
  // The survival-hunger stage ticks the vitals owner itself (I4); host code
  // reaches the same runtime through `gameplayState.survivalHunger`.
  const gameplayState = await Effect.runPromise(makeGameplayFrameStateForOwner({
    coordinator: hostWorldWrite.coordinator,
    vitalsOwnerId: GAMEPLAY_VITALS_OWNER_ID,
  }))
  const villagerResidents = new Map<string, PersistedVillager>(
    (Option.isSome(loadedSession) ? loadedSession.value.state.villagers.residents : [])
      .map((villager) => [villager.id, villager]),
  )
  await restoreLoadedSessionServices(loadedSessionState, {
    restoreTime: (state) => Effect.runPromise(time.restore(state.time)),
    restoreWeather: (state) => Effect.runPromise(weather.restore(state.weather)),
    // Also sets the frame state's movement and modifier caches, which seeding
    // the status-effects owner alone would leave at their defaults.
    restoreStatusEffects: (state) =>
      Effect.runPromise(restoreStatusEffects(gameplayState, state.statusEffects, gameplayCommit)),
    restoreEnderDragon: (state) =>
      Effect.runPromise(gameplayState.enderDragonEncounter.restore(state.end.dragon)),
  })
  const loadedEndState = Option.isSome(loadedSession) ? loadedSession.value.state.end : undefined
  const endPortalFrameKey = (position: SessionPosition): string =>
    `${String(position.x)},${String(position.y)},${String(position.z)}`
  const endPortalFrames = new Map<string, PersistedEndPortalFrameState>(
    (loadedEndState?.frames ?? []).map((frame) => [endPortalFrameKey(frame.position), frame]),
  )
  let endPortalComplete = loadedEndState?.portalComplete ?? false
  let exitPortalMaterialized = loadedEndState?.exitPortalMaterialized ?? false
  let dragonEggRewarded = loadedEndState?.dragonEggRewarded ?? false
  let witherRuntimeState = restoreWitherRuntime(
    Option.isSome(loadedSession) ? loadedSession.value.state.wither : undefined,
  )
  let witherRevision = 0
  let nextWitherCommand = 0
  let authoritativeEnderDragonSnapshot = Effect.runSync(gameplayState.enderDragonEncounter.snapshot)
  let enderDragonRevision = 0
  let nextEnderDragonCommand = 0
  const endDragonSnapshot = () => multiplayer === undefined
    ? Effect.runSync(gameplayState.enderDragonEncounter.snapshot)
    : authoritativeEnderDragonSnapshot
  const endDragonPosition = (): SessionPosition => {
    const dragon = endDragonSnapshot()
    const angle = dragon.phaseTimerSecs * (dragon.phase === 'charging' ? 1.4 : 0.35)
    const radius = dragon.phase === 'perching' ? 4 : dragon.phase === 'charging' ? 8 : 20
    return {
      x: Math.cos(angle) * radius,
      y: dragon.phase === 'perching' ? 68 : 76,
      z: Math.sin(angle) * radius,
    }
  }

  const presentWeather = (state: WeatherState): void => {
    canvas.setAttribute('data-weather', state.weather)
    canvas.setAttribute('data-weather-remaining-secs', String(state.remainingSecs))
  }
  presentWeather(Effect.runSync(weather.snapshot))

  const weatherDaylight = (timeOfDay: number): number =>
    Math.max(0.08, Math.sin(Math.PI * 2 * (timeOfDay - 0.25)))

  // The eye-level and thunder-fallback offsets are arithmetic on PositionAxis
  // values; the brand check rejects a non-finite sum, and that failure reaches
  // the frame-failure path through runTickPostFrameGameplay.
  const presentWeatherRuntime = (
    state: WeatherState,
    pose: { readonly feetPosition: Vec3 },
    nowSecs: MonotonicTimeSecs,
  ) => Effect.gen(function* () {
    const timeState = yield* time.snapshot
    const receivedLightning = authoritativeLightning !== undefined && authoritativeLightning.expiresAtSecs >= nowSecs
      ? authoritativeLightning
      : undefined
    const lightningSequence = receivedLightning?.sequence ?? (state.weather === 'thunder'
      ? Math.floor(timeState.ticks / (60 * 8))
      : undefined)
    const intensity = state.weather === 'clear' ? AudioVolume(0) : AudioVolume(1)
    const camera = worldPosition(
      pose.feetPosition.x,
      yield* Effect.fromResult(PositionAxis.result(pose.feetPosition.y + EYE_LEVEL_OFFSET)),
      pose.feetPosition.z,
    )
    const renderPlan = yield* worldRenderer.weather.frame({
      mode: state.weather,
      intensity,
      daylight: weatherDaylight(yield* time.timeOfDay),
      temperature: 1,
      seed: activeSeed,
      // The renderer plans sky, sun and fog from this every frame — see
      // application/world-renderer.ts's setEnvironment. currentChunkContext
      // is the same per-frame source alignActiveDimension keeps current for
      // chunk streaming and entity rosters; this is that value read for
      // render, not a second notion of where the player is.
      dimension: currentChunkContext.dimension,
      ...(lightningSequence === undefined ? {} : { lightningSequence }),
    }, camera)
    const thunder = lightningSequence === undefined
      ? undefined
      : {
          id: yield* Effect.fromResult(AudioEventId.result(`weather-thunder-${String(lightningSequence)}`)),
          occurredAtSecs: nowSecs,
          position: receivedLightning?.at ?? worldPosition(
            yield* Effect.fromResult(PositionAxis.result(camera.x + 24)),
            yield* Effect.fromResult(PositionAxis.result(camera.y + 12)),
            yield* Effect.fromResult(PositionAxis.result(camera.z + 12)),
          ),
        }
    weatherAudio.update({
      mode: state.weather,
      intensity,
      listener: camera,
      listenerForward: adapters.getReadAudioListenerForward(),
      occlusion: AudioVolume(0),
      ...(thunder === undefined ? {} : { thunder }),
    })
    canvas.setAttribute('data-weather-particles', String(renderPlan.particles.length))
    canvas.setAttribute('data-weather-lightning', String(renderPlan.lightningFlash > 0))
    canvas.setAttribute('data-weather-audio-mode', weatherAudio.state().mode)
  })

  const MAX_CHUNK_UPDATES_PER_FRAME = 4
  // One mc-render attachment per dimension ChunkStore; `dimensionContexts`
  // holds each context once, so no store is attached twice.
  const makeDimensionChunkContext = (
    dimension: Dimension,
    dimensionWorld: Pick<typeof generatedWorld, 'chunkStore' | 'worldgenChunkStore'>,
  ) => {
    const lighting = trackChunkLightColor((chunk, quads) =>
      makeChunkStoreLightColor(dimensionWorld.worldgenChunkStore, chunk, quads),
    )
    return Effect.gen(function* () {
      const budgeted = yield* budgetedRendererStore(dimensionWorld.worldgenChunkStore, MAX_CHUNK_UPDATES_PER_FRAME)
      const renderAttachment = yield* attachChunkStoreRenderer(
        worldRenderer,
        budgeted.store,
        { colorForChunk: lighting.colorForChunk },
      )
      const context: DimensionChunkContext = {
        dimension,
        chunkStore: dimensionWorld.chunkStore,
        worldgenChunkStore: dimensionWorld.worldgenChunkStore,
        renderAttachment,
        enqueueRenderUpdate: budgeted.enqueue,
        lightingSnapshot: lighting.snapshot,
        streamLoaded: new Set<string>(),
      }
      return context
    })
  }
  const dimensionContexts = new Map<Dimension, DimensionChunkContext>()
  const initialChunkContextExit = Effect.runSyncExit(makeDimensionChunkContext(initialDimension, world))
  if (Exit.isFailure(initialChunkContextExit)) {
    failBoot('chunk renderer attachment failed', Cause.squash(initialChunkContextExit.cause))
    return
  }
  const initialChunkContext = initialChunkContextExit.value
  dimensionContexts.set(initialDimension, initialChunkContext)
  let currentChunkContext = initialChunkContext
  // The host's redstone positions are plain {x,y,z}; the kernel's BlockPosition
  // brands each axis, so they need this conversion before a chunkStore read or write.
  // Callers pass block-cell coordinates, which are always integers.
  const asBlockPosition = (position: { readonly x: number; readonly y: number; readonly z: number }): BlockPosition =>
    blockPosition(BlockAxis(position.x), BlockAxis(position.y), BlockAxis(position.z))
  const leverKeyOf = (lever: Pick<PersistedLeverState, 'dimension' | 'position'>): string =>
    JSON.stringify([lever.dimension, lever.position.x, lever.position.y, lever.position.z])
  const leverStates = new Map<string, PersistedLeverState>(
    (Option.isSome(loadedSession) ? loadedSession.value.state.redstone.levers : [])
      .map((lever) => [leverKeyOf(lever), lever]),
  )
  const comparatorModes = new Map<string, 'compare' | 'subtract'>()
  const observerInputs = new Map<string, number>()
  const observerPulses = new Map<string, number>()
  const poweredRails = new Set<string>()
  // A plate's occupancy is a fact about entities, which mx-redstone deliberately
  // does not own (see @nerima-games/mx-redstone's domain/pressure-plate.ts) —
  // this host computes it from the player's AABB and hands the graph only the
  // `active` bit a lever's own player-driven flag would carry. Cached here
  // rather than recomputed inside syncRedstoneSnapshot because that scan only
  // runs when `redstoneDirty`, and the player walking onto a plate does not by
  // itself dirty anything; the per-frame check below is what notices the edge
  // and requests the resync.
  const pressurePlateOccupancy = new Map<string, {
    readonly dimension: Dimension
    readonly position: { readonly x: number; readonly y: number; readonly z: number }
    readonly occupied: boolean
  }>()
  // A drained lamp transition is a one-shot event; the QA surface needs a durable
  // record of it, not another live read of block state, because some pulses
  // (the observer's 2-tick / 0.2s window) are shorter than a single QA round trip.
  // `writtenBlock` is a read-after-write confirmation, kept separate from `lit`
  // so "the event fired" and "the write landed" stay two distinguishable claims.
  const redstoneLampTransitionLog = new Map<string, Array<{ readonly lit: boolean; readonly writtenBlock: BlockId | null }>>()
  const restoredVehicles = Option.isSome(loadedSession) ? loadedSession.value.state.vehicles ?? [] : []
  const vehicleNextSerial = restoredVehicles.reduce((nextSerial, vehicle) => {
    const match = /^v:(\d+)$/.exec(String(vehicle.id))
    return match === null ? nextSerial : Math.max(nextSerial, Number(match[1]) + 1)
  }, 0)
  const vehicleService = Effect.runSync(makeVehicleService({
    vehicles: restoredVehicles,
    nextSerial: vehicleNextSerial,
  }))
  const vehicleList = (): ReadonlyArray<Vehicle> => Effect.runSync(vehicleService.vehicles)
  const vehicleById = (id: string): Vehicle | undefined => vehicleList().find((vehicle) => String(vehicle.id) === id)
  const replaceVehicle = (vehicle: Vehicle): void => {
    Effect.runSync(vehicleService.updateState(vehicle.id, {
      dimension: vehicle.dimension,
      position: vehicle.position,
      velocity: vehicle.velocity,
      yawRadians: vehicle.yawRadians,
    }))
}
  const applyAuthoritativeVehicle = ({ entity, occupant }: DecodedVehicle): void => {
    const current = vehicleById(String(entity.entityId))
    if (current === undefined) return
    Effect.runSync(vehicleService.updateState(current.id, {
      dimension: current.dimension,
      // mx-multiplayer's Vec3 wire schema rejects non-finite axes at decodeFrame.
      position: { x: PositionAxis(entity.at.x), y: PositionAxis(entity.at.y), z: PositionAxis(entity.at.z) },
      velocity: current.velocity,
      yawRadians: current.yawRadians,
      occupant,
    }))
    if (entity.occupant === null && mountedVehicleId === String(current.id)) {
      mountedVehicleId = undefined
    }
    if (entity.occupant === multiplayer?.query.player) mountedVehicleId = String(current.id)
  }
  const localVehicleOccupant = OccupantId('local-player')
  let mountedVehicleId: string | undefined = Option.isSome(loadedSession)
    ? loadedSession.value.state.mountedVehicleId ?? undefined
    : undefined
  let vehicleControls = { throttle: 0, steering: 0 }
  let fishingSession: FishingSession | undefined
  let fishingWater: { readonly dimension: Dimension; readonly position: SessionPosition } | undefined
  let fishingResult = 'idle'
  let networkFishingState: { readonly phase: 'idle' | 'waiting' | 'bite' | 'escaped'; readonly result: string } = { phase: 'idle', result: 'idle' }
  let nextFishingRoll = 1
  let swimmingState = initialPlayerSwimmingRuntimeState()
  let footstepRuntimeState = initialFootstepRuntimeState()
  const furnaceKeyOf = (
    furnace: Pick<PersistedFurnaceState, 'dimension' | 'position'>,
  ): string => JSON.stringify([
    furnace.dimension,
    furnace.position.x,
    furnace.position.y,
    furnace.position.z,
  ])
  const furnaceStates = new Map<string, PersistedFurnaceState>(
    (Option.isSome(loadedSession) ? loadedSession.value.state.furnaces : [])
      .map((furnace) => [furnaceKeyOf(furnace), furnace]),
  )
  const portalKeyOf = (
    portal: Pick<PersistedPortalState, 'dimension' | 'position'>,
  ): string => JSON.stringify([
    portal.dimension,
    portal.position.x,
    portal.position.y,
    portal.position.z,
  ])
  const portalStates = new Map<string, PersistedPortalState>(
    (Option.isSome(loadedSession) ? loadedSession.value.state.portals : [])
      .map((portal) => [portalKeyOf(portal), portal]),
  )
  let activeFurnaceKey: string | undefined
  let activeChestId: string | undefined
  let redstoneDirty = true

  const getOrCreateDimensionChunkContext = (
    dimension: Dimension,
  ): DimensionChunkContext => {
    const existing = dimensionContexts.get(dimension)
    if (existing !== undefined) return existing
    const dimensionWorld = Effect.runSync(
      makeGeneratedWorld<MobBehaviour>({
        seed: activeSeed,
        chunkSource: chunkSourceFor(dimension),
        dimension,
      }),
    )
    const created = Effect.runSync(makeDimensionChunkContext(dimension, dimensionWorld))
    dimensionContexts.set(dimension, created)
    return created
  }

  // Gameplay stages keep one stable service reference while every operation is
  // dispatched to the currently active dimension's backing store.
  const currentChunkStore = new Proxy(world.chunkStore, {
    get: (_target, property) => Reflect.get(currentChunkContext.chunkStore, property),
  }) as typeof world.chunkStore

  let dirtyGeneration = 0
  let savedGeneration = 0
  let debounceTimer: number | undefined

  // Every world read or write from outside the frame fiber goes through this:
  // DOM handlers and QA operations are queued for the next frame boundary, and
  // work that cannot wait for a frame (saves, the hidden-tab pump) runs under
  // the frame lock. Queued writes have no typed failure; a throw in one is a
  // defect that stops the loop like any other frame defect.
  const frameBoundary = Effect.runSync(makeFrameBoundary<never>())
  const deferToFrameBoundary = (work: () => void): void => {
    frameBoundary.enqueue(Effect.sync(work))
  }
  const reportPersistenceFailure = (error: unknown): void => {
    document.body.setAttribute('data-session-persistence', 'failed')
    console.error('[mc-compose] session persistence failed', error)
  }
  const saveCoordinator = createSessionSaveCoordinator<SessionState>({
    initialKnownChunks,
    snapshotResidents: async () => {
      const residents = await Promise.all(
        [...dimensionContexts.values()].map(async (context) =>
          (await Effect.runPromise(snapshotResidentChunks(context.worldgenChunkStore))).map(
            (chunk): DimensionChunk => ({ dimension: context.dimension, chunk }),
          ),
        ),
      )
      return residents.flat()
    },
    currentGeneration: () => dirtyGeneration,
    // Taken under the frame lock, so it never reads the owners mid-frame.
    snapshotState: () => Effect.runPromise(frameBoundary.outsideFrame(Effect.gen(function* () {
      return {
        seed: activeSeed,
        ...yield* snapshotOwnedSessionState(hostWorldWrite.coordinator, ownerIds, snapshotEntityRosters),
        containerStorage: yield* world.inventory.containerStorageSnapshot,
        time: yield* time.snapshot,
        weather: yield* weather.snapshot,
        redstone: { levers: [...leverStates.values()] },
        furnaces: [...furnaceStates.values()],
        portals: [...portalStates.values()],
        villagers: {
          residents: [...villagerResidents.values()],
          trades: yield* snapshotGameplayVillagerTrades,
        },
        brewing: yield* snapshotGameplayBrewing,
        statusEffects: yield* snapshotStatusEffects(gameplayState, gameplayCommit),
        wither: snapshotWitherRuntime(witherRuntimeState),
        fishing: {
          result: fishingResult,
          phase: multiplayer === undefined ? (fishingSession === undefined ? 'idle' : fishingPhase(fishingSession)) : networkFishingState.phase,
          water: fishingWater ?? null,
        },
        // An unoccupied vehicle's `occupant` is `undefined` (see
        // vehicleById/boardVehicle call sites in this file), not an absent
        // key — object literals in this codebase set it explicitly rather
        // than omitting it. session-persistence.ts's PersistedVehiclesSchema
        // validates this array as Schema.Unknown, so nothing schema-side ever
        // strips that key the way this file's own exact:true optional fields
        // do; an explicit `undefined` reaching mc-save's integrity
        // canonicalizer is a hard encode failure there (see that file's
        // comment on PersistedVehiclesSchema for the same failure mode on a
        // different field). Stripped here, at the one place a Vehicle enters
        // the persisted snapshot, the same way vehicle-motion.ts's own
        // withoutOccupant already represents "no occupant" everywhere else.
        vehicles: vehicleList().map((vehicle) => {
          if (vehicle.occupant !== undefined) return vehicle
          const { occupant: _occupant, ...withoutOccupant } = vehicle
          return withoutOccupant
        }),
        mountedVehicleId: mountedVehicleId ?? null,
        end: {
          frames: [...endPortalFrames.values()],
          portalComplete: endPortalComplete,
          dragon: endDragonSnapshot(),
          exitPortalMaterialized,
          dragonEggRewarded,
        },
        workstations: {
          enchantmentSeed,
          customNames: Object.fromEntries(customNames),
          enchantedItems: Object.fromEntries(
            [...enchantedItems].map(([slot, item]) => [slot, JSON.stringify(item)]),
          ),
          // `SessionStateSchema`'s `deathDropDimension` is `optionalWith(...,
          // { exact: true })`: it requires the key to be OMITTED, not merely
          // `undefined`-valued, or mc-save's integrity checksum rejects the
          // encoded save (a present `undefined` key is not one of canonicalize's
          // supported value kinds). `deathDropDimension` here is `undefined`
          // whenever no death is pending, which is most saves, so this must be
          // conditional rather than a bare shorthand property.
          ...(deathDropDimension === undefined ? {} : { deathDropDimension }),
          respawn: respawnLocation,
        },
      }
    }))),
    publish: ({ state, chunks }) =>
      runStorage(
        Effect.provide(
          saveSession({
            sessionId,
            revision: crypto.randomUUID(),
            metadata: sessionMetadata,
            state,
            chunks,
          }),
          storageContext,
        ),
      ).then(() => undefined),
    onPublished: (publishedGeneration) => {
      savedGeneration = Math.max(savedGeneration, publishedGeneration)
    },
    onFailure: reportPersistenceFailure,
  })
  let markSessionDirty = (): void => {}
  const spawnPose = await Effect.runPromise(world.player.pose)
  canvas.setAttribute('data-world-source', restored === undefined ? 'generated' : 'persisted')
  canvas.setAttribute('data-world-seed', String(activeSeed))

  // STREAMING, keyed to where the player is — not a one-shot load at boot.
  //
  // A fixed radius bounds memory while still exercising both add and removal.
  //
  // Software-rasterizer-conditional, using the same `softwareRenderer` signal
  // as the render-quality fallback above.
  //
  // mc-worldgen 0.2.0 added a deepslate layer at depth, absent from the
  // pre-0.2.0 terrain this budget was originally calibrated against. Verified
  // by isolating mc-worldgen alone (pnpm-workspace.yaml override, everything
  // else held at the current pins): the same 25-chunk sample has nearly
  // identical exposed-face and air-pocket counts either version, but 0.2.0
  // splits the underground surface across two solid block ids (stone +
  // deepslate) plus more ore variety — 20 distinct block ids in the sample
  // versus 11 pre-0.2.0 — instead of one. Greedy meshing only merges runs of
  // the SAME block id, so the same exposed surface now meshes into roughly
  // 4x the indices at an unchanged face count — this is a merge-key
  // diversity problem, not a "SwiftShader draws more chunks" problem.
  //
  // Measured (real SwiftShader, unthrottled, this 25-chunk scene):
  //   radius 2: 153,426 indices/frame (25 chunks)
  //   radius 1:  70,842 indices/frame (9 chunks) — a 2.17x cut, not a full
  //     return to the pre-0.2.0 terrain's ~38,826 at radius 2; a residual
  //     gap remains and is not explained by this fix.
  // The software-rasterizer perf floor is 8 FPS
  // (e2e/performance-budget.e2e.ts's MINIMUM_AVERAGE_FPS). Real
  // hardware-accelerated players keep radius 2.
  const STREAM_RADIUS_CHUNKS = softwareRenderer ? 1 : 2
  canvas.setAttribute('data-stream-radius', String(STREAM_RADIUS_CHUNKS))
  let chunksStreamedIn = 0
  let chunksDropped = 0
  const { streamAround, retainDimensionResidents } = makeChunkStreaming({
    streamRadiusChunks: STREAM_RADIUS_CHUNKS,
    activeSeed,
    canvas,
    coordinator: hostWorldWrite.coordinator,
    villagerResidents,
    saveCoordinator,
    getMarkSessionDirty: () => markSessionDirty,
    markRedstoneDirty: () => { redstoneDirty = true },
    getChunksStreamedIn: () => chunksStreamedIn,
    setChunksStreamedIn: (count) => { chunksStreamedIn = count },
    getChunksDropped: () => chunksDropped,
    setChunksDropped: (count) => { chunksDropped = count },
  })

  const redstoneContainerRuntime = makeRedstoneContainerRuntime({
    dimensionContexts,
    world: { inventory: world.inventory, entities: ownerBacked.entityManager },
    writeBlocks: writeBlocksThroughPort,
    leverStates,
    comparatorModes,
    observerInputs,
    observerPulses,
    pressurePlateOccupancy,
    poweredRails,
    getSimulationElapsedSecs: () => simulationElapsedSecs,
    isMultiplayer: () => multiplayer !== undefined,
    setRedstoneDirty: (dirty) => { redstoneDirty = dirty },
    markSessionDirty,
    redstoneRuntime,
    customNames,
    enchantedItems,
    droppedItemMetadata,
    containerMetadataKey,
    copyItemMetadata,
    deleteItemMetadata,
    droppedItemMetadataKey,
    getFramesTotal: () => framesTotal,
    asBlockPosition,
    leverKeyOf,
  })
  const {
    syncRedstoneSnapshot,
    containerIdForStorageBlock,
    applyHopperTransfer,
    applyDispenserTrigger,
    applyDropperTrigger,
    applyPoweredPistonTransition,
  } = redstoneContainerRuntime

  reportLoading({ kind: 'preparing', stage: 'generation', progress: 0.5 })
  const initialStreamExit = await Effect.runPromiseExit(
    streamAround(currentChunkContext, spawnPose.feetPosition.x, spawnPose.feetPosition.z),
  )
  if (Exit.isFailure(initialStreamExit)) {
    failBoot('initial chunk streaming failed', Cause.squash(initialStreamExit.cause))
    return
  }
  reportLoading({ kind: 'preparing', stage: 'render-preparation', progress: 0.75 })

  const uiFrameState = Effect.runSync(makeUiFrameState)

  // -------------------------------------------------------------------------
  // 2c. gameplayModule, and the four services it requires
  // -------------------------------------------------------------------------
  //
  // `gameplayModule` is `GameModule<..., ChunkStore | EntityManager |
  // InventoryService | PlayerService>`. Until mx-gameplay shipped complete
  // in-memory implementations of all four, this file's own header recorded the
  // wall correctly: the only implementations in the organisation were
  // `test/support/*-double.ts`, none exported, and composing them would be
  // 「偽物のモジュールを4つ作って合成すれば、検証されるのは偽物である」.
  //
  // WHAT CHANGED IS NOT THAT RULE. Those four are now real services on
  // mx-gameplay's PUBLIC API — every member implemented, no `dieMessage`, and
  // mc-compose is allowed to import mx-gameplay. Nothing here reaches past it.
  //
  const playerApi = world.player
  adapters.setReadAudioListener(() => Effect.runSync(playerApi.pose).feetPosition)
  // The player's yaw is always finite: makeGeneratedWorld rejects a non-finite
  // spawn yaw, and mx-gameplay's player rejects one in `look` and `restore`
  // (saved poses), while `moveTo`, `setDimension` and `reset` keep or zero it.
  // A failure here is a broken invariant, not a recoverable input.
  adapters.setReadAudioListenerForward(() => horizontalListenerForward(
    Result.getOrThrow(AngleRadians.result(Effect.runSync(playerApi.pose).yawRadians)),
  ))
  const inputApi = Context.get(inputContext, InputService)
  const hostGamepad = makeHostGamepadInput(inputApi, browserGamepadSource(navigator))
  const applyBindings = (bindings: PlayerSettingsV1['bindings']): void => {
    for (const action of PLAYER_BINDING_ACTIONS) {
      Effect.runSync(inputApi.rebind(action, `PlayerSettingsTemporary:${action}`))
    }
    for (const action of PLAYER_BINDING_ACTIONS) {
      const code = bindings[action] ?? DEFAULT_PLAYER_SETTINGS.bindings[action]
      if (code === undefined) throw new Error(`Missing default binding for ${action}`)
      Effect.runSync(inputApi.rebind(action, code))
    }
  }
  const simState = await Effect.runPromise(makeSimFrameState)
  let environmentalContactDamageState = INITIAL_ENVIRONMENTAL_CONTACT_DAMAGE_STATE
  let simulationElapsedSecs = 0
  const isGameplayBlockSolid = solidityFromStore(currentChunkStore)
  // mc-physics 0.2.1 replaced ResolveOptions.isBlockSolid (a boolean predicate)
  // with blockPropertiesAt (the kernel's BlockProperties or null), and
  // resolve-shapes.ts reads exactly one field off it for collision,
  // `properties.collisionShape` — so returning the block's REAL resolved
  // properties (not a synthetic default) is what turns on per-shape collision
  // (cactus inset, slabs, the pressure-plate box) without touching mc-physics
  // itself. This must still keep solidityFromStore's three-valued semantics:
  // an unloaded chunk and out-of-world both read as SOLID (air there lets a
  // player walk off a chunk edge and fall forever — see mx-gameplay's
  // in-memory-world docstring), so both sentinel readings fall back to
  // BLOCK_PROPERTY_DEFAULTS, kernel's "ordinary opaque solid cube"
  // (collisionShape: 'full') — exactly the box the pre-migration code used
  // for every solid cell. A loaded, non-air block resolves to its own
  // registry row via resolvedBlockOfId, the same accessor mc-physics's own
  // kernel-world.ts adapter uses.
  const blockPropertiesAt: SimPhysicsConfig['resolve']['blockPropertiesAt'] = (blockX, blockY, blockZ) => {
    const reading = Effect.runSync(currentChunkStore.getBlock(blockPosition(blockX, blockY, blockZ)))
    if (reading._tag !== 'Block') return Result.succeed(BLOCK_PROPERTY_DEFAULTS)
    if (isEmpty(reading.block)) return Result.succeed(null)
    return Result.map(resolvedBlockOfId(reading.block), (resolved) => resolved?.properties ?? null)
  }
  // Surface, hazard and fluid sampling read loaded cells only; an unloaded cell
  // samples as air, while `blockPropertiesAt` above keeps it solid for collision.
  const blockIdAt: BlockIdAt = (blockX, blockY, blockZ) => {
    const reading = Effect.runSync(currentChunkStore.getBlock(blockPosition(blockX, blockY, blockZ)))
    return reading._tag === 'Block' ? reading.block : null
  }
  const simPhysicsConfig: SimPhysicsConfig = {
    resolve: {
      blockPropertiesAt,
      environment: blockEnvironmentFromKernel(blockIdAt),
      halfWidth: BlockLength(PLAYER_HALF_WIDTH),
      halfHeight: HalfHeight(PLAYER_HALF_HEIGHT),
      stepHeight: BlockLength(PLAYER_STEP_HEIGHT_M),
    },
    walkSpeed: WALK_SPEED_M_PER_S,
    jumpSpeed: JUMP_SPEED_M_PER_S,
  }
  type EnvironmentalContactCell = EnvironmentalContact & {
    readonly position: { readonly x: number; readonly y: number; readonly z: number }
  }
  // Keep boundary contact behavior aligned with mc-physics collision tests.
  const physicsContactEpsilon = 1e-9
  const intervalOverlap = (
    minA: number,
    maxA: number,
    minB: number,
    maxB: number,
  ): number => Math.min(maxA, maxB) - Math.max(minA, minB)
  const intervalGap = (
    minA: number,
    maxA: number,
    minB: number,
    maxB: number,
  ): number => Math.max(minB - maxA, minA - maxB, 0)
  const overlapsUnitCell = (
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
    x: number,
    y: number,
    z: number,
  ): boolean =>
    intervalOverlap(minX, maxX, x, x + 1) > 0 &&
    intervalOverlap(minY, maxY, y, y + 1) > 0 &&
    intervalOverlap(minZ, maxZ, z, z + 1) > 0
  // "Standing on" is contact with a cell's TOP FACE, not volume overlap —
  // unlike lava/cactus, which a player is immersed IN, a grounded player's
  // feet rest exactly at the surface of whatever supports them, never inside
  // it. Now that simPhysicsConfig resolves each block's real registry
  // collisionShape (a plate included), that surface is no longer always
  // `cell.y + 1` — a plate's is `cell.y + PRESSURE_PLATE_SHAPE.maxY` — so the
  // top height is read from the same shape table mc-physics's own resolver
  // consults, rather than assumed.
  const restingContactEpsilon = 1e-3
  const isStandingOnCell = (
    feetPosition: { readonly x: number; readonly y: number; readonly z: number },
    x: number,
    y: number,
    z: number,
  ): boolean => {
    // Callers pass pressure-plate block cells, which are always integers.
    const reading = Effect.runSync(currentChunkStore.getBlock(blockPosition(BlockAxis(x), BlockAxis(y), BlockAxis(z))))
    if (reading._tag !== 'Block') return false
    // A chunk-store BlockId is already validated and the static registry always builds.
    const shape = aabbOfCollisionShape(Result.getOrThrow(propertyOfBlockId(reading.block, 'collisionShape')))
    if (shape === null) return false
    return (
      intervalOverlap(
        feetPosition.x - PLAYER_HALF_WIDTH,
        feetPosition.x + PLAYER_HALF_WIDTH,
        x,
        x + 1,
      ) > 0 &&
      intervalOverlap(
        feetPosition.z - PLAYER_HALF_WIDTH,
        feetPosition.z + PLAYER_HALF_WIDTH,
        z,
        z + 1,
      ) > 0 &&
      Math.abs(feetPosition.y - (y + shape.maxY)) < restingContactEpsilon
    )
  }
  const touchesCactusHorizontalSide = (
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
    x: number,
    y: number,
    z: number,
  ): boolean => {
    if (intervalOverlap(minY, maxY, y, y + 1) <= physicsContactEpsilon) {
      return false
    }
    const overlapsX = intervalOverlap(minX, maxX, x, x + 1) > physicsContactEpsilon
    const overlapsZ = intervalOverlap(minZ, maxZ, z, z + 1) > physicsContactEpsilon
    return (
      (intervalGap(minX, maxX, x, x + 1) <= physicsContactEpsilon && overlapsZ) ||
      (intervalGap(minZ, maxZ, z, z + 1) <= physicsContactEpsilon && overlapsX)
    )
  }
  const environmentalContactCellsForPose = (
    pose: { readonly feetPosition: SessionPosition },
  ): ReadonlyArray<EnvironmentalContactCell> => {
    const minX = pose.feetPosition.x - PLAYER_HALF_WIDTH
    const maxX = pose.feetPosition.x + PLAYER_HALF_WIDTH
    const minY = pose.feetPosition.y
    const maxY = pose.feetPosition.y + PLAYER_HALF_HEIGHT * 2
    const minZ = pose.feetPosition.z - PLAYER_HALF_WIDTH
    const maxZ = pose.feetPosition.z + PLAYER_HALF_WIDTH
    const contacts: Array<EnvironmentalContactCell> = []

    for (
      let x = Math.floor(minX - physicsContactEpsilon);
      x < Math.ceil(maxX + physicsContactEpsilon);
      x += 1
    ) {
      for (let y = Math.floor(minY); y < Math.ceil(maxY); y += 1) {
        for (
          let z = Math.floor(minZ - physicsContactEpsilon);
          z < Math.ceil(maxZ + physicsContactEpsilon);
          z += 1
        ) {
          const reading = Effect.runSync(currentChunkStore.getBlock(blockPosition(BlockAxis(x), BlockAxis(y), BlockAxis(z))))
          if (reading._tag !== 'Block') continue
          // A chunk-store BlockId is already validated and the static registry always builds.
          const block = Result.getOrThrow(blockTypeOfId(reading.block))
          if (block !== 'lava' && block !== 'cactus') continue
          const contactDamage = Result.getOrThrow(propertyOfBlockId(reading.block, 'contactDamage'))
          if (contactDamage === undefined) continue
          if (
            block === 'lava' &&
            !overlapsUnitCell(minX, maxX, minY, maxY, minZ, maxZ, x, y, z)
          ) {
            continue
          }
          if (
            block === 'cactus' &&
            !touchesCactusHorizontalSide(
              minX,
              maxX,
              minY,
              maxY,
              minZ,
              maxZ,
              x,
              y,
              z,
            )
          ) {
            continue
          }
          contacts.push({ position: { x, y, z }, block, contactDamage })
        }
      }
    }
    return contacts
  }
  const environmentalContactsForPose = (
    pose: { readonly feetPosition: SessionPosition },
  ): ReadonlyArray<EnvironmentalContact> => {
    const contactsByBlock = new Map<EnvironmentalContact['block'], EnvironmentalContact>()
    for (const { block, contactDamage } of environmentalContactCellsForPose(pose)) {
      contactsByBlock.set(block, { block, contactDamage })
    }
    return [...contactsByBlock.values()]
  }
  const resetSimState = (physicsEnabled: boolean): void => {
    resetBowUse()
    environmentalContactDamageState = INITIAL_ENVIRONMENTAL_CONTACT_DAMAGE_STATE
    pendingMiningToolDamage.splice(0)
    pendingBlockBreakConfirmations.splice(0)
    Effect.runSync(Ref.set(simState.resolvedFeetPosition, Option.none()))
    Effect.runSync(Ref.set(simState.movementIntent, { forward: 0, strafe: 0 }))
    Effect.runSync(Ref.set(simState.jumpIntent, false))
    Effect.runSync(Ref.set(simState.velocity, { x: BlocksPerSecond(0), y: BlocksPerSecond(0), z: BlocksPerSecond(0) }))
    Effect.runSync(Ref.set(simState.isGrounded, false))
    Effect.runSync(resetLandingImpact(simState))
    Effect.runSync(
      Ref.set(
        simState.physicsConfig,
        physicsEnabled ? Option.some(simPhysicsConfig) : Option.none(),
      ),
    )
  }
  const alignActiveDimension = (dimension: Dimension): boolean => {
    if (currentChunkContext.dimension === dimension) return false
    Effect.runSync(retainDimensionResidents(currentChunkContext))
    // The entities owner holds every dimension and the entities view shows the
    // player's current one, so no roster is swapped here.
    currentChunkContext = getOrCreateDimensionChunkContext(dimension)
    Effect.runSync(showDimensionChunks(worldRenderer, currentChunkContext))
    redstoneDirty = true
    return true
  }
  let blockBreakCounters: BlockBreakCounters = EMPTY_BLOCK_BREAK_COUNTERS
  let placementsRequested = 0
  let nativeInputQueue: NativeInputQueueState = EMPTY_NATIVE_INPUT_QUEUE
  const handleNativeMouseDown = (event: MouseEvent): void => {
    const bounds = canvas.getBoundingClientRect()
    const isOverCanvas = event.clientX >= bounds.left
      && event.clientX <= bounds.right
      && event.clientY >= bounds.top
      && event.clientY <= bounds.bottom
    if (!isOverCanvas && document.pointerLockElement !== canvas) return
    nativeInputQueue = enqueueNativeMouseButton(nativeInputQueue, event.button)
  }
  window.addEventListener('mousedown', handleNativeMouseDown, true)
  let nextItemUseRequestId = 0
  const pendingFurnaceAdvances = new Map<string, string>()
  const deferredFurnaceAdvanceSecs = new Map<string, number>()
  let nextBlockUseRequestId = 0
  let nextBlockPlacementRequestId = 0
  let nextMeleeAttackRequestId = 0

  // THE FRAME STATE IS BUILT HERE, not inside `gameplayModule`, and that is the
  // whole reason breaking works. `gameplayStages` takes the state as an
  // argument — `makeGameplayStages` builds a private one — and `pendingBreaks`
  // is an INBOX the host fills. mx-gameplay's own header says so: "Input
  // belongs to mc-render and reaches the rules as a request to act on a
  // position."
  //
  // A host that used `gameplayModule` directly would get stages that drain an
  // inbox nobody can reach, which is the 「callable but unreachable」 state that
  // repository has had to correct more than once.
  const portalDimensions = ['overworld', 'nether', 'end'] as const satisfies ReadonlyArray<Dimension>
  const syncPortalCandidatesFor = (dimension: Dimension): Effect.Effect<void> =>
    setPortalCandidates(
      gameplayState,
      dimension,
      [...portalStates.values()]
        .filter((portal) => portal.dimension === dimension)
        // Portal positions are block cells: integers by BlockCoordinateSchema or kernel BlockPosition.
        .map((portal) => blockPosition(
          BlockAxis(portal.position.x),
          BlockAxis(portal.position.y),
          BlockAxis(portal.position.z),
        )),
    )
  const syncPortalCandidateSnapshots = (): Effect.Effect<void> =>
    Effect.asVoid(Effect.all(portalDimensions.map(syncPortalCandidatesFor)))
  const registerPortal = (portal: PersistedPortalState): boolean => {
    const key = portalKeyOf(portal)
    if (portalStates.has(key)) return false
    portalStates.set(key, portal)
    Effect.runSync(syncPortalCandidatesFor(portal.dimension))
    markSessionDirty()
    return true
  }
  type PortalLayout = {
    readonly frame: ReadonlyArray<PersistedPortalState['position']>
    readonly interior: ReadonlyArray<PersistedPortalState['position']>
  }
  // Keyed by cell so a later edit replaces an earlier one at the same cell,
  // the outcome of the sequential setBlock calls these batches replaced.
  type PlannedBlockEdits = Map<BlockPositionKey, { readonly position: BlockPosition; readonly block: BlockId }>
  const portalCellOf = (position: PersistedPortalState['position']): BlockPosition =>
    // Portal positions are block cells: integers by BlockCoordinateSchema or kernel BlockPosition.
    blockPosition(BlockAxis(position.x), BlockAxis(position.y), BlockAxis(position.z))
  const cellInColumn = (column: BlockPosition, y: number): BlockPosition =>
    blockPosition(column.x, BlockAxis(y), column.z)
  const planBlockEdit = (edits: PlannedBlockEdits, position: BlockPosition, block: BlockId): void => {
    edits.set(blockPositionKeyOf(position), { position, block })
  }
  const planPortalEdits = (edits: PlannedBlockEdits, layout: PortalLayout): void => {
    for (const position of layout.frame) planBlockEdit(edits, portalCellOf(position), OBSIDIAN_BLOCK_ID)
    for (const position of layout.interior) planBlockEdit(edits, portalCellOf(position), NETHER_PORTAL_BLOCK_ID)
  }
  // The port writes only into loaded chunks. A load failure fails the write.
  const loadChunksFor = (context: DimensionChunkContext, positions: ReadonlyArray<BlockPosition>) =>
    Effect.gen(function* () {
      const pending = new Map<string, ChunkCoord>()
      for (const position of positions) {
        const chunk = chunkCoordOfBlock(position)
        const key = chunkKeyOf(chunk)
        if (!context.streamLoaded.has(key)) pending.set(key, chunk)
      }
      for (const [key, chunk] of pending) {
        yield* context.chunkStore.load(chunk)
        context.streamLoaded.add(key)
        chunksStreamedIn += 1
      }
    })
  // One port batch: the ChunkStore prepares every edit before it publishes
  // any, so a failed commit leaves none of the edits written.
  const commitPlannedEdits = (dimension: Dimension, edits: PlannedBlockEdits) =>
    writeBlocksThroughPort(dimension, [...edits.values()])
  const plannedPositions = (edits: PlannedBlockEdits): ReadonlyArray<BlockPosition> =>
    [...edits.values()].map(({ position }) => position)
  const materializePortal = (dimension: Dimension, layout: PortalLayout) =>
    Effect.gen(function* () {
      const edits: PlannedBlockEdits = new Map()
      planPortalEdits(edits, layout)
      yield* loadChunksFor(getOrCreateDimensionChunkContext(dimension), plannedPositions(edits))
      yield* commitPlannedEdits(dimension, edits)
      markSessionDirty()
    })
  // mc-worldgen's resolveNetherTravel computes `destination` from pure 8:1
  // arithmetic with no knowledge of what occupies it, and mx-gameplay's
  // applyPortalTravel already `moveTo`'d the player there earlier this
  // frame — see the comment above the `applyPortalTravels()` call site.
  // That destination lands inside solid terrain roughly as often as it
  // lands in the open, since it is just wherever the scaled coordinate
  // happens to fall on generated ground. An arrival inside solid terrain
  // starts the frame already overlapping it (teleported there, not swept
  // there), and mc-physics's resolver only resolves a boundary the
  // player's box CROSSES during a step — the same fact `restoreLookingAt`
  // above measured for QA-spawned hostiles — so it never gets pushed out:
  // ungrounded, unfalling, and blocked in every direction by the same rock
  // it is standing inside.
  //
  // This searches the arrival COLUMN ONLY — same x/z as the arithmetic
  // destination, the one axis vanilla itself searches — for the nearest
  // existing open pocket with solid footing, checked nearest-Y-first so a
  // correction never drifts further than it has to from where the portal
  // math actually pointed. ONLY the one column, not every column the
  // player's half-width footprint might straddle: a live round-trip test
  // caught the wider check reading a portal's own frame as "the body isn't
  // clear here", because a frame stands immediately adjacent to its
  // interior by construction and a footprint sized for open terrain
  // reaches straight into it. The player is TELEPORTED into that partial
  // overlap the same as every arrival here, so it is the same harmless
  // coexistence the header above describes, not a defect to correct.
  //
  // If the destination cell and the one above it are already clear,
  // nothing was overlapping in the first place and ordinary physics —
  // falling through real open space, resting on real ground — is left to
  // handle it untouched; this is what keeps the other, already-working
  // half of arrivals unchanged. Only when no open pocket exists within the
  // search bound (solid rock the whole way) does this carve one at the
  // arithmetic destination itself, the same flush-floor-plus-cleared-column
  // shape `restoreLookingAt` already proves out for the identical
  // underlying defect.
  const PORTAL_LANDING_SEARCH_BLOCKS = 32
  //
  // The landing is planned against the store as it will read once `edits`
  // (the destination portal in the same batch) is committed, which is the
  // state the earlier sequential writes left before this column was read.
  const planSafePortalLanding = (
    context: DimensionChunkContext,
    destination: BlockPosition,
    edits: PlannedBlockEdits,
  ) =>
    Effect.gen(function* () {
      const plannedOrStoredBlock = (position: BlockPosition) => {
        const planned = edits.get(blockPositionKeyOf(position))
        return planned === undefined
          ? Effect.map(context.chunkStore.getBlock(position), (reading) => reading._tag === 'Block' ? reading.block : undefined)
          : Effect.succeed(planned.block)
      }

      // The SAME notion of "does this cell obstruct a body" the real
      // resolver uses — collisionShape, via blockPropertiesAt's own
      // accessor above — and deliberately not solidityFromStore's
      // `passable` capability check, which a first version of this fix
      // used: nether_portal carries no `passable: true` capability (only
      // `suffocates: false` and `validSpawnSurface: false`), so that check
      // read a portal's own interior as solid ground and "corrected" a
      // player already standing safely inside a freshly built one, dropping
      // them out of it and stranding the return trip.
      //
      // ONE EXPLICIT EXEMPTION REMAINS EVEN AFTER SWITCHING TO
      // collisionShape, and it also needed the live round-trip test to
      // surface: nether_portal's registry row sets no collisionShape of its
      // own either, so it defaults to kernel's ordinary "full solid cube"
      // the same as any other undeclared block. Nothing in mc-physics ever
      // pushes a body OUT of a cell it is already standing in when the body
      // did not cross into it during a step — the identical fact this
      // fix's whole header is about — so a player TELEPORTED into a portal
      // interior (every arrival here, and every QA restore) simply
      // coexists with that "solid" cell harmlessly, which is how dwelling
      // has ever worked at all. Treating it as an obstruction this fix
      // must correct fights that coexistence instead of relying on it, so
      // nether_portal is read as clear here regardless of its shape — the
      // same block-type test stepPortalTravel's own `inPortal` uses.
      const isObstructed = (y: number) =>
        Effect.gen(function* () {
          const block = yield* plannedOrStoredBlock(cellInColumn(destination, y))
          if (block === undefined) return true
          if (isEmpty(block)) return false
          if ((yield* Effect.fromResult(blockTypeOfId(block))) === 'nether_portal') return false
          return aabbOfCollisionShape(yield* Effect.fromResult(propertyOfBlockId(block, 'collisionShape'))) !== null
        })
      const clearAt = (y: number) => Effect.map(isObstructed(y), (obstructed) => !obstructed)

      if ((yield* clearAt(destination.y)) && (yield* clearAt(destination.y + 1))) return undefined

      for (let offset = 0; offset <= PORTAL_LANDING_SEARCH_BLOCKS; offset += 1) {
        const candidates =
          offset === 0
            ? [destination.y - 1]
            : [destination.y - 1 + offset, destination.y - 1 - offset]
        for (const candidate of candidates) {
          if ((yield* isObstructed(candidate)) && (yield* clearAt(candidate + 1)) && (yield* clearAt(candidate + 2))) {
            return { floorY: candidate, carved: false }
          }
        }
      }
      return { floorY: destination.y - 1, carved: true }
    })
  // The stage commits the destination before this drain. Commit its world
  // edits before updating the ledger and finalizing the player's destination
  // through the owner-backed view. h5b restores the pre-frame player on failure;
  // earlier successful travel batches and ledger entries remain committed.
  const applyPortalTravels = () =>
    Effect.gen(function* () {
      const travels = yield* drainPortalTravels(gameplayState)
      for (const travel of travels) {
        const { toDimension, destination, portalToCreate } = travel.plan
        const destinationPortal = { dimension: toDimension, position: destination }
        const portalLayout = Option.isSome(portalToCreate) && !portalStates.has(portalKeyOf(destinationPortal))
          ? portalToCreate.value
          : undefined
        const context = getOrCreateDimensionChunkContext(toDimension)
        const destinationCell = portalCellOf(destination)
        const edits: PlannedBlockEdits = new Map()
        if (portalLayout !== undefined) planPortalEdits(edits, portalLayout)
        yield* loadChunksFor(context, [destinationCell, ...plannedPositions(edits)])
        const landing = yield* planSafePortalLanding(context, destinationCell, edits)
        if (landing !== undefined) {
          if (landing.carved) planBlockEdit(edits, cellInColumn(destinationCell, landing.floorY), BLOCK.STONE)
          planBlockEdit(edits, cellInColumn(destinationCell, landing.floorY + 1), BLOCK.AIR)
          planBlockEdit(edits, cellInColumn(destinationCell, landing.floorY + 2), BLOCK.AIR)
        }
        if (edits.size > 0) yield* commitPlannedEdits(toDimension, edits)

        registerPortal({ dimension: travel.sourceDimension, position: travel.sourcePosition })
        registerPortal(destinationPortal)
        if (portalLayout !== undefined || landing?.carved === true) markSessionDirty()
        const pose = yield* playerApi.pose
        yield* playerApi.restore({
          ...pose,
          feetPosition: {
            x: PositionAxis(destination.x),
            y: PositionAxis(landing === undefined ? destination.y : landing.floorY + 1),
            z: PositionAxis(destination.z),
          },
        }, toDimension)
      }
    })
  Effect.runSync(syncPortalCandidateSnapshots())
  const observedMobDrops: Array<MobDropEvent & { readonly renderId: string }> = []
  let nextMobDropId = 0
  let lastObservedItemUse: ItemUseResult | undefined
  type PendingItemUse =
    | {
        readonly kind: 'ignition'
        readonly slotIndex: number
        readonly heldItem: IgnitionItemType
        readonly dimension: Dimension
      }
    | { readonly kind: 'till'; readonly slotIndex: number; readonly heldItem: HoeItemType }
    | { readonly kind: 'plant'; readonly slotIndex: number; readonly dimension: Dimension }
    | {
        readonly kind: 'harvest'
        readonly dimension: Dimension
        readonly position: { readonly x: number; readonly y: number; readonly z: number }
      }
    | { readonly kind: 'eat'; readonly slotIndex: number }
    | { readonly kind: 'brewing'; readonly action: 'insert'; readonly item: string }
    | { readonly kind: 'brewing'; readonly action: 'collect' | 'drink' }
  const pendingItemUses = new Map<string, PendingItemUse>()
  let bowUseState: BowUseState = IDLE_BOW_USE
  let projectileRuntimeState = initialProjectileRuntimeState()
  let eyeOfEnderRuntimeState = initialEyeOfEnderRuntimeState()
  let nextEyeOfEnderBreaks: boolean | undefined
  const pendingMeleeAttacks = new Map<
    string,
    { readonly slotIndex: number; readonly item: SwordItem }
  >()
  const bowInteractionLocked = (): boolean =>
    bowUseState._tag === 'Drawing'
  const resetBowUse = (): void => {
    bowUseState = IDLE_BOW_USE
    Effect.runSync(Ref.set(gameplayState.pendingBowShots, []))
    Effect.runSync(Ref.set(gameplayState.bowShotResults, []))
  }
  const settleMeleeAttackResults = (): void => {
    for (const result of Effect.runSync(drainMeleeAttackResults(gameplayState))) {
      const pending = pendingMeleeAttacks.get(result.requestId)
      if (pending === undefined) continue

      pendingMeleeAttacks.delete(result.requestId)
      if (!result.success) continue

      const currentItem = Effect.runSync(world.inventory.snapshot)
        .slots[pending.slotIndex]?.item ?? null
      if (currentItem !== pending.item) continue

      const enchantedItem = projectedInventoryEnchantedItem(pending.slotIndex)
      const appliedWear = enchantedItem === null
        ? 1
        : durabilityWearWithEnchantments(1, enchantedItem, [Math.random()])
      if (appliedWear === 0) continue
      const damageResult = Effect.runSync(
        world.inventory.damageAt(
          { _tag: 'Inventory', slotIndex: pending.slotIndex },
          appliedWear,
        ),
      )
      if (damageResult._tag === 'Broken') {
        enchantedItems.delete(String(pending.slotIndex))
        customNames.delete(String(pending.slotIndex))
      }
      if (damageResult._tag === 'Damaged' || damageResult._tag === 'Broken') {
        markSessionDirty()
      }
    }
  }
  const pendingBlockUses = new Map<
    string,
    { readonly dimension: Dimension; readonly position: { readonly x: number; readonly y: number; readonly z: number } }
  >()
  const pendingBlockPlacements = new Map<
    string,
    {
      readonly dimension: Dimension
      readonly item: GameplayItemType
      readonly position: { readonly x: number; readonly y: number; readonly z: number }
    }
  >()
  const pendingWitherSummonChecks: Array<{
    readonly dimension: Dimension
    readonly item: 'wither_skeleton_skull'
    readonly position: { readonly x: number; readonly y: number; readonly z: number }
  }> = []
  const pendingMiningToolDamage: Array<{
    readonly dimension: Dimension
    readonly position: { readonly x: number; readonly y: number; readonly z: number }
    readonly blockId: number
    readonly slotIndex: number
    readonly item: 'wooden_pickaxe' | 'stone_pickaxe' | 'iron_pickaxe' | 'diamond_pickaxe'
  }> = []
  const pendingBlockBreakConfirmations: Array<{
    readonly dimension: Dimension
    readonly position: { readonly x: number; readonly y: number; readonly z: number }
    readonly blockId: number
  }> = []

  const multiplayerConnection = await connectMultiplayer({
    sessionId,
    search: window.location.search,
    href: window.location.href,
    getSessionStorage: () => window.sessionStorage,
    getLocalStorage: () => window.localStorage,
    failBoot,
  })
  if (multiplayerConnection.status === 'failed') return
  const {
    multiplayer,
    multiplayerInboundStage,
    multiplayerOutboundStage,
    requiredSleepRatio,
  } = multiplayerConnection
  let authoritativeLightning: Readonly<{ sequence: number; at: Vec3; expiresAtSecs: number }> | undefined
  const multiplayerEntities = new Map<string, AuthoritativeEntityState>()
  type MultiplayerInventorySelection = Readonly<{
    source: number
    remaining: number
    mode: 'all' | 'split'
  }>
  let multiplayerInventorySelection: MultiplayerInventorySelection | null = null
  type QueuedPlayerDamage = Readonly<{
    readonly amount: number
    readonly minimumHealthPoints: number
  }>
  let queuedPlayerDamages: QueuedPlayerDamage[] = []
  let pendingCrafting: {
    readonly commandId: string
    readonly acceptedRevision: number | null
  } | null = null
  let activeBrewingStandAt: { readonly x: number; readonly y: number; readonly z: number } | undefined
  let closeChestOnFacilityIdle = false
  let networkSleepState: SleepClientState = initialSleepClientState()
  let nextSleepRequest = 1
  let appliedNightSkipRevision: number | null = null
  let multiplayerRejection = ''
  let multiplayerHandshakeComplete = false
  let multiplayerClosed = false
  let lastPlayerMoveSentAt = Number.NEGATIVE_INFINITY
  let lastPlayerMoveSent: {
    readonly world: WorldId
    readonly at: { readonly x: number; readonly y: number; readonly z: number }
    readonly facing: { readonly yawRadians: number; readonly pitchRadians: number }
  } | undefined

  const multiplayerClientContext: MultiplayerClientContext = {
    multiplayer,
    ui: {
      canvas,
      multiplayerStatus,
      multiplayerChat,
      multiplayerChatLog,
      multiplayerChatForm,
      multiplayerChatInput,
    },
    state: {
      get inventoryOpen() { return inventoryOpen },
      set inventoryOpen(value) { inventoryOpen = value },
      get inventoryMode() { return inventoryMode },
      set inventoryMode(value) { inventoryMode = value },
      get tradeOpen() { return tradeOpen },
      set tradeOpen(value) { tradeOpen = value },
      get activeVillagerId() { return activeVillagerId },
      set activeVillagerId(value) { activeVillagerId = value },
      get brewingOpen() { return brewingOpen },
      set brewingOpen(value) { brewingOpen = value },
      get brewingStatus() { return brewingStatus },
      set brewingStatus(value) { brewingStatus = value },
      get tradeStatus() { return tradeStatus },
      set tradeStatus(value) { tradeStatus = value },
      get enchantmentSeed() { return enchantmentSeed },
      set enchantmentSeed(value) { enchantmentSeed = value },
      get anvilName() { return anvilName },
      set anvilName(value) { anvilName = value },
      get anvilStatus() { return anvilStatus },
      set anvilStatus(value) { anvilStatus = value },
      get enchantingStatus() { return enchantingStatus },
      set enchantingStatus(value) { enchantingStatus = value },
      get customNames() { return customNames },
      get enchantedItems() { return enchantedItems },
      get eyeOfEnderRuntimeState() { return eyeOfEnderRuntimeState },
      set eyeOfEnderRuntimeState(value) { eyeOfEnderRuntimeState = value },
      get sleepRuntimeState() { return sleepRuntimeState },
      set sleepRuntimeState(value) { sleepRuntimeState = value },
      get witherRevision() { return witherRevision },
      set witherRevision(value) { witherRevision = value },
      get witherRuntimeState() { return witherRuntimeState },
      set witherRuntimeState(value) { witherRuntimeState = value },
      get authoritativeEnderDragonSnapshot() { return authoritativeEnderDragonSnapshot },
      set authoritativeEnderDragonSnapshot(value) { authoritativeEnderDragonSnapshot = value },
      get enderDragonRevision() { return enderDragonRevision },
      set enderDragonRevision(value) { enderDragonRevision = value },
      get redstoneDirty() { return redstoneDirty },
      set redstoneDirty(value) { redstoneDirty = value },
      get leverStates() { return leverStates },
      get poweredRails() { return poweredRails },
      get fishingResult() { return fishingResult },
      set fishingResult(value) { fishingResult = value },
      get networkFishingState() { return networkFishingState },
      set networkFishingState(value) { networkFishingState = value },
      get furnaceStates() { return furnaceStates },
      get activeFurnaceKey() { return activeFurnaceKey },
      set activeFurnaceKey(value) { activeFurnaceKey = value },
      get activeChestId() { return activeChestId },
      set activeChestId(value) { activeChestId = value },
      get selectedHotbarIndex() { return selectedHotbarIndex },
      set selectedHotbarIndex(value) { selectedHotbarIndex = value },
      get chestStatus() { return chestStatus },
      set chestStatus(value) { chestStatus = value },
      get furnaceStatus() { return furnaceStatus },
      set furnaceStatus(value) { furnaceStatus = value },
      get authoritativeLightning() { return authoritativeLightning },
      set authoritativeLightning(value) { authoritativeLightning = value },
      get multiplayerEntities() { return multiplayerEntities },
      get multiplayerInventorySelection() { return multiplayerInventorySelection },
      set multiplayerInventorySelection(value) { multiplayerInventorySelection = value },
      get queuedPlayerDamages() { return queuedPlayerDamages },
      set queuedPlayerDamages(value) { queuedPlayerDamages = value },
      get pendingCrafting() { return pendingCrafting },
      set pendingCrafting(value) { pendingCrafting = value },
      get activeBrewingStandAt() { return activeBrewingStandAt },
      set activeBrewingStandAt(value) { activeBrewingStandAt = value },
      get closeChestOnFacilityIdle() { return closeChestOnFacilityIdle },
      set closeChestOnFacilityIdle(value) { closeChestOnFacilityIdle = value },
      get networkSleepState() { return networkSleepState },
      set networkSleepState(value) { networkSleepState = value },
      get nextSleepRequest() { return nextSleepRequest },
      set nextSleepRequest(value) { nextSleepRequest = value },
      get appliedNightSkipRevision() { return appliedNightSkipRevision },
      set appliedNightSkipRevision(value) { appliedNightSkipRevision = value },
      get multiplayerRejection() { return multiplayerRejection },
      set multiplayerRejection(value) { multiplayerRejection = value },
      get multiplayerHandshakeComplete() { return multiplayerHandshakeComplete },
      set multiplayerHandshakeComplete(value) { multiplayerHandshakeComplete = value },
      get multiplayerClosed() { return multiplayerClosed },
      set multiplayerClosed(value) { multiplayerClosed = value },
      get lastPlayerMoveSentAt() { return lastPlayerMoveSentAt },
      set lastPlayerMoveSentAt(value) { lastPlayerMoveSentAt = value },
      get lastPlayerMoveSent() { return lastPlayerMoveSent },
      set lastPlayerMoveSent(value) { lastPlayerMoveSent = value },
    },
    services: {
      deferToFrameBoundary,
      world,
      gameplayState,
      gameplayCommit,
      playerApi,
      time,
      weather,
      currentChunkContext: () => currentChunkContext,
      getOrCreateDimensionChunkContext,
      leverKeyOf,
      vehicleById,
      vehicleService,
      applyAuthoritativeVehicle,
      alignActiveDimension: (dimension) => { alignActiveDimension(dimension) },
      resetSimState,
      presentWeather,
      queueEndAudio,
      craftingStaleRetryLimit: CRAFTING_STALE_RETRY_LIMIT,
    },
    callbacks: {
      getInventoryInteraction: () => inventoryInteraction,
      renderPlayerUi: () => renderPlayerUi(),
      renderTradeUi: () => renderTradeUi(),
      renderBrewingUi: () => renderBrewingUi(),
      setInventoryOpen: (open) => setInventoryOpen(open),
    },
  }
  const multiplayerClientApi = createMultiplayerClient(multiplayerClientContext)
  const {
    enqueueMultiplayerPlayerMove,
    drainMultiplayerInbound,
    sendVitalsCommand,
    sendPortalUseCommand,
    sendEndProgressCommand,
    sendToggleLeverCommand,
    sendInventoryCommand,
    sendInventorySelection,
    sendVillagerTradeCommand,
    sendEntityCommand,
    sendFacilityCommand,
    pumpPlayerDamage,
    drainPlayerDamageInbound,
    requestCrafting,
    drainCraftingInbound,
    requestBrewing,
    requestAnvil,
    drainAnvilInbound,
    requestEnchanting,
    drainEnchantingInbound,
    requestIdFor,
  } = multiplayerClientApi

  const services = makeHostServiceContext({
    time,
    player: ownerBacked.stagePlayer,
    vehicles: vehicleService,
    entities: ownerBacked.entityManager,
    chunkStore: currentChunkStore,
    worldWrite: hostWorldWrite.port,
    inputContext: adapters.inputContext,
    redstoneContext: adapters.redstoneContext,
  })

  // -------------------------------------------------------------------------
  // 3. Composition
  // -------------------------------------------------------------------------

  // toBlob must start in the draw's own continuation, before the browser may
  // discard the WebGL drawing buffer. The save promise settles outside the
  // frame, so the draw never waits for it.
  const screenshotDrawPort: DrawPort = {
    draw: (camera) => adapters.worldRenderer.draw(camera).pipe(
      Effect.andThen(Effect.sync(() => {
        void screenshots.captureAfterRender().then((captured) => {
          if (Result.isFailure(captured)) console.error('Screenshot capture failed', captured.failure)
        })
      })),
    ),
    resize: (width, height) => adapters.worldRenderer.resize(width, height),
    setPostProcessingChain: (chain) => adapters.worldRenderer.setPostProcessingChain(chain),
  }

  const composedExit = await Effect.runPromiseExit(
    Effect.flatMap(
      registerHostModules({
        services,
        renderQuality: adapters.renderQuality,
        draw: screenshotDrawPort,
        chunkSync: activeDimensionChunkSync(() => currentChunkContext),
        uiFrameState,
        simState,
        gameplayState,
        gameplayCommit,
        gameplayBlockStateWorld,
        isActiveDimension: (dimension) => dimension === currentChunkContext.dimension,
        poweredRails,
        leverKeyOf,
        getMountedVehicleId: () => mountedVehicleId,
        setMountedVehicleId: (id) => {
          mountedVehicleId = id
        },
        getVehicleControls: () => vehicleControls,
        multiplayer,
        isCreativeMode,
      }),
      (modules) => composeGame(modules),
    ),
  )

  if (Exit.isFailure(composedExit)) {
    failBoot('module registration or composeGame failed', Cause.squash(composedExit.cause))
    return
  }

  const game = composedExit.value

  // Reported, never enforced — `domain/composition.ts` on why a dangling `after`
  // is legal and still worth printing.
  for (const warning of game.warnings) {
    console.warn(`[mc-compose] ${warning}`)
  }

  // The resolved total order, in the DOM. This is (a) of docs/testing.md §3.4
  // made visible in the browser: `test/e2e/roster-frame-order.test.ts` proves it
  // headless from a transcript, and this is the same claim about the modules
  // actually loaded.
  stageList.textContent = game.plan.order.join(' ')
  stageList.setAttribute('data-stage-count', String(game.plan.order.length))

  // -------------------------------------------------------------------------
  // 4. Screens
  // -------------------------------------------------------------------------

  // `document` satisfies mx-ui's `DomElementFactory` without a cast — that is
  // the property `mx-ui/application/dom-surface.ts` was designed around, and
  // the parent is an argument because mx-ui never goes looking for a document
  // (docs/public-api.md §4-1).
  //
  // mx-ui exposes UiMount, but this host also owns specialized furnace, chest,
  // anvil, enchanting, and trade overlays, so it composes those screens here.
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full'
  const hud = createHudView(document, hudParent, motion)
  const inventoryView = createInventoryView(document, inventoryParent)
  const furnaceView = createFurnaceView(document, inventoryParent)
  const chestView = createChestStorageView(document, inventoryParent)
  const anvilView = createAnvilView(document, inventoryParent)
  const enchantingView = createEnchantingTableView(document, inventoryParent)
  const crosshair = createCrosshairView(document, hudParent, motion)
  const statusEffectsHud = document.createElement('div')
  statusEffectsHud.id = 'status-effects-hud'
  statusEffectsHud.dataset['testid'] = 'status-effects'
  hudParent.append(statusEffectsHud)
  const swimmingHud = document.createElement('div')
  swimmingHud.id = 'swimming-hud'
  swimmingHud.dataset['testid'] = 'swimming'
  swimmingHud.hidden = true
  hudParent.append(swimmingHud)
  const projectileHud = document.createElement('div')
  projectileHud.id = 'projectile-hud'
  projectileHud.dataset['testid'] = 'projectiles'
  hudParent.append(projectileHud)
  const sleepHud = document.createElement('div')
  sleepHud.id = 'sleep-hud'
  sleepHud.dataset['testid'] = 'sleep'
  sleepHud.hidden = true
  hudParent.append(sleepHud)

  inventoryParent.setAttribute('role', 'dialog')
  inventoryParent.setAttribute('aria-label', 'Inventory')
  inventoryParent.setAttribute('aria-hidden', 'true')
  document.body.setAttribute('data-inventory-open', 'false')
  tradeParent.setAttribute('role', 'dialog')
  tradeParent.setAttribute('aria-label', 'Villager trading')
  tradeParent.setAttribute('aria-hidden', 'true')
  document.body.setAttribute('data-trade-open', 'false')
  brewingParent.setAttribute('role', 'dialog')
  brewingParent.setAttribute('aria-label', 'Brewing stand')
  brewingParent.setAttribute('aria-hidden', 'true')
  document.body.setAttribute('data-brewing-open', 'false')

  const renderTradeUi = (): void => {
    const trades = Effect.runSync(snapshotGameplayVillagerTrades)
    const villager = trades.villagers.find((candidate) => candidate.id === activeVillagerId)
    if (!tradeOpen || villager === undefined) {
      tradeParent.replaceChildren()
      return
    }
    const title = document.createElement('h2')
    title.textContent = villager.profession === 'farmer' ? 'Farmer' : 'Toolsmith'
    const offers = document.createElement('div')
    offers.className = 'trade-offers'
    for (const offer of villager.offers) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset['tradeOfferId'] = offer.id
      button.disabled = offer.uses >= offer.maxUses
      button.textContent = `${String(offer.input.count)} ${offer.input.item} -> ${String(offer.output.count)} ${offer.output.item} (${String(offer.uses)}/${String(offer.maxUses)})`
      offers.append(button)
    }
    const status = document.createElement('p')
    status.className = 'trade-status'
    status.setAttribute('role', 'status')
    status.textContent = tradeStatus
    const close = document.createElement('button')
    close.type = 'button'
    close.dataset['tradeClose'] = 'true'
    close.textContent = 'Close'
    tradeParent.replaceChildren(title, offers, status, close)
  }

  const villagerTradeStatus = (result: VillagerTradeResult): string => {
    if (result._tag === 'Traded') return 'Trade complete'
    switch (result.reason) {
      case 'UnknownOffer': return 'That offer is no longer available'
      case 'OutOfStock': return 'This offer is out of stock'
      case 'InsufficientItems': return 'You do not have the required items'
      case 'InventoryFull': return 'Your inventory is full'
      default: return 'Trade rejected'
    }
  }

  const setTradeOpen = (open: boolean, villagerId?: string): void => {
    if (open && (playerIsDead() || villagerId === undefined)) return
    if (open && brewingOpen) setBrewingOpen(false)
    tradeOpen = open
    activeVillagerId = open ? villagerId : undefined
    tradeStatus = ''
    tradeParent.hidden = !open
    tradeParent.setAttribute('aria-hidden', String(!open))
    document.body.setAttribute('data-trade-open', String(open))
    renderTradeUi()
    renderCrosshair()
    syncTouchControls()
    if (open && document.pointerLockElement === canvas) document.exitPointerLock()
  }

  // The trade screen renders from the trades owner, so the click is handled at
  // the frame boundary.
  tradeParent.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    if (event.target.closest('[data-trade-close]') !== null) {
      deferToFrameBoundary(() => setTradeOpen(false))
      return
    }
    const button = event.target.closest<HTMLElement>('[data-trade-offer-id]')
    const offerId = button?.dataset['tradeOfferId']
    if (offerId === undefined) return
    deferToFrameBoundary(() => {
      if (activeVillagerId === undefined) return
      if (multiplayer !== undefined && multiplayerHandshakeComplete) {
        if (sendVillagerTradeCommand(activeVillagerId, offerId)) {
          tradeStatus = 'Trading...'
          renderTradeUi()
        }
        return
      }
      nextVillagerTradeRequestId += 1
      Effect.runSync(requestVillagerTrade(gameplayState, {
        requestId: `villager-trade-${String(nextVillagerTradeRequestId)}`,
        villagerId: activeVillagerId,
        offerId,
      }))
      tradeStatus = 'Trading...'
      renderTradeUi()
    })
  })

  const brewingBottleFromItem = (item: string): BrewingBottle | undefined => {
    if (item === 'water_bottle') return item
    if (item === 'awkward_potion') return { potion: 'awkward' }
    if (item === 'potion_of_swiftness') return { potion: 'speed' }
    if (item === 'potion_of_poison') return { potion: 'poison' }
    if (item === 'potion_of_regeneration') return { potion: 'regeneration' }
    return undefined
  }

  const brewingSlotLabel = (slot: BrewingState['fuel']): string =>
    slot === undefined ? 'Empty' : `${String(slot.count)} ${slot.item}`

  const renderBrewingUi = (): void => {
    if (!brewingOpen) {
      brewingParent.replaceChildren()
      return
    }
    let summary = brewingParent.querySelector<HTMLElement>('[data-testid="brewing-state"]')
    let progress = brewingParent.querySelector<HTMLElement>('[data-testid="brewing-progress"]')
    let status = brewingParent.querySelector<HTMLElement>('.brewing-status')
    let collect = brewingParent.querySelector<HTMLButtonElement>('[data-brewing-action="collect"]')
    if (summary === null || progress === null || status === null || collect === null) {
      const title = document.createElement('h2')
      title.textContent = 'Brewing Stand'
      summary = document.createElement('p')
      summary.dataset['testid'] = 'brewing-state'
      progress = document.createElement('p')
      progress.dataset['testid'] = 'brewing-progress'
      const insert = document.createElement('button')
      insert.type = 'button'
      insert.dataset['brewingAction'] = 'insert'
      insert.textContent = 'Insert selected item'
      collect = document.createElement('button')
      collect.type = 'button'
      collect.dataset['brewingAction'] = 'collect'
      collect.textContent = 'Collect bottle'
      const drink = document.createElement('button')
      drink.type = 'button'
      drink.dataset['brewingAction'] = 'drink'
      drink.textContent = 'Drink potion'
      const close = document.createElement('button')
      close.type = 'button'
      close.dataset['brewingAction'] = 'close'
      close.textContent = 'Close'
      status = document.createElement('p')
      status.className = 'brewing-status'
      status.setAttribute('role', 'status')
      brewingParent.replaceChildren(title, summary, progress, insert, collect, drink, close, status)
    }
    const state = Effect.runSync(snapshotGameplayBrewing)
    collect.disabled = state.brewProgressSecs > 0
    summary.textContent = `Fuel: ${brewingSlotLabel(state.fuel)} (${String(state.fuelCharges)} charges) | Bottles: ${state.bottles.map(brewingSlotLabel).join(', ')} | Ingredient: ${brewingSlotLabel(state.ingredient)}`
    progress.textContent = state.brewProgressSecs === 0
      ? 'Idle'
      : `Brewing: ${state.brewProgressSecs.toFixed(1)}s / ${BREWING_TIME_SECS.toFixed(1)}s`
    status.textContent = brewingStatus
  }

  const setBrewingOpen = (open: boolean): void => {
    if (open && playerIsDead()) return
    if (open && tradeOpen) setTradeOpen(false)
    if (open && inventoryOpen) setInventoryOpen(false)
    brewingOpen = open
    if (!open) {
      activeBrewingStandAt = undefined
    }
    brewingStatus = ''
    brewingParent.hidden = !open
    brewingParent.setAttribute('aria-hidden', String(!open))
    document.body.setAttribute('data-brewing-open', String(open))
    if (open && multiplayer !== undefined) Effect.runSync(requestBrewing({ _tag: 'open' }))
    renderBrewingUi()
    renderCrosshair()
    syncTouchControls()
    if (open && document.pointerLockElement === canvas) document.exitPointerLock()
  }

  // Queue against the owners at the frame boundary; the stage alone consumes
  // storage, and the result drain presents the correlated outcome.
  brewingParent.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const action = event.target.closest<HTMLElement>('[data-brewing-action]')
      ?.dataset['brewingAction']
    if (action === undefined) return
    deferToFrameBoundary(() => {
      // The frame can close the stand before this runs.
      if (!brewingOpen) return
      if (action === 'close') {
        setBrewingOpen(false)
        return
      }
      if (action === 'insert') {
        const selected = Effect.runSync(world.inventory.snapshot).slots[selectedHotbarIndex]
        if (selected === undefined) {
          brewingStatus = 'Select brewing fuel, a bottle, or an ingredient'
          renderBrewingUi()
          return
        }
        const bottle = brewingBottleFromItem(selected.item)
        const ingredient: BrewingIngredient | undefined = selected.item === 'nether_wart'
          || selected.item === 'sugar' || selected.item === 'spider_eye' || selected.item === 'ghast_tear'
          ? selected.item : undefined
        if (selected.item !== 'blaze_powder' && bottle === undefined && ingredient === undefined) {
          brewingStatus = 'That item cannot be used for brewing'
          renderBrewingUi()
          return
        }
        const bottleIndex = bottle === undefined ? undefined
          : Effect.runSync(snapshotGameplayBrewing).bottles.findIndex((slot) => slot === undefined)
        if (bottleIndex === -1) {
          brewingStatus = 'Cannot insert item: Occupied'
          renderBrewingUi()
          return
        }
        if (multiplayer !== undefined) {
          Effect.runSync(requestBrewing(selected.item === 'blaze_powder'
            ? { _tag: 'insert-fuel', slot: selectedHotbarIndex }
            : bottleIndex !== undefined
              ? { _tag: 'insert-bottle', slot: selectedHotbarIndex, bottleIndex }
              : { _tag: 'insert-ingredient', slot: selectedHotbarIndex }))
          return
        }
        nextItemUseRequestId += 1
        const requestId = `brewing-${String(nextItemUseRequestId)}`
        if (selected.item === 'blaze_powder') {
          Effect.runSync(insertBrewingFuel(gameplayState, requestId))
        } else if (bottle !== undefined && bottleIndex !== undefined) {
          Effect.runSync(insertBrewingBottle(gameplayState, requestId, bottleIndex, bottle))
        } else if (ingredient !== undefined) {
          Effect.runSync(insertBrewingIngredient(gameplayState, requestId, ingredient))
        }
        pendingItemUses.set(requestId, { kind: 'brewing', action: 'insert', item: selected.item })
        brewingStatus = `Submitting ${selected.item}...`
        renderBrewingUi()
        renderPlayerUi()
        return
      }
      if (action === 'collect') {
        const state = Effect.runSync(snapshotGameplayBrewing)
        if (state.brewProgressSecs > 0) {
          brewingStatus = 'Cannot collect bottle: Brewing'
          renderBrewingUi()
          return
        }
        const bottleIndex = state.bottles.findIndex((slot) => slot !== undefined)
        if (bottleIndex === -1) {
          brewingStatus = 'Cannot collect bottle: Empty'
          renderBrewingUi()
          return
        }
        if (activeBrewingStandAt === undefined) {
          brewingStatus = 'Brewing stand is unavailable'
          renderBrewingUi()
          return
        }
        if (multiplayer !== undefined) {
          Effect.runSync(requestBrewing({ _tag: 'collect', bottleIndex }))
          return
        }
        nextItemUseRequestId += 1
        const requestId = `brewing-${String(nextItemUseRequestId)}`
        Effect.runSync(collectBrewingPotion(gameplayState, {
          requestId,
          actor: Schema.decodeUnknownSync(EntityIdSchema)('mx-gameplay:player-avatar'),
          tick: Schema.decodeUnknownSync(SimulationTickSchema)(Effect.runSync(Ref.get(gameplayState.tickCount))),
          address: Schema.decodeUnknownSync(BlockAddressSchema)({
            dimension: Effect.runSync(playerApi.dimension), position: activeBrewingStandAt,
          }),
          bottleIndex,
        }))
        pendingItemUses.set(requestId, { kind: 'brewing', action: 'collect' })
        brewingStatus = 'Collecting bottle...'
        renderBrewingUi()
        renderPlayerUi()
        return
      }
      if (action === 'drink') {
        if (multiplayer !== undefined) {
          Effect.runSync(requestBrewing({ _tag: 'drink', slot: selectedHotbarIndex }))
          return
        }
        nextItemUseRequestId += 1
        const requestId = `brewing-${String(nextItemUseRequestId)}`
        Effect.runSync(useBrewingPotion(gameplayState, {
          requestId,
          actor: Schema.decodeUnknownSync(EntityIdSchema)('mx-gameplay:player-avatar'),
          tick: Schema.decodeUnknownSync(SimulationTickSchema)(Effect.runSync(Ref.get(gameplayState.tickCount))),
          slotIndex: selectedHotbarIndex,
        }))
        pendingItemUses.set(requestId, { kind: 'brewing', action: 'drink' })
        brewingStatus = 'Drinking potion...'
        renderBrewingUi()
        renderPlayerUi()
      }
    })
  })

  let selectedHotbarIndex = 0
  let miningProgress: MiningProgressState | null = null
  let primaryAttackGestureConsumed = false
  const resetPrimaryAttackGesture = (): void => {
    miningProgress = null
    primaryAttackGestureConsumed = false
  }
  const crosshairContext = {
    crosshair,
    getPaused: () => paused,
    isInventoryOpen: () => inventoryOpen,
    isTradeOpen: () => tradeOpen,
    isBrewingOpen: () => brewingOpen,
    getMiningProgress: () => miningProgress,
  }
  const renderCrosshair = (
    nowSecs = Effect.runSync(browserClock.monotonicSecs),
  ): void => {
    renderCrosshairUi(crosshairContext, nowSecs)
  }
  let inventoryFocus: InventoryInteractionTarget = {
    kind: 'slot',
    region: 'hotbar',
    index: selectedHotbarIndex,
  }
  let equipmentActionStatus = ''
  let inventoryDragSource: InventoryDragTarget | undefined
  let furnaceFocus: FurnaceSlotId = 'input'
  let furnaceStatus = ''
  let chestFocus: ChestStorageSlotTarget = { region: 'chest', slot: 0 }
  let chestSelected: ChestStorageSlotTarget | undefined
  let chestStatus = ''
  const inventoryRuntime = createPlayerUiRuntime({
    deferToFrameBoundary,
    document,
    window,
    canvas,
    inventoryParent,
    touchControlsParent,
    swimmingHud,
    documentBody: document.body,
    touchAvailable,
    inventoryPresentations: INVENTORY_PRESENTATIONS,
    inventoryView,
    furnaceView,
    chestView,
    anvilView,
    enchantingView,
    inventoryService: world.inventory,
    worldInventory: world.inventory,
    inventoryStorageSnapshot: world.inventory.storageSnapshot,
    getPlayerPose: () => playerApi.pose,
    getPlayerDimension: () => playerApi.dimension,
    restorePlayerForDimension: (pose, dimension) => playerApi.restore(pose, dimension),
    getOrCreateDimensionChunkContext,
    readBlockAt: (position) => Effect.map(currentChunkStore.getBlock(position), (reading) =>
      reading._tag === 'Block'
        ? { _tag: 'Block', block: reading.block }
        : { _tag: 'Unavailable' }),
    customNames,
    enchantedItems,
    audio,
    getMultiplayer: () => multiplayer !== undefined,
    getPlayerHealthPoints: () => Effect.runSync(world.vitals.view).healthPoints,
    getVitalsDamageSnapshot: () => Effect.runSync(world.vitals.snapshot),
    applyVitalsDamage: (damage) => { Effect.runSync(world.vitals.damage(damage)) },
    restoreVitalsDamage: (vitals) => { Effect.runSync(world.vitals.restore(vitals)) },
    isCreativeMode,
    queuePlayerDamage: (amount, minimumHealthPoints) => {
      queuedPlayerDamages = [...queuedPlayerDamages, { amount, minimumHealthPoints }]
      pumpPlayerDamage()
    },
    handleLocalPlayerDeath: () => handleLocalPlayerDeath(),
    setSwimmingState: (state) => { swimmingState = state },
    resetSimState,
    getEntitiesForExplosion: () => Effect.runSync(world.entities.entities),
    setBlockEffect: (position, block) =>
      writeBlocksThroughPort(currentChunkContext.dimension, [{ position, block }]),
    writeBlocks: writeBlocksThroughPort,
    resolveExplosionEffects: (effects) => {
      for (const effect of effects) {
        Effect.runSync(resolveBowHits(ownerBacked.entityManager, [{
          id: SimEntityId(effect.id),
          damage: effect.damage,
        }]))
      }
    },
    getActiveSeed: () => activeSeed,
    endPortalFrames,
    endPortalFrameKey,
    getEndPortalComplete: () => endPortalComplete,
    setEndPortalComplete: (complete) => { endPortalComplete = complete },
    getExitPortalMaterialized: () => exitPortalMaterialized,
    getEyeOfEnderRuntimeState: () => eyeOfEnderRuntimeState,
    setEyeOfEnderRuntimeState: (state) => { eyeOfEnderRuntimeState = state },
    getNextEyeOfEnderBreaks: () => nextEyeOfEnderBreaks,
    setNextEyeOfEnderBreaks: (breaks) => { nextEyeOfEnderBreaks = breaks },
    sendEndProgressCommand,
    alignActiveDimension: (dimension) => { alignActiveDimension(dimension) },
    queueEndAudio,
    getBowInteractionLocked: () => bowInteractionLocked(),
    getPaused: () => paused,
    getTouchLookState: () => touchLookState,
    setTouchLookState: (state) => { touchLookState = state },
    clearHeldInput: () => {
      Effect.runSync(hostGamepad.reset)
      Effect.runSync(inputApi.clearHeld)
    },
    getSwimmingState: () => swimmingState,
    getFishingSession: () => fishingSession,
    setFishingResultState: (result) => { fishingResult = result },
    getInventoryOpen: () => inventoryOpen,
    setInventoryOpenState: (open) => { inventoryOpen = open },
    getInventoryMode: () => inventoryMode,
    setInventoryMode: (mode) => { inventoryMode = mode },
    getActiveChestId: () => activeChestId,
    setActiveChestId: (id) => { activeChestId = id },
    setChestSelected: (target) => { chestSelected = target },
    setChestFocus: (target) => { chestFocus = target },
    setChestStatus: (status) => { chestStatus = status },
    setCloseChestOnFacilityIdle: (close) => { closeChestOnFacilityIdle = close },
    setInventoryFocus: (target) => { inventoryFocus = target },
    setFurnaceFocus: (slot) => { furnaceFocus = slot },
    setFurnaceStatus: (status) => { furnaceStatus = status },
    getEquipmentActionStatus: () => equipmentActionStatus,
    setEquipmentActionStatus: (status) => { equipmentActionStatus = status },
    getInventoryDragSource: () => inventoryDragSource,
    setInventoryDragSource: (source) => { inventoryDragSource = source },
    getMultiplayerInventorySelection: () => multiplayerInventorySelection,
    setMultiplayerInventorySelection: (selection) => { multiplayerInventorySelection = selection },
    hasPendingCrafting: () => pendingCrafting !== null,
    sendInventoryCommand,
    requestCrafting,
    requestAnvil,
    requestEnchanting,
    moveItemMetadata,
    equipmentMetadataKey,
    setEnchantmentSeed: (seed) => { enchantmentSeed = seed },
    getVitalsSnapshot: () => ({ totalExperience: Effect.runSync(world.vitals.snapshot).totalExperience }),
    getInventorySnapshot: () => world.inventory.snapshot,
    restoreVitalsAtExperience: (totalExperience) => {
      const vitals = Effect.runSync(world.vitals.snapshot)
      return Result.map(
        ExperienceDelta.result(totalExperience - vitals.totalExperience),
        (delta) => Effect.runSync(world.vitals.restore(addVitalsExperience(vitals, delta))),
      )
    },
    setAnvilName: (name) => { anvilName = name },
    setAnvilStatus: (status) => { anvilStatus = status },
    setEnchantingStatus: (status) => { enchantingStatus = status },
    getSelectedHotbarIndex: () => selectedHotbarIndex,
    renderHud: (storage, _durabilityBySlot) => renderPlayerHud({
      render: (viewModel) => hud.render(viewModel),
      getHudInput: () => [
        Effect.runSync(world.vitals.snapshot),
        storage.inventory.slots.slice(0, 9).map((slot, slotIndex) => {
          const durability = storage.inventoryDurability[slotIndex] ?? null
          return slot === undefined ? undefined : durability === null ? slot : { ...slot, durability }
        }),
        selectedHotbarIndex,
      ],
      getActiveEffects: () => Effect.runSync(snapshotStatusEffects(gameplayState, gameplayCommit)).effects,
      statusEffectsHud,
      documentBody: document.body,
    }),
    getTotalExperience: () => Effect.runSync(world.vitals.snapshot).totalExperience,
    getExperienceLevel: () => Effect.runSync(world.vitals.view).experienceLevel,
    getEnchantmentSeed: () => enchantmentSeed,
    getAnvilName: () => anvilName,
    getAnvilStatus: () => anvilStatus,
    getEnchantingStatus: () => enchantingStatus,
    getChestSelected: () => chestSelected,
    getChestFocus: () => chestFocus,
    getChestStatus: () => chestStatus,
    getFurnaceFocus: () => furnaceFocus,
    getFurnaceStatus: () => furnaceStatus,
    getInventoryFocus: () => inventoryFocus,
    getActiveChestContainer: (containerId) => Effect.runSync(world.inventory.containerSnapshot(containerId)),
    transferContainerItem: (request) => world.inventory.transferContainerItem(request),
    containerMetadataKey,
    sameItemMetadata,
    copyItemMetadata,
    deleteItemMetadata,
    getActiveFurnaceState: () => activeFurnaceKey === undefined
      ? undefined
      : furnaceStates.get(activeFurnaceKey)?.state,
    getActiveFurnaceKey: () => activeFurnaceKey,
    removeInventoryAt: (slot, item, count) => Effect.map(
      world.inventory.removeAt(slot, item, count),
      (result) => result._tag === 'Removed'
        ? { _tag: 'Removed', removed: result.removed }
        : { _tag: 'Unavailable' },
    ),
    addInventoryItem: (item, count) => world.inventory.add(item, count),
    updateActiveFurnaceState: (state) => {
      if (activeFurnaceKey === undefined) return false
      const current = furnaceStates.get(activeFurnaceKey)
      if (current === undefined) return false
      furnaceStates.set(activeFurnaceKey, { ...current, state })
      return true
    },
    sendFacilityCommand,
    closeTrade: () => setTradeOpen(false),
    isTradeOpen: () => tradeOpen,
    closeBrewing: () => setBrewingOpen(false),
    isBrewingOpen: () => brewingOpen,
    resetPrimaryAttackGesture,
    clearMultiplayerInventorySelection: () => { multiplayerInventorySelection = null },
    markSessionDirty: () => markSessionDirty(),
    getDirtyGeneration: () => dirtyGeneration,
    setDirtyGeneration: (generation) => { dirtyGeneration = generation },
    getSavedGeneration: () => savedGeneration,
    getDebounceTimer: () => debounceTimer,
    setDebounceTimer: (timer) => { debounceTimer = timer },
    scheduleDebounce: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearDebounce: (timer) => window.clearTimeout(timer),
    saveSession: () => {
      // The autosave runs even when nothing changed; only a dirty session's
      // save is shown, so the indicator does not stay up forever.
      const indicate = dirtyGeneration !== savedGeneration
      if (indicate) enterSaveState('saving')
      return saveCoordinator.requestSave().then(
        () => { if (indicate || saveIndicatorStatus.state === 'failed') enterSaveState('saved') },
        (error: unknown) => {
          enterSaveState('failed')
          throw error
        },
      )
    },
    saveDebounceMs: SAVE_DEBOUNCE_MS,
    renderCrosshair: () => renderCrosshair(),
  })
  const {
    inventoryInteraction,
    setInventoryOpen,
    projectedInventoryEnchantedItem,
    inventoryMeleeDamage,
    playerIsDead,
    resetTouchInput,
    syncTouchControls,
    presentSwimmingState,
    setFishingResult,
    targetedBlock,
    fishingEnvironmentAt,
    useEndFeature,
    installInventoryListeners,
    applyPlayerDamage,
    applyWorldExplosion,
  } = inventoryRuntime
  const renderPlayerUi = inventoryRuntime.renderPlayerUi
  let deathDropDimension: SessionState['dimension'] | undefined =
    restoredWorkstations?.deathDropDimension
  const handleLocalPlayerDeath = (): void => handleLocalPlayerDeathUi({
    getPlayerPosition: () => Effect.runSync(world.player.pose).feetPosition,
    getStorageSnapshot: () => Effect.runSync(world.inventory.storageSnapshot),
    customNames,
    enchantedItems,
    getFramesTotal: () => framesTotal,
    spawnDroppedItems: (drops) => Effect.runSync(spawnDroppedItems(ownerBacked.entityManager, drops)),
    getPlayerDimension: () => Effect.runSync(world.player.dimension),
    droppedItemMetadataKey,
    droppedItemMetadata,
    equipmentMetadataKey,
    restoreEmptyStorage: () => Effect.runSync(world.inventory.restoreStorage(emptyPlayerStorage())),
    getVitalsSnapshot: () => Effect.runSync(world.vitals.snapshot),
    restoreVitals: (vitals) => Effect.runSync(world.vitals.restore(vitals)),
    setDeathDropDimension: (dimension) => {
      deathDropDimension = dimension
    },
    markSessionDirty,
  })

  installInventoryListeners()

  // A respawn is a UI action with no caller to return to; a failed bed check
  // leaves the player dead and is reported like a failed screenshot capture.
  const respawnPlayer = (): void => {
    const respawned = respawnPlayerUi({
      resetPrimaryAttackGesture,
      resetBowUse,
      resetProjectileStates: () => {
        projectileRuntimeState = initialProjectileRuntimeState()
        eyeOfEnderRuntimeState = initialEyeOfEnderRuntimeState()
      },
      unmountVehicle: () => {
        if (mountedVehicleId !== undefined) {
          const vehicle = vehicleById(mountedVehicleId)
          if (vehicle !== undefined) Effect.runSync(vehicleService.dismount(vehicle.id, localVehicleOccupant))
          mountedVehicleId = undefined
        }
      },
      cancelFishing: () => {
        if (fishingSession !== undefined) cancelFishing(fishingSession)
        fishingSession = undefined
        fishingWater = undefined
        setFishingResult('idle')
      },
      resetSwimming: () => {
        swimmingState = initialPlayerSwimmingRuntimeState()
        presentSwimmingState()
      },
      respawnVitals: () => {
        if (multiplayer === undefined) Effect.runSync(gameplayState.survivalHunger.respawn)
        else sendVitalsCommand('respawn')
      },
      clearGameplayDeathState: () => {
        Effect.runSync(Ref.set(gameplayState.hostileContactCooldowns, new Map()))
        Effect.runSync(Ref.set(gameplayState.playerDamages, []))
        Effect.runSync(Ref.set(gameplayState.spawnAttempts, []))
        Effect.runSync(Ref.set(gameplayState.mobDrops, []))
        observedMobDrops.splice(0)
      },
      validRespawnLocation: () => validRespawnLocation(respawnLocation, (location) => {
        const context = getOrCreateDimensionChunkContext(location.dimension)
        const reading = Effect.runSync(context.chunkStore.getBlock(location.bedPosition))
        return reading._tag === 'Block'
          ? Result.map(blockTypeOfId(reading.block), (type) => type === 'bed')
          : Result.succeed(false)
      }),
      clearRespawnLocation: () => {
        respawnLocation = null
      },
      leaveSleep: () => {
        sleepRuntimeState = leaveSleep(sleepRuntimeState, multiplayer?.query.player ?? 'local')
      },
      restorePlayerForRespawn: (validRespawn) => {
        const respawnDimension = validRespawn?.dimension ?? initialSpawnDimension
        const respawnPose = validRespawn === null
          ? initialSpawnPose
          : { ...initialSpawnPose, feetPosition: validRespawn.position }
        Effect.runSync(world.player.restore(respawnPose, respawnDimension))
        alignActiveDimension(respawnDimension)
      },
      clearDeathDropDimension: () => {
        deathDropDimension = undefined
      },
      resetSimState,
      setInventoryOpen: (open) => setInventoryOpen(open),
      syncTouchControls,
      renderPlayerUi,
      markSessionDirty,
    })
    if (Result.isFailure(respawned)) console.error('[mc-compose] respawn failed', respawned.failure)
  }

  inventoryRuntime.installRespawnListener(hudParent, respawnPlayer)

  renderPlayerUi()
  renderCrosshair()
  syncTouchControls()

  // -------------------------------------------------------------------------
  // 4a. Durable session publication
  // -------------------------------------------------------------------------

  const { requestFlush, requestBackgroundFlush, markSessionDirty: runtimeMarkSessionDirty } = inventoryRuntime
  markSessionDirty = runtimeMarkSessionDirty

  const applyPlayerSettings = (settings: PlayerSettingsV1): void => {
    applyBindings(settings.bindings)
    if (Result.isSuccess(onboarding)) onboarding.success.render()
    audio.configure(settings)
  }
  let settingsView: ReturnType<typeof createSettingsView>
  settingsView = createSettingsView(document, settingsRoot, {
    onChange: (next) => {
      playerSettingsWrites = queuePlayerSettingsWrite(playerSettingsWrites, next)
      applyPlayerSettings(next)
      document.body.setAttribute('data-player-settings-persistence', 'dirty')
      pauseMenu.clearError()
      settingsView.clearPersistenceError()
      settingsView.reportPersistenceSaving()
      enqueueSettingsWrite(
        settingsWrites,
        () => runStorage(Effect.provide(savePlayerSettings(next), storageContext)),
        () => {
          const settled = playerSettingsWriteSucceeded(playerSettingsWrites, next)
          playerSettingsWrites = settled.writes
          settingsView.reportStoredRecordReplaced()
          if (settled.latest) {
            document.body.setAttribute('data-player-settings-persistence', 'saved')
            pauseMenu.clearError()
            settingsView.reportPersistenceSaved()
          }
        },
        (error) => {
          const settled = playerSettingsWriteFailed(playerSettingsWrites, next)
          playerSettingsWrites = settled.writes
          if (settled.latest) {
            applyPlayerSettings(settled.writes.applied)
            settingsView.replaceSettings(settled.writes.applied)
          }
          document.body.setAttribute('data-player-settings-persistence', 'error')
          const message = 'Settings could not be saved.'
          pauseMenu.reportError(message)
          settingsView.reportPersistenceError(message)
          console.error('[mc-compose] player settings persistence failed', error)
        },
      )
    },
    onClose: () => {
      pauseMenu.closeSettings()
    },
  })

  const pauseMenu = installPlayerPauseMenu({
    deferToFrameBoundary,
    document,
    window,
    parent: pauseRoot,
    canvas,
    gameShell,
    settingsView,
    getPlayerSettings: () => playerSettingsWrites.applied,
    getPaused: () => paused,
    setPaused: (next) => {
      paused = next
      // A paused frame returns before the music update, so the current track
      // and ambient loop are stopped here; the first frame after resuming
      // starts them again through music.update.
      if (next) Effect.runSync(music.stop)
    },
    isBrewingOpen: () => brewingOpen,
    closeBrewing: () => setBrewingOpen(false),
    isTradeOpen: () => tradeOpen,
    closeTrade: () => setTradeOpen(false),
    isInventoryOpen: () => inventoryOpen,
    closeInventory: () => setInventoryOpen(false),
    resetPrimaryAttackGesture,
    resetBowUse,
    renderCrosshair: () => renderCrosshair(),
    syncTouchControls,
    requestFlush,
    drainSettingsWrites: () => drainSettingsWrites(settingsWrites),
    canPause: () => !playerIsDead(),
    clearGameplayInput: () => {
      Effect.runSync(inputApi.clearHeld)
      Effect.runSync(hostGamepad.inputCleared)
      nativeInputQueue = EMPTY_NATIVE_INPUT_QUEUE
      touchLookState = TOUCH_LOOK_CONTROLLER_IDLE
    },
    onFailure: (failure) => console.error('[mc-compose] pause menu failed', failure),
  })
  // The session runs with the defaults, and the next change replaces the
  // unreadable record. The settings dialog repeats the warning on every open
  // until that replacement is saved.
  if (adapters.playerSettingsLoadFailure !== undefined) {
    settingsView.reportLoadFailure()
    pauseMenu.reportError(PLAYER_SETTINGS_LOAD_FAILURE_MESSAGE)
    document.body.setAttribute('data-player-settings-persistence', 'error')
    console.error('[mc-compose] player settings could not be read', adapters.playerSettingsLoadFailure)
  }

  // -------------------------------------------------------------------------
  // 5. QA surface
  // -------------------------------------------------------------------------

  const playerSessionRuntime = createPlayerSessionRuntime({
    getCurrentDimension: () => currentChunkContext.dimension,
    getLocalEntities: () => Effect.runSync(world.entities.snapshot).entities,
    getAuthoritativeEntities: () => [...multiplayerEntities.entries()],
    getProjectileEntities: () => projectileRenderDescriptors(projectileRuntimeState, currentChunkContext.dimension),
    getEyeOfEnderEntities: () => eyeOfEnderRenderDescriptors(eyeOfEnderRuntimeState, currentChunkContext.dimension),
    getWitherEntities: () => witherRenderDescriptors(witherRuntimeState, currentChunkContext.dimension),
    getRemotePlayers: () => [...(multiplayer?.players.entries() ?? [])],
    getVillagerResidents: () => [...villagerResidents.values()],
    isCurrentChunkLoaded: (position) => Result.map(
      blockPositionOfPosition(position),
      (cell) => currentChunkContext.streamLoaded.has(chunkKeyOf(chunkCoordOfBlock(cell))),
    ),
    getEndDragonPhase: () => endDragonSnapshot().phase,
    getEndDragonPosition: endDragonPosition,
    getVehicles: vehicleList,
    syncEntities: (entities) => worldRenderer.syncEntities(entities),
  })
  const { syncRenderedEntities, nearestVillagerForTrade } = playerSessionRuntime

  let stopBrowserPreview: (() => Promise<void>) | undefined
  // `installPlayerQaSurface` registers the dispatch teardown synchronously.
  // Draining the list makes every later call a no-op.
  const qaTeardowns: Array<() => void> = []
  const disposeQaSurface = (): void => {
    for (const dispose of qaTeardowns.splice(0)) dispose()
  }
  const qaInstalled = installPlayerQaSurface({
    render: {
      weather,
      getLightingSnapshot: () => currentChunkContext.lightingSnapshot(),
    },
    // QA-only host namespaces join the composed modules with no layers and no
    // stages, so composeGame checks them against the module namespaces without
    // registering or running anything again.
    makeQaBridge: (namespaces) => Effect.runSync(Effect.result(Effect.map(
      composeGame([
        ...game.modules,
        ...namespaces.map((qa) => ({
          name: `@nerima-games/mc-host-web/qa:${qa.name}`,
          layers: EMPTY_MODULE_LAYER,
          frameStages: [],
          qa,
        })),
      ]),
      (composed) => composed.qaBridge,
    ))),
    gameplay: {
      commit: gameplayCommit,
      targetingEntitiesOwnerId: GAMEPLAY_ENTITIES_OWNER_ID,
      brewingService: gameplayBrewingService,
      world,
      worldRenderer,
      gameplayState,
      simState,
      playerApi,
      currentChunkStore,
      weather,
      vehicleService,
      saveCoordinator,
      multiplayer,
      customNames,
      enchantedItems,
      villagerResidents,
      endPortalFrames,
      portalStates,
      leverStates,
      poweredRails,
      redstoneLampTransitionLog,
      pressurePlateOccupancy,
      pendingItemUses,
      pendingBlockUses,
      observedMobDrops,
      inventoryInteraction,
      redstoneRuntime,
      sessionMetadata,
      isCreativeMode,
      portalLandingSearchBlocks: PORTAL_LANDING_SEARCH_BLOCKS,
      canvas,
      respawnPlayer,
      resetSimState,
      alignActiveDimension,
      markSessionDirty,
      renderPlayerUi,
      applyPlayerDamage,
      streamAround,
      getOrCreateDimensionChunkContext,
      materializePortal,
      registerPortal,
      syncPortalCandidatesFor,
      portalKeyOf,
      leverKeyOf,
      endPortalFrameKey,
      replaceVehicle,
      playerIsDead,
      targetedBlock,
      presentWeather,
      environmentalContactCellsForPose,
      endDragonSnapshot,
      endDragonPosition,
      vehicleList,
      nearestVillagerForTrade,
      survivalHunger: gameplayState.survivalHunger,
      setTradeOpen,
      setBrewingOpen,
      setInventoryOpen,
      setFishingResult,
      deleteItemMetadata,
      getActiveSeed: () => activeSeed,
      getCurrentChunkContext: () => currentChunkContext,
      getSelectedHotbarIndex: () => selectedHotbarIndex,
      setSelectedHotbarIndex: (index) => { selectedHotbarIndex = index },
      setInventoryFocus: (focus) => { inventoryFocus = focus },
      getNextBlockUseRequestId: () => nextBlockUseRequestId,
      setNextBlockUseRequestId: (id) => { nextBlockUseRequestId = id },
      getNextItemUseRequestId: () => nextItemUseRequestId,
      setNextItemUseRequestId: (id) => { nextItemUseRequestId = id },
      getLastObservedItemUse: () => lastObservedItemUse,
      setLastObservedItemUse: (result) => { lastObservedItemUse = result },
      setRedstoneDirty: (dirty) => { redstoneDirty = dirty },
      setFishingSession: (session) => { fishingSession = session },
      setFishingWater: (water) => { fishingWater = water },
      getSwimmingState: () => swimmingState,
      setSwimmingState: (state) => { swimmingState = state },
      setNextEyeOfEnderBreaks: (breaks) => { nextEyeOfEnderBreaks = breaks },
      setEnchantmentSeed: (seed) => { enchantmentSeed = seed },
      getEndPortalComplete: () => endPortalComplete,
      setEndPortalComplete: (complete) => { endPortalComplete = complete },
      getExitPortalMaterialized: () => exitPortalMaterialized,
      getDragonEggRewarded: () => dragonEggRewarded,
      getProjectileRuntimeState: () => projectileRuntimeState,
      getEyeOfEnderRuntimeState: () => eyeOfEnderRuntimeState,
      getWitherRuntimeState: () => witherRuntimeState,
      getEnvironmentalContactDamageState: () => environmentalContactDamageState,
      getSimulationElapsedSecs: () => simulationElapsedSecs,
      getInventoryOpen: () => inventoryOpen,
      getInventoryMode: () => inventoryMode,
      getTradeOpen: () => tradeOpen,
      getActiveVillagerId: () => activeVillagerId,
      getTradeStatus: () => tradeStatus,
      getChestStatus: () => chestStatus,
      getActiveChestId: () => activeChestId,
      getChestFocus: () => chestFocus,
      getChestSelected: () => chestSelected,
      getMultiplayerHandshakeComplete: () => multiplayerHandshakeComplete,
    },
    persistence: {
      requestFlush,
    },
    audio: {
      audio,
      audioBackend: adapters.audioBackend,
      browserClock,
    },
    lifecycle: {
      registerQaTeardown: (dispose) => {
        qaTeardowns.push(dispose)
      },
      getStopBrowserPreview: () => stopBrowserPreview,
      atFrameBoundary: (run) => Effect.runPromise(
        frameBoundary.atFrameBoundary(Effect.try({ try: run, catch: (error) => error })),
      ),
    },
  }, failBoot)
  if (!qaInstalled) return

  const { disposeMultiplayer, disposeRuntime } = installPlayerLifecycle({
    document,
    window,
    autosaveIntervalMs: AUTOSAVE_INTERVAL_MS,
    requestBackgroundFlush,
    resetTouchInput,
    getStopBrowserPreview: () => stopBrowserPreview,
    hasMultiplayer: () => multiplayer !== undefined,
    leaveMultiplayer: () => {
      if (multiplayer === undefined) return
      const leave = encodeFrame({
        _tag: 'PlayerLeave',
        player: multiplayer.query.player,
      })
      const close = multiplayer.transport.state() === 'open' && Result.isSuccess(leave)
        ? multiplayer.transport.send(leave.success).pipe(
            Effect.matchEffect({ onFailure: () => Effect.void, onSuccess: () => Effect.void }),
            Effect.andThen(multiplayer.transport.close),
          )
        : multiplayer.transport.close
      void Effect.runPromise(close)
    },
    pauseMenu,
    settingsView,
    endAudio,
    weatherAudio,
    clearPendingThunder: adapters.clearPendingThunder,
    removeNativeMouseDown: () => window.removeEventListener('mousedown', handleNativeMouseDown, true),
    disposeQaSurface,
    disposeWorldRenderer: () => { Effect.runSync(worldRenderer.dispose) },
    disposeAtlasTexture: () => { atlasTexture.dispose() },
    closeAudio: () => {
      Effect.runSync(music.stop)
      audio.close()
    },
    registerHotDispose: (callback) => {
      const hot = (import.meta as ImportMeta & {
        readonly hot?: { readonly dispose: (handler: () => void) => void }
      }).hot
      hot?.dispose(callback)
    },
  })

  // -------------------------------------------------------------------------
  // 6. The frame
  // -------------------------------------------------------------------------

  const { runFrame, readNow } = createPlayerFramePreparation({
    makeRunFrame: () => game.runFrameWith(BrowserClockLayer),
    readNow: () => Effect.runSync(browserClock.monotonicSecs),
  })

  let previousSecs: MonotonicTimeSecs | undefined
  let framesTotal = 0
  let renderedCaptionSignature: string | undefined

  document.body.setAttribute('data-mc-compose-boot', 'running')

  const tick = (() => {
    const h5aTickContext: H5aTickContext = {
      firstFrameSecs: FIRST_FRAME_SECS,
      clampDelta,
      inputApi,
      state: {
        touchLookState: mutableState(() => touchLookState, (value) => { touchLookState = value }),
        previousSecs: mutableState(() => previousSecs, (value) => { previousSecs = value }),
        simulationElapsedSecs: mutableState(() => simulationElapsedSecs, (value) => { simulationElapsedSecs = value }),
        redstoneDirty: mutableState(() => redstoneDirty, (value) => { redstoneDirty = value }),
        inventoryOpen: mutableState(() => inventoryOpen, (value) => { inventoryOpen = value }),
        tradeOpen: mutableState(() => tradeOpen, (value) => { tradeOpen = value }),
        brewingOpen: mutableState(() => brewingOpen, (value) => { brewingOpen = value }),
        selectedHotbarIndex: mutableState(() => selectedHotbarIndex, (value) => { selectedHotbarIndex = value }),
        vehicleControls: mutableState(() => vehicleControls, (value) => { vehicleControls = value }),
        nativeInputQueue: mutableState(() => nativeInputQueue, (value) => { nativeInputQueue = value }),
        swimmingState: mutableState(() => swimmingState, (value) => { swimmingState = value }),
        fishingSession: mutableState(() => fishingSession, (value) => { fishingSession = value }),
        fishingWater: mutableState(() => fishingWater, (value) => { fishingWater = value }),
        multiplayerHandshakeComplete: mutableState(() => multiplayerHandshakeComplete, (value) => { multiplayerHandshakeComplete = value }),
        multiplayerClosed: mutableState(() => multiplayerClosed, (value) => { multiplayerClosed = value }),
        lastPlayerMoveSent: mutableState(() => lastPlayerMoveSent, (value) => { lastPlayerMoveSent = value }),
        lastPlayerMoveSentAt: mutableState(() => lastPlayerMoveSentAt, (value) => { lastPlayerMoveSentAt = value }),
        nextItemUseRequestId: mutableState(() => nextItemUseRequestId, (value) => { nextItemUseRequestId = value }),
      },
      touchLook: { consume: consumeTouchLook },
      handlePauseRequest: pauseMenu.handleEscape,
      renderCrosshair,
      pointerLock: {
        isLockedToCanvas: () => document.pointerLockElement === canvas,
        exit: () => document.exitPointerLock(),
      },
      paused: () => paused,
      observerPulses,
      multiplayer,
      syncRedstoneSnapshot: () => syncRedstoneSnapshot(currentChunkContext),
      currentChunkContext: () => currentChunkContext,
      world,
      entityManager: ownerBacked.entityManager,
      isCreativeMode,
      survivalHunger: gameplayState.survivalHunger,
      playerIsDead,
      handleLocalPlayerDeath,
      markSessionDirty,
      syncTouchControls,
      setInventoryOpen,
      setBrewingOpen,
      canvas,
      bowInteractionLocked,
      selectedHotbarAfterInput,
      wrapHotbarSelection,
      sendInventorySelection,
      resetPrimaryAttackGesture,
      sendVitalsCommand,
      consumeNativeInput,
      playerSettings: () => playerSettingsWrites.applied,
      lookSensitivity: LOOK_SENSITIVITY,
      playerApi,
      simState,
      currentChunkStore,
      blockPosition: (x, y, z) => blockPosition(BlockAxis(x), BlockAxis(y), BlockAxis(z)),
      eyeLevelOffset: EYE_LEVEL_OFFSET,
      blockTypeOfId,
      mountedVehicleId: () => mountedVehicleId,
      vehicleById,
      advanceSwimming: advancePlayerSwimmingRuntime,
      presentSwimmingState,
      simPhysicsConfig,
      sprintSpeedMPerSec: SPRINT_SPEED_M_PER_S,
      getPlayerMovementSpeedMultiplier,
      gameplayState,
      time,
      targeting: {
        coordinator: hostWorldWrite.coordinator,
        playerOwnerId: GAMEPLAY_PLAYER_OWNER_ID,
        entitiesOwnerId: GAMEPLAY_ENTITIES_OWNER_ID,
      },
      weather,
      syncPortalCandidateSnapshots,
      setFishingResult,
      getOrCreateDimensionChunkContext,
      advanceFishing,
      cancelFishing,
      multiplayerStatus,
      pumpPlayerDamage,
      furnaceStates,
      deferredFurnaceAdvanceSecs,
      pendingFurnaceAdvances,
      requestFurnaceAdvance,
      drainMultiplayerInbound,
      drainCraftingInbound,
      drainAnvilInbound,
      drainEnchantingInbound,
      drainPlayerDamageInbound,
      runFrame,
      drainChunkRenderFaults: () => drainChunkRenderFaults([...dimensionContexts.values()]),
      applyPlayerDamage,
      failBoot,
      droppedItemLifetime,
      droppedItemMetadata,
      droppedItemMetadataKey,
      isDroppedItemBehaviour,
    }
    const h5bTickContext: H5bPostFrameContext = {
      h5a: { ...h5aTickContext, droppedItemMetadata },
      state: {
        blockBreakCounters: mutableState(() => blockBreakCounters, (value) => { blockBreakCounters = value }),
        environmentalContactDamageState: mutableState(
          () => environmentalContactDamageState,
          (value) => { environmentalContactDamageState = value },
        ),
        witherRuntimeState: mutableState(() => witherRuntimeState, (value) => { witherRuntimeState = value }),
        projectileRuntimeState: mutableState(() => projectileRuntimeState, (value) => { projectileRuntimeState = value }),
        eyeOfEnderRuntimeState: mutableState(() => eyeOfEnderRuntimeState, (value) => { eyeOfEnderRuntimeState = value }),
        bowUseState: mutableState(() => bowUseState, (value) => { bowUseState = value }),
        footstepRuntimeState: mutableState(() => footstepRuntimeState, (value) => { footstepRuntimeState = value }),
        nextWitherCommand: mutableState(() => nextWitherCommand, (value) => { nextWitherCommand = value }),
        nextEnderDragonCommand: mutableState(() => nextEnderDragonCommand, (value) => { nextEnderDragonCommand = value }),
        nextMeleeAttackRequestId: mutableState(() => nextMeleeAttackRequestId, (value) => { nextMeleeAttackRequestId = value }),
        miningProgress: mutableState(() => miningProgress, (value) => { miningProgress = value }),
        primaryAttackGestureConsumed: mutableState(
          () => primaryAttackGestureConsumed,
          (value) => { primaryAttackGestureConsumed = value },
        ),
        activeChestId: mutableState(() => activeChestId, (value) => { activeChestId = value }),
        activeFurnaceKey: mutableState(() => activeFurnaceKey, (value) => { activeFurnaceKey = value }),
        tradeStatus: mutableState(() => tradeStatus, (value) => { tradeStatus = value }),
      },
      inventoryMode: () => inventoryMode,
      activeVillagerId: () => activeVillagerId,
      sendVitalsCommand,
      multiplayerEntities,
      dimensionContexts,
      pendingBlockBreakConfirmations,
      pendingMiningToolDamage,
      customNames,
      enchantedItems,
      containerMetadataKey,
      deleteContainerMetadata,
      containerIdAt,
      furnaceKeyOf,
      isDroppedItemPickupEligible,
      droppedItemMetadataFromBehaviour,
      maxStackCountForItem,
      itemStack,
      observeBlockBreakCompletion,
      recordBlockBreakRequest,
      drainVillagerTradeResults,
      drainPlayerDamages,
      drainPlayerHeals,
      villagerTradeStatus,
      renderPlayerUi,
      renderTradeUi,
      enqueueMultiplayerPlayerMove,
      sendEntityCommand,
      applyPortalTravels,
      applyPlayerDamage,
      settleMeleeAttackResults,
      alignActiveDimension,
      resetSimState,
      resolveFallDamage,
      isStandingOnCell,
      pressurePlateOccupancy,
      environmentalContactsForPose,
      isGameplayBlockSolid,
      applyWorldExplosion,
      resetBowUse,
      projectileHud,
      projectedInventoryEnchantedItem,
      durabilityWearWithEnchantments,
      witherRevision: () => witherRevision,
      enderDragonRevision: () => enderDragonRevision,
      endDragonPosition,
      inventoryMeleeDamage,
      requestIdFor,
      canFireBow,
      bowCharge,
      bowDamage,
      bowDamageWithEnchantments,
      advanceFootstepRuntime,
      audio,
      advanceWitherRuntime,
      damageRuntimeWither,
      advanceProjectileRuntime,
      initialProjectileRuntimeState,
      launchRuntimeProjectile,
      recoverProjectile,
      advanceEyeOfEnderRuntime,
      initialEyeOfEnderRuntimeState,
      advanceBowUse,
      resolveBowHits,
      resolveTargetedPrimaryAttack,
      advanceMiningProgress,
      isLegacyGameplayItemType,
      isSwordItem,
      pendingMeleeAttacks,
      projectEnchantedItem,
      miningLootContextForItem,
      requestMeleeAttack,
      requestBlockBreak,
      requestPotatoHarvest,
      pendingItemUses: {
        set: (requestId, pending) => { pendingItemUses.set(requestId, pending) },
      },
      spawnDroppedItems,
    }
    const h5cTickContext: H5cTickContext = {
      h5a: h5aTickContext,
      h5b: h5bTickContext,
      state: {
        framesTotal: mutableState(() => framesTotal, (value) => { framesTotal = value }),
        renderedCaptionSignature: mutableState(
          () => renderedCaptionSignature,
          (value) => { renderedCaptionSignature = value },
        ),
        nextFishingRoll: mutableState(() => nextFishingRoll, (value) => { nextFishingRoll = value }),
        mountedVehicleId: mutableState(() => mountedVehicleId, (value) => { mountedVehicleId = value }),
        activeBrewingStandAt: mutableState(() => activeBrewingStandAt, (value) => { activeBrewingStandAt = value }),
        brewingStatus: mutableState(() => brewingStatus, (value) => { brewingStatus = value }),
        sleepRuntimeState: mutableState(() => sleepRuntimeState, (value) => { sleepRuntimeState = value }),
        respawnLocation: mutableState(() => respawnLocation, (value) => { respawnLocation = value }),
        networkSleepState: mutableState(() => networkSleepState, (value) => { networkSleepState = value }),
        nextSleepRequest: mutableState(() => nextSleepRequest, (value) => { nextSleepRequest = value }),
        appliedNightSkipRevision: mutableState(
          () => appliedNightSkipRevision,
          (value) => { appliedNightSkipRevision = value },
        ),
        multiplayerRejection: mutableState(() => multiplayerRejection, (value) => { multiplayerRejection = value }),
        nextBlockUseRequestId: mutableState(() => nextBlockUseRequestId, (value) => { nextBlockUseRequestId = value }),
        nextBlockPlacementRequestId: mutableState(
          () => nextBlockPlacementRequestId,
          (value) => { nextBlockPlacementRequestId = value },
        ),
        placementsRequested: mutableState(() => placementsRequested, (value) => { placementsRequested = value }),
        dragonEggRewarded: mutableState(() => dragonEggRewarded, (value) => { dragonEggRewarded = value }),
        exitPortalMaterialized: mutableState(() => exitPortalMaterialized, (value) => { exitPortalMaterialized = value }),
        nextMobDropId: mutableState(() => nextMobDropId, (value) => { nextMobDropId = value }),
        lastObservedItemUse: mutableState(() => lastObservedItemUse, (value) => { lastObservedItemUse = value }),
      },
      services: {
        nearestVillagerForTrade,
        setTradeOpen,
        setInventoryOpen,
        targetedBlock,
        fishingEnvironmentAt,
        networkFishingPhase: () => networkFishingState.phase,
        playerSettings: () => playerSettingsWrites.applied,
        vehicleService,
        vehicleList,
        localVehicleOccupant,
        replaceVehicle,
        multiplayerClient: {
          sendVitalsCommand,
          sendPortalUseCommand,
          sendToggleLeverCommand,
          sendEntityCommand,
          sendFacilityCommand,
        },
        endPortalComplete: () => endPortalComplete,
        useEndFeature,
        renderBrewingUi,
        brewingService: gameplayBrewingService,
        time,
        weather,
        redstoneContainerRuntime: {
          syncRedstoneSnapshot,
          containerIdForStorageBlock,
          applyHopperTransfer,
          applyDispenserTrigger,
          applyDropperTrigger,
          applyPoweredPistonTransition,
        },
        redstoneRuntime,
        leverKeyOf,
        asBlockPosition,
        streamAround,
        presentWeather,
        presentWeatherRuntime,
        syncRenderedEntities,
        registerPortal,
        requiredSleepRatio,
        sleepHud,
        endDragonSnapshot,
        adapters: { ...adapters, placementAudio },
        uiFrameState,
        fpsValue,
        captionsParent,
        observedMobDrops,
        pendingItemUses,
        pendingBlockUses,
        pendingBlockPlacements,
        pendingWitherSummonChecks,
        leverStates,
        comparatorModes,
        poweredRails,
        redstoneLampTransitionLog,
        worldWrite: hostWorldWrite.port,
        isGameplayUseItemType,
        isGameplayHoeItem,
        isGameplayIgnitionItem,
        isPlaceableGameplayItem,
      },
    }

    // The browser preview runs this Effect inside the mc-sim GameLoop's frame
    // handler and awaits it before taking the next frame, so the coordinator
    // commits of one frame complete before the next frame starts. A typed
    // failure reaches the preview's frame-failure path, which stops the loop.
    //
    // The frame holds the frame lock throughout and first runs the writes queued
    // since the previous frame (see `frameBoundary`).
    return frameBoundary.frame(Effect.gen(function* () {
      const nowSecs = readNow()
      if (sessionLoading !== undefined) {
        if (sessionLoading.status.progress.kind === 'preparing') reportLoading({ kind: 'ready' })
        const loadingView = loadingScreenView(sessionLoading.status, nowSecs)
        sessionLoading.view.render(loadingView)
        if (loadingView === undefined) sessionLoading = undefined
      }
      saveIndicator.render(saveStatusMessage(saveIndicatorStatus, nowSecs))
      // A rejected axis reading has already released the gamepad's held input;
      // the frame goes on without it rather than stopping the game loop.
      const gamepadPolled = yield* Effect.result(hostGamepad.poll)
      if (Result.isFailure(gamepadPolled)) {
        console.error('[gamepad] axes rejected; gamepad input released', gamepadPolled.failure)
      }
      const frameInput = yield* inputApi.snapshot
      yield* Effect.gen(function* () {
        const frame = runTickFrameInput(h5aTickContext, nowSecs, frameInput)
        if (frame === undefined) return
        const movement = yield* runTickPlayerMovement(h5aTickContext, frame)
        if (movement === undefined) return
        const postFrame = yield* runTickPostFrame(h5bTickContext, { frame, movement, framesTotal })
        yield* runTickPostFrameGameplay(h5cTickContext, { frame, movement, postFrame, nowSecs })
        yield* runFramePresentation(
          { ...h5cTickContext, updateDebugOverlay: debugOverlay.update },
          {
            partialTick: InterpolationFraction(0),
            simulationTick: SimulationTick(0),
            frameDeltaSecs: yield* Effect.fromResult(DeltaTimeSecs.result(frame.raw)),
            nowSecs,
          },
        )
        yield* music.update({
          nowSecs,
          scene: {
            title: false,
            dimension: postFrame.dimensionAfterFrame,
            time: yield* time.snapshot,
            playerPosition: postFrame.postFramePose.feetPosition,
            underwater: swimmingState.fullySubmerged,
            // The host has no combat signal yet, so combat music never starts.
            combat: false,
            creative: isCreativeMode,
          },
          musicEnabled: playerSettingsWrites.applied.audioEnabled,
          musicVolume: MUSIC_VOLUME,
          ambient: null,
        })
      }).pipe(Effect.ensuring(inputApi.endFrame(frameInput)))
    }))
  })()

  const preview = Effect.runSync(makeBrowserPreview({
    container: gameShell,
    canvas,
    startRuntime: (surface) => Effect.sync(() => {
      // A hidden tab runs no frames, so this pump drains the frame-boundary
      // queue itself, under the frame lock, after queueing its own network work.
      const hiddenNetworkPump = window.setInterval(() => {
        if (document.visibilityState !== 'hidden') return
        if (multiplayerInboundStage !== undefined && multiplayerOutboundStage !== undefined) {
          frameBoundary.enqueue(Effect.gen(function* () {
            yield* multiplayerInboundStage.run(DeltaTimeSecs(0)).pipe(Effect.provide(BrowserClockLayer))
            drainMultiplayerInbound()
            drainCraftingInbound()
            drainAnvilInbound()
            drainEnchantingInbound()
            drainPlayerDamageInbound()
            // The hidden-tab pump runs outside the frame runner, so a failed entity
            // sync is reported here like a failed screenshot capture.
            const synced = yield* Effect.result(syncRenderedEntities())
            if (Result.isFailure(synced)) console.error('[mc-compose] hidden-tab entity sync failed', synced.failure)
            enqueueMultiplayerPlayerMove(performance.now() / 1_000)
            yield* multiplayerOutboundStage.run(DeltaTimeSecs(0)).pipe(Effect.provide(BrowserClockLayer))
          }))
        }
        Effect.runFork(frameBoundary.drainOutsideFrame.pipe(Effect.catchCause((cause) => Effect.sync(() => {
          // The same outcome as a failed frame: report it and stop the loop.
          failBoot('a queued world write defected', Cause.squash(cause))
          void stopBrowserPreview?.()
        }))))
      }, 100)
      surface.onCleanup(() => {
        // Preview cleanup runs after the active frame and runtime have stopped.
        bootOwnsGameplayScope = false
        Effect.runSync(Scope.close(gameplayScope, Exit.void))
        window.clearInterval(hiddenNetworkPump)
        canvas.removeEventListener('keydown', handleScreenshotKey)
        unbindDebugOverlayKey()
        debugOverlay.dispose()
        debugMount.remove()
        disposeQaSurface()
        document.body.setAttribute('data-mc-compose-boot', 'stopped')
      })
      return {
        frame: () => tick,
        stop: Effect.sync(() => {
          requestBackgroundFlush()
          disposeMultiplayer()
          disposeRuntime()
        }),
      }
    }),
  }))
  const previewHandle = await Effect.runPromise(preview.start)
  stopBrowserPreview = () => Effect.runPromise(previewHandle.stop)
  bootOwnsGameplayScope = false
  } finally {
    if (bootOwnsGameplayScope) await Effect.runPromise(Scope.close(gameplayScope, Exit.void))
  }
}

const boot = (): Promise<void> => {
  const route = readSessionRoute(window.location.search)
  if (route === undefined) return bootTitle()
  return bootGame(route)
}

boot().catch((error: unknown) => {
  if (error instanceof RequestedSessionNotFoundError) {
    window.location.replace('/?loadError=missing-session')
    return
  }
  failBoot('boot threw', error)
})
