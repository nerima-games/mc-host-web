import { Brand, Effect, Option, Result } from 'effect'
import { SoundCueId } from '@nerima-games/mc-audio'
import {
  BlockAxis,
  BlockId,
  blockIdOf,
  blockPosition,
  blockPositionKeyOf,
  blockPositionOfPosition,
  blockTypeOfId,
  chunkCoordOfBlock,
  position,
  PositionAxis,
  propertyOfBlockId,
  RecipeGridDimension,
  type BlockPosition,
  type BlockRegistryResolutionFailure,
  type ChunkCoord,
  type CoordinateConversionFailure,
  type Position,
  type WorldWriteBlockEdit,
  type WorldWritePort,
} from '@nerima-games/mc-kernel'
import { chunkKeyOf } from '@nerima-games/mc-render'
import {
  detectCompletedEndPortal,
  END_PORTAL_BLOCK,
  END_PORTAL_FRAME_OFFSETS,
  endArrivalDescriptor,
  endPortalCenterForStronghold,
  nearestStrongholdSite,
  NoiseSeed,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import {
  emptyFurnaceState,
  EntityHealthPoints,
  ExperienceLevel,
  STARTER_FUEL_RULES,
  STARTER_SMELTING_RECIPES,
  type FurnaceState,
  type ContainerTransferRequest,
  type ContainerTransferResult,
  type ExplosionBlockPosition,
  type ExplosionPlan,
  type ExplosionValidationFailure,
  type ItemStack,
  itemStack,
  maxStackCountForItem,
  type PlayerStorage,
  type InventoryServiceApi,
  type ItemStackFailure,
  type PlayerStorageFailure,
  type Slot,
  type Vitals as PlayerVitals,
  planExplosion,
  equipmentDefinitionFor,
  totalExperienceAtLevel,
  targetBlockFromPlayerPose,
} from '@nerima-games/mc-sim'
import {
  applyEnchantmentOffer,
  enchantmentOffers,
  fishingPhase,
  DEFAULT_BLOCK_REACH,
  meleeDamageForItem,
  meleeDamageWithEnchantments,
  EYE_LEVEL_OFFSET,
  armorDamageWithEnchantments,
  armorPointsForEquipment,
  armorDurabilityWearFromPreMitigationDamage,
  durabilityWearWithEnchantments,
  type EnchantedItem,
  type EnchantmentOffer,
  type FishingSession,
  type Damage as PlayerDamage,
} from '@nerima-games/mx-gameplay'
import {
  anvilViewModel,
  chestStorageCloseIntent,
  chestStorageSlotClickIntent,
  chestStorageViewModel,
  createAnvilView,
  createChestStorageView,
  createEnchantingTableView,
  createFurnaceView,
  createInventoryView,
  enchantingTableViewModel,
  furnaceViewModel,
  inventoryViewModel,
  inventoryActionTarget,
  type InventoryAction,
  type InventoryActionTarget,
  type InventoryDragTarget,
  type EnchantingTableSnapshot,
  type EquipmentSlotId,
  type FurnaceSnapshot,
  type ChestStorageSlotTarget,
  type FurnaceSlotId,
  type InventoryInteractionTarget,
} from '@nerima-games/mx-ui'
import { chestStorageSlotCount } from './redstone-container-runtime'
import type { NetworkMessage } from '@nerima-games/mx-multiplayer'
import type { MultiplayerInventorySelection, WithoutAuthority } from './multiplayer-client'
import { applyAnvilOperation, enchantedItemFromAnvilOutput, planAnvilOperation, spendExperienceLevels } from '@nerima-games/mc-server/shared'
import { announceInventoryTransition } from './audio-runtime'
import { projectEnchantedItem } from './enchanted-item-state'
import {
  resetTouchLook,
  touchControlsPresentation,
  type TouchLookControllerState,
  type TouchLookResetReason,
} from './touch-input'
import {
  initialPlayerSwimmingRuntimeState,
  MAX_SWIMMING_OXYGEN_SECS,
  type PlayerSwimmingRuntimeState,
} from './player-swimming-runtime'
import { launchRuntimeEyeOfEnder, type EyeOfEnderRuntimeState } from './eye-of-ender-runtime'
import type { DimensionChunkContext } from './chunk-streaming'
import type { PersistedEndPortalFrameState, SessionPosition } from './session-persistence'
import {
  createInventoryInteraction,
  type InventoryInteractionController,
  type InventoryInteractionError,
  type InventoryInteractionInventory,
} from './inventory-interaction'

type FailureOf<R> = R extends Result.Result<unknown, infer E> ? E : never
type BlockTargetFailure = FailureOf<ReturnType<typeof targetBlockFromPlayerPose>>
type ChunkLoadFailure = Effect.Error<ReturnType<DimensionChunkContext['chunkStore']['load']>>
type WorldWriteFailure = Effect.Error<ReturnType<WorldWritePort['Service']['applyBatch']>>
type EndArrivalFailure = ChunkLoadFailure | WorldWriteFailure
type BlockReadingFailure = Brand.BrandError | BlockRegistryResolutionFailure
type TargetedBlockFailure = BlockTargetFailure | CoordinateConversionFailure
type FishingEnvironmentFailure = CoordinateConversionFailure | BlockReadingFailure
type EndFeatureFailure =
  | Brand.BrandError
  | CoordinateConversionFailure
  | TargetedBlockFailure
  | EndArrivalFailure
  | ItemStackFailure
  | PlayerStorageFailure
type WorldExplosionFailure =
  | Brand.BrandError
  | ExplosionValidationFailure
  | BlockRegistryResolutionFailure
  | WorldWriteFailure

// The kernel vocabulary always registers 'air', so the registry lookup cannot be empty.
const AIR_BLOCK = Option.getOrThrow(blockIdOf('air'))
const PLAYER_HURT_CUE = SoundCueId('playerHurt')
const NO_MINIMUM_HEALTH = EntityHealthPoints(0)

// Integer block axes are finite, so every block cell is also a valid continuous position.
const positionOfBlock = (cell: BlockPosition): Position =>
  position(PositionAxis(cell.x), PositionAxis(cell.y), PositionAxis(cell.z))

const blockCellOf = (
  cell: { readonly x: number; readonly y: number; readonly z: number },
): Result.Result<BlockPosition, Brand.BrandError> => Result.gen(function* () {
  return blockPosition(
    yield* BlockAxis.result(cell.x),
    yield* BlockAxis.result(cell.y),
    yield* BlockAxis.result(cell.z),
  )
})

const OVERWORLD_RETURN_POSITION = position(PositionAxis(0.5), PositionAxis(80), PositionAxis(0.5))

const isFrameCell = (
  center: BlockPosition,
  offset: (typeof END_PORTAL_FRAME_OFFSETS)[number],
  cell: BlockPosition,
): boolean =>
  center.x + offset.dx === cell.x && center.y === cell.y && center.z + offset.dz === cell.z

const blockTypeOfReading = (block: number) => Result.flatMap(BlockId.result(block), blockTypeOfId)

// The WorldWritePort rejects a batch that edits one position twice. A later edit
// replaces an earlier one, as it did when the cells were written one at a time.
const uniqueEdits = (edits: ReadonlyArray<WorldWriteBlockEdit>): ReadonlyArray<WorldWriteBlockEdit> =>
  [...new Map(edits.map((edit) => [blockPositionKeyOf(edit.position), edit])).values()]


export type InventoryMode = 'player' | 'craftingTable' | 'furnace' | 'chest' | 'anvil' | 'enchanting'

type InventoryPresentation = {
  readonly label: string
  readonly width: number
  readonly height: number
}

type ContainerSnapshot = {
  readonly slots: ReadonlyArray<(ItemStack & {
    readonly durability?: { readonly current: number; readonly max: number } | null
  }) | null>
}

type BlockReading = { readonly _tag: 'Block'; readonly block: number } | { readonly _tag: 'Unavailable' }

type TargetedBlock = {
  readonly position: Position
  readonly adjacentPosition: Position
  readonly block: number
}

type TargetedCell = { readonly target: TargetedBlock; readonly cell: BlockPosition }

type FishingEnvironment = {
  readonly hasWater: boolean
  readonly hasSkyAccess: boolean
  readonly isRaining: boolean
  readonly isOpenWater: boolean
}

type InventoryRemoval = { readonly _tag: 'Removed'; readonly removed: number } | { readonly _tag: 'Unavailable' }

export type PlayerUiRuntimeContext = {
  readonly document: Document
  readonly window: Pick<Window, 'requestAnimationFrame'>
  readonly canvas: HTMLCanvasElement
  readonly inventoryParent: HTMLElement
  readonly touchControlsParent: HTMLElement
  readonly swimmingHud: HTMLElement
  readonly documentBody: Pick<HTMLElement, 'setAttribute'>
  readonly touchAvailable: boolean
  readonly inventoryPresentations: Readonly<Record<InventoryMode, InventoryPresentation>>
  readonly inventoryView: ReturnType<typeof createInventoryView>
  readonly furnaceView: ReturnType<typeof createFurnaceView>
  readonly chestView: ReturnType<typeof createChestStorageView>
  readonly anvilView: ReturnType<typeof createAnvilView>
  readonly enchantingView: ReturnType<typeof createEnchantingTableView>
  readonly inventoryService: InventoryInteractionInventory
  readonly worldInventory: InventoryServiceApi
  readonly inventoryStorageSnapshot: Effect.Effect<PlayerStorage>
  readonly getPlayerPose: () => Effect.Effect<Parameters<typeof targetBlockFromPlayerPose>[0]>
  readonly getPlayerDimension: () => Effect.Effect<Dimension>
  readonly restorePlayerForDimension: (
    pose: Parameters<typeof targetBlockFromPlayerPose>[0],
    dimension: Dimension,
  ) => Effect.Effect<void>
  readonly getOrCreateDimensionChunkContext: (dimension: Dimension) => DimensionChunkContext
  readonly readBlockAt: (position: BlockPosition) => Effect.Effect<BlockReading>
  readonly getEntitiesForExplosion: () => Parameters<typeof planExplosion>[0]['entities']
  readonly setBlockEffect: (position: BlockPosition, block: BlockId) => Effect.Effect<void, WorldWriteFailure>
  readonly writeBlocks: (
    dimension: Dimension,
    edits: ReadonlyArray<WorldWriteBlockEdit>,
  ) => Effect.Effect<void, WorldWriteFailure>
  readonly resolveExplosionEffects: (effects: ExplosionPlan['entityEffects']) => void
  readonly getActiveSeed: () => number
  readonly endPortalFrames: Map<string, PersistedEndPortalFrameState>
  readonly endPortalFrameKey: (position: SessionPosition) => string
  readonly getEndPortalComplete: () => boolean
  readonly setEndPortalComplete: (complete: boolean) => void
  readonly getExitPortalMaterialized: () => boolean
  readonly getEyeOfEnderRuntimeState: () => EyeOfEnderRuntimeState
  readonly setEyeOfEnderRuntimeState: (state: EyeOfEnderRuntimeState) => void
  readonly getNextEyeOfEnderBreaks: () => boolean | undefined
  readonly setNextEyeOfEnderBreaks: (breaks: boolean | undefined) => void
  readonly sendEndProgressCommand: (
    command:
      | { readonly _tag: 'ThrowEyeOfEnderCommand' }
      | { readonly _tag: 'InsertEyeIntoEndPortalFrameCommand'; readonly frame: Position },
  ) => boolean
  readonly alignActiveDimension: (dimension: Dimension) => void
  readonly queueEndAudio: (event: 'exitPortal' | 'portalActivate' | 'frameInsert' | 'eyeThrow', at: Position) => void
  readonly customNames: Map<string, string>
  readonly enchantedItems: Map<string, EnchantedItem>
  readonly audio: Parameters<typeof announceInventoryTransition>[0]
  readonly getMultiplayer: () => boolean
  readonly getPlayerHealthPoints: () => number
  readonly getVitalsDamageSnapshot: () => PlayerVitals
  readonly applyVitalsDamage: (damage: PlayerDamage) => void
  readonly restoreVitalsDamage: (vitals: PlayerVitals) => void
  readonly isCreativeMode: boolean
  readonly queuePlayerDamage: (amount: number, minimumHealthPoints: number) => void
  readonly handleLocalPlayerDeath: () => void
  readonly setSwimmingState: (state: PlayerSwimmingRuntimeState) => void
  readonly resetSimState: (physicsEnabled: boolean) => void
  readonly getBowInteractionLocked: () => boolean
  readonly getPaused: () => boolean
  readonly getTouchLookState: () => TouchLookControllerState
  readonly setTouchLookState: (state: TouchLookControllerState) => void
  readonly clearHeldInput: () => void
  readonly getSwimmingState: () => PlayerSwimmingRuntimeState
  readonly getFishingSession: () => FishingSession | undefined
  readonly setFishingResultState: (result: string) => void
  readonly getInventoryOpen: () => boolean
  readonly setInventoryOpenState: (open: boolean) => void
  readonly getInventoryMode: () => InventoryMode
  readonly setInventoryMode: (mode: InventoryMode) => void
  readonly getActiveChestId: () => string | undefined
  readonly setActiveChestId: (id: string | undefined) => void
  readonly setChestSelected: (target: ChestStorageSlotTarget | undefined) => void
  readonly setChestFocus: (target: ChestStorageSlotTarget) => void
  readonly setChestStatus: (status: string) => void
  readonly setCloseChestOnFacilityIdle: (close: boolean) => void
  readonly setInventoryFocus: (target: InventoryInteractionTarget) => void
  readonly setFurnaceFocus: (slot: FurnaceSlotId) => void
  readonly setFurnaceStatus: (status: string) => void
  readonly setAnvilName: (name: string) => void
  readonly setAnvilStatus: (status: string) => void
  readonly setEnchantingStatus: (status: string) => void
  readonly getSelectedHotbarIndex: () => number
  readonly getEquipmentActionStatus: () => string
  readonly setEquipmentActionStatus: (status: string) => void
  readonly getInventoryDragSource: () => InventoryDragTarget | undefined
  readonly setInventoryDragSource: (source: InventoryDragTarget | undefined) => void
  readonly getMultiplayerInventorySelection: () => MultiplayerInventorySelection | null
  readonly setMultiplayerInventorySelection: (selection: MultiplayerInventorySelection | null) => void
  readonly hasPendingCrafting: () => boolean
  readonly sendInventoryCommand: (
    action: Extract<NetworkMessage, { readonly _tag: 'PlayerInventoryCommand' }>['action'],
  ) => boolean
  readonly requestCrafting: () => void
  readonly requestAnvil: () => boolean
  readonly requestEnchanting: (slot: 0 | 1 | 2) => boolean
  readonly moveItemMetadata: (source: string, destination: string) => void
  readonly equipmentMetadataKey: (slot: EquipmentSlotId) => string
  readonly setEnchantmentSeed: (seed: number) => void
  readonly getVitalsSnapshot: () => { readonly totalExperience: number }
  readonly getInventorySnapshot: () => Effect.Effect<{ readonly slots: ReadonlyArray<ItemStack | undefined> }>
  readonly restoreVitalsAtExperience: (totalExperience: number) => void
  readonly renderHud: (storage: PlayerStorage, durabilityBySlot: ReadonlyMap<number, number>) => void
  readonly getTotalExperience: () => number
  readonly getExperienceLevel: () => number
  readonly getEnchantmentSeed: () => number
  readonly getAnvilName: () => string
  readonly getAnvilStatus: () => string
  readonly getEnchantingStatus: () => string
  readonly getChestSelected: () => ChestStorageSlotTarget | undefined
  readonly getChestFocus: () => ChestStorageSlotTarget
  readonly getChestStatus: () => string
  readonly getFurnaceFocus: () => FurnaceSlotId
  readonly getFurnaceStatus: () => string
  readonly getInventoryFocus: () => InventoryInteractionTarget
  readonly getActiveChestContainer: (containerId: string) => ContainerSnapshot | null
  readonly transferContainerItem: (request: ContainerTransferRequest) => Effect.Effect<ContainerTransferResult>
  readonly containerMetadataKey: (containerId: string, slot: number) => string
  readonly sameItemMetadata: (left: string, right: string) => boolean
  readonly copyItemMetadata: (source: string, destination: string) => void
  readonly deleteItemMetadata: (key: string) => void
  readonly getActiveFurnaceState: () => FurnaceState | undefined
  readonly getActiveFurnaceKey: () => string | undefined
  readonly removeInventoryAt: (slot: number, item: ItemStack['item'], count: number) => Effect.Effect<InventoryRemoval>
  readonly addInventoryItem: (item: ItemStack['item'], count: number) => Effect.Effect<number>
  readonly updateActiveFurnaceState: (state: FurnaceState) => boolean
  readonly sendFacilityCommand: (
    command: WithoutAuthority<Extract<NetworkMessage, { readonly _tag: 'ContainerCommand' | 'FurnaceCommand' }>>,
  ) => boolean
  readonly closeTrade: () => void
  readonly isTradeOpen: () => boolean
  readonly closeBrewing: () => void
  readonly isBrewingOpen: () => boolean
  readonly resetPrimaryAttackGesture: () => void
  readonly clearMultiplayerInventorySelection: () => void
  readonly markSessionDirty: () => void
  readonly getDirtyGeneration: () => number
  readonly setDirtyGeneration: (generation: number) => void
  readonly getSavedGeneration: () => number
  readonly getDebounceTimer: () => number | undefined
  readonly setDebounceTimer: (timer: number | undefined) => void
  readonly scheduleDebounce: (callback: () => void, delayMs: number) => number
  readonly clearDebounce: (timer: number) => void
  readonly saveSession: () => Promise<void>
  readonly saveDebounceMs: number
  readonly renderCrosshair: () => void
}

export type PlayerUiRuntime = {
  readonly inventoryInteraction: InventoryInteractionController
  readonly setInventoryOpen: (open: boolean, mode?: InventoryMode) => void
  readonly projectedInventoryEnchantedItem: (slotIndex: number) => EnchantedItem | null
  readonly inventoryMeleeDamage: (slotIndex: number) => number
  readonly playerIsDead: () => boolean
  readonly coordinateKey: (x: number, y: number, z: number) => string
  readonly interactionStatus: () => string
  readonly syncTouchControls: () => void
  readonly resetTouchInput: (reason: TouchLookResetReason) => void
  readonly presentSwimmingState: () => void
  readonly setFishingResult: (result: string) => void
  readonly renderPlayerUi: () => void
  readonly targetedBlock: () => Effect.Effect<TargetedBlock | undefined, TargetedBlockFailure>
  readonly fishingEnvironmentAt: (
    position: Position,
    isRaining: boolean,
  ) => Effect.Effect<FishingEnvironment, FishingEnvironmentFailure>
  readonly furnaceTargetOf: (source: EventTarget | null) => FurnaceSlotId | undefined
  readonly chestTargetOf: (source: EventTarget | null) => ChestStorageSlotTarget | undefined
  readonly sameChestTarget: (left: ChestStorageSlotTarget, right: ChestStorageSlotTarget) => boolean
  readonly activateChestSlot: (target: ChestStorageSlotTarget) => void
  readonly activateFurnaceSlot: (slot: FurnaceSlotId) => void
  readonly targetOf: (source: EventTarget | null) => InventoryInteractionTarget | undefined
  readonly focusRenderedTarget: () => void
  readonly activateInventoryTarget: (target: InventoryInteractionTarget, button?: 'left' | 'right') => void
  readonly dispatchInventoryAction: (action: InventoryAction) => void
  readonly installInventoryListeners: () => void
  readonly installRespawnListener: (hudParent: HTMLElement, respawn: () => void) => void
  readonly materializeEndArrival: () => Effect.Effect<void, EndArrivalFailure>
  readonly useEndFeature: () => Effect.Effect<boolean, EndFeatureFailure>
  readonly applyPlayerDamage: (damage: PlayerDamage, minimumHealthPoints?: EntityHealthPoints) => void
  readonly applyWorldExplosion: (
    center: Readonly<{ x: number; y: number; z: number }>,
    radius: number,
    seed: number,
    destroysResistantBlocks: boolean,
  ) => Result.Result<void, WorldExplosionFailure>
  readonly requestFlush: () => Promise<void>
  readonly requestBackgroundFlush: () => void
  readonly flushDirty: () => void
  readonly markSessionDirty: () => void
}

export const createPlayerUiRuntime = (
  context: PlayerUiRuntimeContext,
): PlayerUiRuntime => {
  let carriedEnchantedItem: EnchantedItem | undefined
  let carriedCustomName: string | undefined
  const metadataMatches = (slotIndex: number): boolean => {
    const slotKey = String(slotIndex)
    return JSON.stringify(context.enchantedItems.get(slotKey)) === JSON.stringify(carriedEnchantedItem)
      && context.customNames.get(slotKey) === carriedCustomName
  }
  const inventoryInteraction = createInventoryInteraction(context.inventoryService, {
    canInventoryClick: ({ slotIndex, slotBefore, carriedBefore }) =>
      carriedBefore === undefined || slotBefore === undefined || carriedBefore.item !== slotBefore.item
      || metadataMatches(slotIndex),
    consumeCraftingGrid: true,
    onCrafted: () => context.markSessionDirty(),
    onInventoryChanged: () => context.markSessionDirty(),
    onInventoryReset: () => {
      carriedEnchantedItem = undefined
      carriedCustomName = undefined
    },
    onInventoryTransition: ({ slotIndex, slotBefore, carriedBefore, result }) => {
      const slotKey = String(slotIndex)
      const slotEnchantment = context.enchantedItems.get(slotKey)
      const slotCustomName = context.customNames.get(slotKey)
      if (result._tag === 'PickedUp') {
        carriedEnchantedItem = slotEnchantment
        carriedCustomName = slotCustomName
        if (slotBefore === undefined || result.carried === undefined
          || result.carried.count >= slotBefore.count) {
          context.enchantedItems.delete(slotKey)
          context.customNames.delete(slotKey)
        }
        return
      }
      if (result._tag === 'Placed' || result._tag === 'Merged') {
        if (carriedEnchantedItem === undefined) context.enchantedItems.delete(slotKey)
        else context.enchantedItems.set(slotKey, carriedEnchantedItem)
        if (carriedCustomName === undefined) context.customNames.delete(slotKey)
        else context.customNames.set(slotKey, carriedCustomName)
        if (result.carried === undefined) {
          carriedEnchantedItem = undefined
          carriedCustomName = undefined
        }
        return
      }
      if (result._tag === 'Swapped' && carriedBefore !== undefined) {
        if (carriedEnchantedItem === undefined) context.enchantedItems.delete(slotKey)
        else context.enchantedItems.set(slotKey, carriedEnchantedItem)
        if (carriedCustomName === undefined) context.customNames.delete(slotKey)
        else context.customNames.set(slotKey, carriedCustomName)
        carriedEnchantedItem = slotEnchantment
        carriedCustomName = slotCustomName
      }
    },
  })

  const projectedInventoryEnchantedItem = (slotIndex: number): EnchantedItem | null => {
    const storage = Effect.runSync(context.inventoryStorageSnapshot)
    return projectEnchantedItem(
      storage.inventory.slots[slotIndex],
      storage.inventoryDurability[slotIndex],
      context.enchantedItems.get(String(slotIndex)),
    )
  }
  const inventoryMeleeDamage = (slotIndex: number): number => {
    const storage = Effect.runSync(context.inventoryStorageSnapshot)
    const selectedItem = storage.inventory.slots[slotIndex]?.item ?? null
    // meleeDamageForItem rejects only values outside the item vocabulary; PlayerStorage comes
    // from mc-sim's InventoryService, whose restore paths decode every slot item.
    const baseDamage = Result.getOrThrow(meleeDamageForItem(selectedItem))
    const enchantedItem = projectEnchantedItem(
      storage.inventory.slots[slotIndex],
      storage.inventoryDurability[slotIndex],
      context.enchantedItems.get(String(slotIndex)),
    )
    return enchantedItem === null
      ? baseDamage
      : meleeDamageWithEnchantments(baseDamage, enchantedItem)
  }
  const playerIsDead = (): boolean => context.getPlayerHealthPoints() <= 0
  const coordinateKey = (x: number, y: number, z: number): string => `${x},${y},${z}`
  const interactionStatus = (): string => {
    const equipmentActionStatus = context.getEquipmentActionStatus()
    if (equipmentActionStatus !== '') return equipmentActionStatus
    const status = inventoryInteraction.state().status
    if (status === undefined) return ''
    switch (status._tag) {
      case 'Crafted':
        return `Crafted ${String(status.output.count)} ${status.output.item}`
      case 'MissingIngredients':
        return 'Missing ingredients'
      case 'NoRoom':
        return 'Inventory is full'
      case 'NoMatch':
        return 'No matching recipe'
    }
  }
  let touchControlsVisible = false
  const resetTouchInput = (reason: TouchLookResetReason): void => {
    context.resetPrimaryAttackGesture()
    context.setTouchLookState(resetTouchLook(context.getTouchLookState(), reason))
    context.clearHeldInput()
  }
  const syncTouchControls = (): void => {
    const presentation = touchControlsPresentation({
      touchAvailable: context.touchAvailable,
      playing: true,
      dead: playerIsDead(),
      inventoryOpen: context.getInventoryOpen() || context.isTradeOpen() || context.isBrewingOpen(),
      paused: context.getPaused(),
    })
    const wasVisible = touchControlsVisible
    touchControlsVisible = presentation.visible
    context.touchControlsParent.hidden = !presentation.visible
    context.touchControlsParent.inert = presentation.inert
    context.touchControlsParent.setAttribute('aria-hidden', String(!presentation.visible))
    if (wasVisible && !presentation.visible) resetTouchInput('state-transition')
  }
  const setFishingResult = (result: string): void => {
    context.setFishingResultState(result)
    context.documentBody.setAttribute('data-fishing-result', result)
    const fishingSession = context.getFishingSession()
    context.documentBody.setAttribute(
      'data-fishing-phase',
      fishingSession === undefined ? 'idle' : fishingPhase(fishingSession),
    )
  }
  const presentSwimmingState = (): void => {
    const swimmingState = context.getSwimmingState()
    const oxygen = Math.max(0, Math.ceil(swimmingState.oxygenSecs))
    context.swimmingHud.hidden = !swimmingState.fullySubmerged
    context.swimmingHud.textContent = `Oxygen ${String(oxygen)}/${String(MAX_SWIMMING_OXYGEN_SECS)}`
    context.documentBody.setAttribute('data-swimming', String(swimmingState.active))
    context.documentBody.setAttribute('data-swimming-pose', swimmingState.active ? 'swimming' : 'standing')
    context.documentBody.setAttribute('data-fully-submerged', String(swimmingState.fullySubmerged))
    context.documentBody.setAttribute('data-oxygen-seconds', String(swimmingState.oxygenSecs))
  }
  const renderPlayerUi = (): void => {
    const storage = Effect.runSync(context.inventoryStorageSnapshot)
    const durabilityBySlot = new Map<number, number>()
    storage.inventoryDurability.forEach((durability, slotIndex) => {
      if (durability !== null) {
        durabilityBySlot.set(slotIndex, durability.current / durability.max)
      }
    })
    const equipment = storage.equipment.slots
    const draft = inventoryInteraction.state()
    context.renderHud(storage, durabilityBySlot)
    context.inventoryView.root.style.setProperty(
      'display', ['furnace', 'chest', 'anvil', 'enchanting'].includes(context.getInventoryMode()) ? 'none' : '',
    )
    context.furnaceView.root.style.setProperty('display', context.getInventoryMode() === 'furnace' ? '' : 'none')
    context.chestView.root.style.setProperty('display', context.getInventoryMode() === 'chest' ? '' : 'none')
    context.anvilView.root.style.setProperty('display', context.getInventoryMode() === 'anvil' ? '' : 'none')
    context.enchantingView.root.style.setProperty('display', context.getInventoryMode() === 'enchanting' ? '' : 'none')
    const selectedHotbarIndex = context.getSelectedHotbarIndex()
    const selectedStack = storage.inventory.slots[selectedHotbarIndex]
    const selectedSlotKey = String(selectedHotbarIndex)
    const selectedSlot = selectedStack == null
      ? undefined
      : { itemId: selectedStack.item, count: selectedStack.count }
    if (context.getInventoryMode() === 'anvil') {
      const selectedDurability = storage.inventoryDurability[selectedHotbarIndex] ?? null
      const currentName = context.customNames.get(selectedSlotKey) ?? null
      const enchantedItem = context.enchantedItems.get(selectedSlotKey)
      const anvilName = context.getAnvilName()
      const needsRepair = selectedDurability !== null && selectedDurability.current < selectedDurability.max
      const iron = needsRepair
        ? storage.inventory.slots.find((candidate, index) =>
            index !== selectedHotbarIndex && candidate?.item === 'iron_ingot' && candidate.count > 0,
          )
        : undefined
      const anvilPlan = selectedStack == null
        ? undefined
        : planAnvilOperation({
            item: selectedStack.item,
            durability: selectedDurability,
            name: anvilName,
            currentName,
            ...(enchantedItem === undefined ? {} : { enchantedItem }),
            ...(iron === undefined ? {} : { material: { item: iron.item, count: iron.count } }),
          })
      const levelCost = anvilPlan?.ok === true ? anvilPlan.levelCost : 0
      const materialCost = anvilPlan?.ok === true ? anvilPlan.materialCost : 0
      const hasEnoughExperience = anvilPlan?.ok === true
        && spendExperienceLevels(context.getTotalExperience(), anvilPlan.levelCost) !== undefined
      const rejectionReason = selectedStack == null
        ? 'Select an item in the hotbar'
        : anvilPlan === undefined
          ? 'Anvil operation is invalid'
          : !anvilPlan.ok
            ? anvilPlan.reason === 'incompatible-input' && needsRepair && iron === undefined
              ? 'Requires one iron ingot'
              : anvilPlan.reason === 'nothing-to-do'
                ? 'Change the name or repair a damaged item'
                : anvilPlan.reason === 'too-expensive'
                  ? 'Anvil operation is too expensive'
                  : 'Anvil operation is invalid'
            : !hasEnoughExperience
              ? `Requires level ${levelCost}`
              : undefined
      context.anvilView.render(anvilViewModel({
        primaryInput: selectedSlot,
        secondaryInput: anvilPlan?.ok === true && materialCost > 0 && iron !== undefined
          ? { itemId: iron.item, count: materialCost }
          : undefined,
        output: anvilPlan?.ok === true && hasEnoughExperience
          ? selectedSlot
          : undefined,
        name: anvilName,
        levelCost,
        rejectionReason,
      }), { focusedTarget: 'name', status: context.getAnvilStatus() })
      return
    }
    if (context.getInventoryMode() === 'enchanting') {
      const lapis = storage.inventory.slots.reduce(
        (count, slot) => count + (slot?.item === 'lapis_lazuli' ? slot.count : 0),
        0,
      )
      const item = projectEnchantedItem(
        selectedStack,
        storage.inventoryDurability[selectedHotbarIndex],
        context.enchantedItems.get(selectedSlotKey),
      )
      const playerLevel = context.getExperienceLevel()
      const offerSnapshot = (offer: EnchantmentOffer) => {
        const result = applyEnchantmentOffer({
          seed: context.getEnchantmentSeed(),
          bookshelfCount: 15,
          playerLevel,
          lapis,
          item,
        }, offer)
        return {
          enchantmentId: offer.enchantment.id,
          enchantmentLevel: offer.enchantment.level,
          levelCost: offer.requiredPlayerLevel,
          lapisCost: offer.lapisCost,
          rejectionReason: result.ok ? undefined : result.reason,
        }
      }
      const offers = enchantmentOffers(context.getEnchantmentSeed(), 15)
      const offerSnapshots: EnchantingTableSnapshot['offers'] = Result.isSuccess(offers)
        ? [offerSnapshot(offers.success[0]), offerSnapshot(offers.success[1]), offerSnapshot(offers.success[2])]
        : [undefined, undefined, undefined]
      const snapshot: EnchantingTableSnapshot = {
        item: selectedSlot,
        lapis: lapis > 0 ? { itemId: 'lapis_lazuli', count: lapis } : undefined,
        offers: offerSnapshots,
      }
      context.enchantingView.render(enchantingTableViewModel(snapshot), {
        focusedTarget: 'offer-1',
        status: Result.isFailure(offers)
          ? offers.failure._tag
          : context.getEnchantingStatus(),
      })
      return
    }
    if (context.getInventoryMode() === 'chest') {
      const activeChestId = context.getActiveChestId()
      const container = activeChestId === undefined ? null : context.getActiveChestContainer(activeChestId)
      const slotSnapshot = (
        stack: ItemStack | null | undefined,
        durability: { readonly current: number; readonly max: number } | null | undefined,
      ) => stack == null
        ? undefined
        : {
            item: stack.item,
            count: stack.count,
            durability: durability == null ? undefined : durability.current / durability.max,
          }
      const chestSlots = container?.slots.map((slot) =>
        slotSnapshot(slot, slot?.durability)) ?? Array.from({ length: 27 }, () => undefined)
      const playerSlots = storage.inventory.slots.map((slot, index) =>
        slotSnapshot(slot, storage.inventoryDurability[index]))
      const chestSelected = context.getChestSelected()
      const selectedStack = chestSelected === undefined
        ? undefined
        : chestSelected.region === 'chest'
          ? chestSlots[chestSelected.slot]
          : playerSlots[chestSelected.slot]
      context.chestView.render(chestStorageViewModel({
        chest: chestSlots,
        chestSlotCount: chestStorageSlotCount(container?.slots.length),
        playerInventory: playerSlots,
        cursor: selectedStack,
        selectedSlot: chestSelected,
      }), { focusedSlot: context.getChestFocus(), status: context.getChestStatus() })
      return
    }
    if (context.getInventoryMode() === 'furnace') {
      const furnace = context.getActiveFurnaceState()
      // emptyFurnaceState() with no argument builds a constant default furnace.
      const state = furnace ?? Result.getOrThrow(emptyFurnaceState())
      // STARTER_SMELTING_RECIPES is a package constant built from static recipe data.
      const recipe = Result.getOrThrow(STARTER_SMELTING_RECIPES).find(
        (candidate) => candidate.input === state.input?.item,
      )
      const fuelRule = STARTER_FUEL_RULES.find(
        (candidate) => candidate.item === state.fuel?.item,
      ) ?? STARTER_FUEL_RULES[0]
      const canCook = recipe !== undefined && (
        state.fuelTimeRemainingSecs > 0
        || STARTER_FUEL_RULES.some((candidate) => candidate.item === state.fuel?.item)
      )
      const slot = (stack: Slot): FurnaceSnapshot['input'] =>
        stack === undefined ? undefined : { itemId: stack.item, count: stack.count }
      context.furnaceView.render(furnaceViewModel({
        input: slot(state.input),
        fuel: slot(state.fuel),
        output: slot(state.output),
        cookProgress: canCook && recipe !== undefined
          ? state.cookProgressSecs / recipe.cookDurationSecs
          : 0,
        burnProgress: state.fuelTimeRemainingSecs > 0 && fuelRule !== undefined
          ? state.fuelTimeRemainingSecs / fuelRule.burnDurationSecs
          : 0,
      }), { focusedSlot: context.getFurnaceFocus(), status: context.getFurnaceStatus() })
      return
    }
    context.inventoryView.render(inventoryViewModel({
      inventory: storage.inventory,
      selectedHotbarIndex,
      durabilityBySlot,
      carried: draft.inventoryCarried ?? draft.carried,
      armour: [
        equipment.head ?? undefined,
        equipment.chest ?? undefined,
        equipment.legs ?? undefined,
        equipment.feet ?? undefined,
      ],
      offhand: equipment.offhand,
      crafting: {
        gridWidth: draft.grid.width,
        grid: draft.grid.cells,
        result: draft.preview,
      },
      mergeableSlotIndices: undefined,
    }), {
      focused: context.getInventoryFocus(),
      status: interactionStatus(),
    })
    context.inventoryParent.querySelectorAll<HTMLElement>('[data-mx-ui="slot"][role="button"]')
      .forEach((slot) => slot.setAttribute('draggable', 'true'))
  }
  const targetedCell = (): Effect.Effect<TargetedCell | undefined, TargetedBlockFailure> => Effect.gen(function* () {
    const pose = yield* context.getPlayerPose()
    const candidates: BlockPosition[] = []
    const visited = new Set<string>()
    yield* Effect.fromResult(targetBlockFromPlayerPose(pose, DEFAULT_BLOCK_REACH, (x, y, z) => {
      const key = `${String(x)},${String(y)},${String(z)}`
      if (!visited.has(key)) {
        visited.add(key)
        candidates.push(blockPosition(x, y, z))
      }
      return false
    }))
    const targetable = new Set<string>()
    for (const candidate of candidates) {
      const reading = yield* context.readBlockAt(candidate)
      if (reading._tag === 'Block' && reading.block !== 0) {
        targetable.add(coordinateKey(candidate.x, candidate.y, candidate.z))
        break
      }
    }
    const target = yield* Effect.fromResult(targetBlockFromPlayerPose(
      pose,
      DEFAULT_BLOCK_REACH,
      (x, y, z) => targetable.has(coordinateKey(x, y, z)),
    ))
    if (Option.isNone(target)) return undefined
    const cell = yield* Effect.fromResult(blockPositionOfPosition(target.value.position))
    const reading = yield* context.readBlockAt(cell)
    return reading._tag === 'Block'
      ? { target: { ...target.value, block: reading.block }, cell }
      : undefined
  })
  const targetedBlock = (): Effect.Effect<TargetedBlock | undefined, TargetedBlockFailure> =>
    Effect.map(targetedCell(), (found) => found?.target)
  const nearestStronghold = (feet: Position) => Effect.fromResult(Result.gen(function* () {
    const seed = yield* NoiseSeed.result(context.getActiveSeed())
    const cell = yield* blockPositionOfPosition(feet)
    return nearestStrongholdSite(seed, cell.x, cell.z)
  }))
  const writeCells = (
    dimension: Dimension,
    edits: ReadonlyArray<WorldWriteBlockEdit>,
  ): Effect.Effect<void, WorldWriteFailure> => {
    const unique = uniqueEdits(edits)
    // An explosion can destroy no block, and the port rejects an empty batch.
    return unique.length === 0 ? Effect.void : context.writeBlocks(dimension, unique)
  }
  const materializeEndArrival = (): Effect.Effect<void, EndArrivalFailure> => Effect.gen(function* () {
    const arrival = endArrivalDescriptor(blockPosition(BlockAxis(0), BlockAxis(64), BlockAxis(0)))
    const dimensionContext = context.getOrCreateDimensionChunkContext('end')
    const edits = [
      ...arrival.platform.map(({ at, block }) => ({ position: at, block })),
      ...arrival.clear.map((position) => ({ position, block: AIR_BLOCK })),
    ]
    const chunks = new Map<string, ChunkCoord>()
    for (const edit of edits) {
      const chunk = chunkCoordOfBlock(edit.position)
      chunks.set(chunkKeyOf(chunk), chunk)
    }
    for (const [key, chunk] of chunks) {
      if (!dimensionContext.streamLoaded.has(key)) {
        yield* dimensionContext.chunkStore.load(chunk)
        dimensionContext.streamLoaded.add(key)
      }
    }
    yield* writeCells('end', edits)
    const pose = yield* context.getPlayerPose()
    yield* context.restorePlayerForDimension(
      { ...pose, feetPosition: positionOfBlock(arrival.spawn), yawRadians: Math.PI },
      'end',
    )
    context.alignActiveDimension('end')
    context.resetSimState(true)
    context.markSessionDirty()
  })
  const useEndFeature = (): Effect.Effect<boolean, EndFeatureFailure> => Effect.gen(function* () {
    if (context.getMultiplayer()) {
      const dimension = yield* context.getPlayerDimension()
      const inventory = yield* context.getInventorySnapshot()
      const selected = inventory.slots[context.getSelectedHotbarIndex()]
      if (dimension !== 'overworld' || selected?.item !== 'eye_of_ender') return false
      const found = yield* targetedCell()
      if (found?.target.block === END_PORTAL_BLOCK.FRAME_EMPTY) {
        const pose = yield* context.getPlayerPose()
        const site = yield* nearestStronghold(pose.feetPosition)
        if (Option.isSome(site)) {
          const center = endPortalCenterForStronghold(site.value)
          const offset = END_PORTAL_FRAME_OFFSETS.find((candidate) => isFrameCell(center, candidate, found.cell))
          if (offset !== undefined) {
            return context.sendEndProgressCommand({
              _tag: 'InsertEyeIntoEndPortalFrameCommand',
              frame: found.target.position,
            })
          }
        }
      }
      return context.sendEndProgressCommand({ _tag: 'ThrowEyeOfEnderCommand' })
    }
    const dimension = yield* context.getPlayerDimension()
    const pose = yield* context.getPlayerPose()
    if (dimension === 'end' && context.getExitPortalMaterialized()) {
      const target = yield* targetedBlock()
      if (target?.block === END_PORTAL_BLOCK.PORTAL) {
        yield* context.restorePlayerForDimension({ ...pose, feetPosition: OVERWORLD_RETURN_POSITION }, 'overworld')
        context.alignActiveDimension('overworld')
        context.resetSimState(true)
        context.queueEndAudio('exitPortal', pose.feetPosition)
        context.markSessionDirty()
        return true
      }
    }
    if (dimension === 'overworld' && context.getEndPortalComplete()) {
      const target = yield* targetedBlock()
      if (target?.block === END_PORTAL_BLOCK.PORTAL) {
        yield* materializeEndArrival()
        context.queueEndAudio('portalActivate', target.position)
        return true
      }
    }
    const inventory = yield* context.getInventorySnapshot()
    const selectedHotbarIndex = context.getSelectedHotbarIndex()
    const selected = inventory.slots[selectedHotbarIndex]
    if (dimension !== 'overworld' || selected?.item !== 'eye_of_ender') return false
    const site = yield* nearestStronghold(pose.feetPosition)
    if (Option.isNone(site)) return false
    const center = endPortalCenterForStronghold(site.value)
    const isNearPortal = Math.hypot(
      center.x - pose.feetPosition.x,
      center.y - pose.feetPosition.y,
      center.z - pose.feetPosition.z,
    ) <= DEFAULT_BLOCK_REACH + 4
    const found = isNearPortal ? yield* targetedCell() : undefined
    if (isNearPortal) {
      for (const frameOffset of END_PORTAL_FRAME_OFFSETS) {
        const frameCell = yield* Effect.fromResult(blockCellOf({
          x: center.x + frameOffset.dx,
          y: center.y,
          z: center.z + frameOffset.dz,
        }))
        const reading = yield* context.readBlockAt(frameCell)
        if (reading._tag === 'Block'
          && (reading.block === END_PORTAL_BLOCK.FRAME_EMPTY || reading.block === END_PORTAL_BLOCK.FRAME_FILLED)) {
          context.endPortalFrames.set(context.endPortalFrameKey(frameCell), {
            position: frameCell,
            facing: frameOffset.facing,
            eye: reading.block === END_PORTAL_BLOCK.FRAME_FILLED,
          })
        }
      }
    }
    const offset = found === undefined
      ? undefined
      : END_PORTAL_FRAME_OFFSETS.find((candidate) => isFrameCell(center, candidate, found.cell))
    if (found?.target.block === END_PORTAL_BLOCK.FRAME_EMPTY && offset !== undefined) {
      const target = found.target
      yield* context.setBlockEffect(found.cell, END_PORTAL_BLOCK.FRAME_FILLED)
      context.endPortalFrames.set(context.endPortalFrameKey(target.position), {
        position: target.position,
        facing: offset.facing,
        eye: true,
      })
      if (!context.isCreativeMode) {
        yield* context.worldInventory.removeAt(selectedHotbarIndex, 'eye_of_ender', 1)
      }
      context.queueEndAudio('frameInsert', target.position)
      context.canvas.setAttribute('data-end-portal-progress', String(
        [...context.endPortalFrames.values()].filter((frame) => frame.eye).length,
      ))
      const completed = detectCompletedEndPortal((x, y, z) => {
        const frame = context.endPortalFrames.get(context.endPortalFrameKey({ x, y, z }))
        return frame === undefined
          ? undefined
          : {
              block: frame.eye ? END_PORTAL_BLOCK.FRAME_FILLED : END_PORTAL_BLOCK.FRAME_EMPTY,
              facing: frame.facing,
            }
      }, dimension, center)
      if (Option.isSome(completed)) {
        yield* writeCells(dimension, completed.value.materialization.map(({ at, block }) => ({ position: at, block })))
        context.setEndPortalComplete(true)
        context.queueEndAudio('portalActivate', positionOfBlock(center))
      }
      context.markSessionDirty()
      return true
    }
    const dx = site.value.x - pose.feetPosition.x
    const dz = site.value.z - pose.feetPosition.z
    context.canvas.setAttribute('data-stronghold-direction', String(Math.atan2(dx, -dz)))
    context.canvas.setAttribute('data-stronghold-distance', String(Math.round(Math.hypot(dx, dz))))
    if (!context.isCreativeMode) {
      yield* context.worldInventory.removeAt(selectedHotbarIndex, 'eye_of_ender', 1)
    }
    const breaks = context.getNextEyeOfEnderBreaks() ?? Math.random() < 0.2
    context.setNextEyeOfEnderBreaks(undefined)
    context.setEyeOfEnderRuntimeState(launchRuntimeEyeOfEnder(context.getEyeOfEnderRuntimeState(), {
      dimension,
      position: { ...pose.feetPosition, y: pose.feetPosition.y + EYE_LEVEL_OFFSET },
      target: { x: site.value.x, y: pose.feetPosition.y, z: site.value.z },
      breaks,
    }))
    context.queueEndAudio('eyeThrow', pose.feetPosition)
    context.markSessionDirty()
    return true
  })
  const fishingEnvironmentAt = (
    at: Position,
    isRaining: boolean,
  ): Effect.Effect<FishingEnvironment, FishingEnvironmentFailure> => Effect.gen(function* () {
    const isWater = (reading: BlockReading): Effect.Effect<boolean, BlockReadingFailure> =>
      reading._tag === 'Block'
        ? Effect.map(Effect.fromResult(blockTypeOfReading(reading.block)), (type) => type === 'water')
        : Effect.succeed(false)
    const origin = yield* Effect.fromResult(blockPositionOfPosition(at))
    const hasWater = yield* isWater(yield* context.readBlockAt(origin))
    if (!hasWater) return { hasWater: false, hasSkyAccess: false, isRaining, isOpenWater: false }

    let hasSkyAccess = true
    for (let y = origin.y + 1; y <= 127; y += 1) {
      const reading = yield* context.readBlockAt(yield* Effect.fromResult(blockCellOf({ x: origin.x, y, z: origin.z })))
      if (reading._tag === 'Block' && reading.block !== 0) {
        hasSkyAccess = false
        break
      }
    }

    let isOpenWater = true
    for (let x = origin.x - 2; x <= origin.x + 2 && isOpenWater; x += 1) {
      for (let z = origin.z - 2; z <= origin.z + 2; z += 1) {
        const water = yield* context.readBlockAt(yield* Effect.fromResult(blockCellOf({ x, y: origin.y, z })))
        const above = yield* context.readBlockAt(yield* Effect.fromResult(blockCellOf({ x, y: origin.y + 1, z })))
        if (!(yield* isWater(water)) || above._tag !== 'Block' || above.block !== 0) {
          isOpenWater = false
          break
        }
      }
    }
    return { hasWater, hasSkyAccess, isRaining, isOpenWater }
  })
  const furnaceTargetOf = (source: EventTarget | null): FurnaceSlotId | undefined => {
    if (!(source instanceof Element)) return undefined
    const interactive = source.closest<HTMLElement>(
      '[data-interaction-target="furnace-slot"]',
    )
    if (interactive === null || !context.inventoryParent.contains(interactive)) return undefined
    const slot = interactive.dataset['interactionSlot']
    return slot === 'input' || slot === 'fuel' || slot === 'output' ? slot : undefined
  }
  const chestTargetOf = (source: EventTarget | null): ChestStorageSlotTarget | undefined => {
    if (!(source instanceof Element)) return undefined
    const interactive = source.closest<HTMLElement>(
      '[data-interaction-target="chest-storage-slot"]',
    )
    if (interactive === null || !context.inventoryParent.contains(interactive)) return undefined
    const region = interactive.dataset['interactionRegion']
    const slot = Number(interactive.dataset['interactionSlot'])
    if ((region !== 'chest' && region !== 'player') || !Number.isInteger(slot)) return undefined
    const activeChestId = context.getActiveChestId()
    const container = activeChestId === undefined ? null : context.getActiveChestContainer(activeChestId)
    const intent = chestStorageSlotClickIntent(
      { region, slot },
      chestStorageSlotCount(container?.slots.length),
    )
    return intent?._tag === 'SlotClicked' ? intent.target : undefined
  }
  const sameChestTarget = (
    left: ChestStorageSlotTarget,
    right: ChestStorageSlotTarget,
  ): boolean => left.region === right.region && left.slot === right.slot
  const updateActiveFurnace = (state: FurnaceState): void => {
    if (context.updateActiveFurnaceState(state)) context.markSessionDirty()
  }
  const activateChestSlot = (target: ChestStorageSlotTarget): void => {
    const activeChestId = context.getActiveChestId()
    if (playerIsDead() || context.getBowInteractionLocked() || activeChestId === undefined) return
    context.setChestFocus(target)
    const selected = context.getChestSelected()
    if (selected === undefined) {
      const container = context.getActiveChestContainer(activeChestId)
      const stack = target.region === 'chest'
        ? container?.slots[target.slot]
        : Effect.runSync(context.inventoryStorageSnapshot).inventory.slots[target.slot]
      if (stack == null) {
        context.setChestStatus('Slot is empty')
      } else {
        context.setChestSelected(target)
        context.setChestStatus(`Selected ${stack.item}`)
      }
      renderPlayerUi()
      return
    }
    if (sameChestTarget(selected, target)) {
      context.setChestSelected(undefined)
      context.setChestStatus('Selection cleared')
      renderPlayerUi()
      return
    }
    if (selected.region === target.region) {
      context.setChestStatus('Choose a slot in the other inventory')
      renderPlayerUi()
      return
    }
    const source = selected
    const container = context.getActiveChestContainer(activeChestId)
    const sourceStack = source.region === 'chest'
      ? container?.slots[source.slot]
      : Effect.runSync(context.inventoryStorageSnapshot).inventory.slots[source.slot]
    if (sourceStack == null) {
      context.setChestSelected(undefined)
      context.setChestStatus('Source slot is empty')
      renderPlayerUi()
      return
    }
    const destinationStack = target.region === 'chest'
      ? container?.slots[target.slot]
      : Effect.runSync(context.inventoryStorageSnapshot).inventory.slots[target.slot]
    const sourceMetadataKey = source.region === 'chest'
      ? context.containerMetadataKey(activeChestId, source.slot)
      : String(source.slot)
    const destinationMetadataKey = target.region === 'chest'
      ? context.containerMetadataKey(activeChestId, target.slot)
      : String(target.slot)
    if (
      destinationStack?.item === sourceStack.item
      && !context.sameItemMetadata(sourceMetadataKey, destinationMetadataKey)
    ) {
      context.setChestStatus('Destination contains different item metadata')
      renderPlayerUi()
      return
    }
    if (context.getMultiplayer() && source.region !== target.region) {
      const action = source.region === 'player'
        ? {
            _tag: 'move-item' as const,
            source: { _tag: 'player-slot' as const, slot: source.slot },
            destination: { _tag: 'container-slot' as const, slot: target.slot },
            count: sourceStack.count,
          }
        : {
            _tag: 'move-item' as const,
            source: { _tag: 'container-slot' as const, slot: source.slot },
            destination: { _tag: 'player-slot' as const, slot: target.slot },
            count: sourceStack.count,
          }
      const sent = context.sendFacilityCommand({
        _tag: 'ContainerCommand',
        containerId: activeChestId,
        action,
      })
      context.setChestStatus(sent ? 'Move pending server approval' : 'Another facility action is pending')
      if (sent) context.setChestSelected(undefined)
      renderPlayerUi()
      return
    }
    const result = Effect.runSync(context.transferContainerItem({
      direction: source.region === 'chest' ? 'ContainerToPlayer' : 'PlayerToContainer',
      containerId: activeChestId,
      playerSlot: source.region === 'player' ? source.slot : target.slot,
      containerSlot: source.region === 'chest' ? source.slot : target.slot,
      count: sourceStack.count,
    }))
    if (result._tag === 'Transferred') {
      const remainingSource = source.region === 'chest'
        ? context.getActiveChestContainer(activeChestId)?.slots[source.slot]
        : Effect.runSync(context.inventoryStorageSnapshot).inventory.slots[source.slot]
      context.copyItemMetadata(sourceMetadataKey, destinationMetadataKey)
      if (remainingSource == null) context.deleteItemMetadata(sourceMetadataKey)
      context.setChestSelected(undefined)
      context.setChestStatus(`Moved ${String(result.count)} ${result.item}`)
      context.markSessionDirty()
    } else if (result._tag === 'ContainerNotFound') {
      context.setActiveChestId(undefined)
      context.setChestSelected(undefined)
      setInventoryOpen(false)
      return
    } else {
      context.setChestStatus(result._tag === 'DestinationFull'
        ? 'Destination slot is full'
        : result._tag === 'DestinationMismatch'
          ? 'Destination contains another item'
          : 'Transfer unavailable')
    }
    renderPlayerUi()
  }
  const activateFurnaceSlot = (slot: FurnaceSlotId): void => {
    const activeFurnaceKey = context.getActiveFurnaceKey()
    if (playerIsDead() || context.getBowInteractionLocked() || activeFurnaceKey === undefined) return
    context.setFurnaceFocus(slot)
    context.setFurnaceStatus('')
    const furnace = context.getActiveFurnaceState()
    if (furnace === undefined) return
    if (context.getMultiplayer()) {
      const selected = Effect.runSync(context.inventoryService.snapshot).slots[context.getSelectedHotbarIndex()]
      const stack = slot === 'output' ? furnace.output : selected
      if (stack === null || stack === undefined) {
        context.setFurnaceStatus('Slot is empty')
        renderPlayerUi()
        return
      }
      const selectedHotbarIndex = context.getSelectedHotbarIndex()
      const sent = context.sendFacilityCommand(slot === 'output'
        ? {
            _tag: 'FurnaceCommand',
            furnaceId: activeFurnaceKey,
            action: {
              _tag: 'take-output',
              source: { _tag: 'furnace-slot', slot: 'output' },
              destination: { _tag: 'player-slot', slot: selectedHotbarIndex },
              count: stack.count,
            },
          }
        : {
            _tag: 'FurnaceCommand',
            furnaceId: activeFurnaceKey,
            action: {
              _tag: 'move-item',
              source: { _tag: 'player-slot', slot: selectedHotbarIndex },
              destination: { _tag: 'furnace-slot', slot },
              count: 1,
            },
          })
      context.setFurnaceStatus(sent ? 'Transfer pending server approval' : 'Another facility action is pending')
      renderPlayerUi()
      return
    }
    if (slot === 'output') {
      const output = furnace.output
      if (output !== undefined) {
        const leftover = Effect.runSync(context.addInventoryItem(output.item, output.count))
        const accepted = output.count - leftover
        const remainder: Result.Result<Slot, ItemStackFailure> = accepted === output.count
          ? Result.succeed(undefined)
          : itemStack(output.item, output.count - accepted)
        if (Result.isFailure(remainder)) {
          context.setFurnaceStatus(remainder.failure._tag)
        } else if (accepted > 0) {
          updateActiveFurnace({ ...furnace, output: remainder.success })
        } else {
          context.setFurnaceStatus('Inventory is full')
        }
      }
      renderPlayerUi()
      return
    }

    const selected = Effect.runSync(context.inventoryService.snapshot).slots[context.getSelectedHotbarIndex()]
    const expected = slot === 'input' ? 'raw_iron' : 'coal'
    const current = furnace[slot]
    if (selected?.item !== expected) {
      context.setFurnaceStatus(slot === 'input' ? 'Requires raw iron' : 'Requires coal')
      renderPlayerUi()
      return
    }
    if (current !== undefined && (current.item !== selected.item
      || current.count >= maxStackCountForItem(current.item))) {
      context.setFurnaceStatus('Furnace slot is full')
      renderPlayerUi()
      return
    }
    const nextSlot = itemStack(selected.item, (current?.count ?? 0) + 1)
    if (Result.isFailure(nextSlot)) {
      context.setFurnaceStatus(nextSlot.failure._tag)
      renderPlayerUi()
      return
    }
    const removal = Effect.runSync(context.removeInventoryAt(context.getSelectedHotbarIndex(), selected.item, 1))
    if (removal._tag === 'Removed' && removal.removed > 0) {
      updateActiveFurnace({
        ...furnace,
        [slot]: nextSlot.success,
      })
    }
    renderPlayerUi()
  }
  const targetOf = (source: EventTarget | null): InventoryInteractionTarget | undefined => {
    if (!(source instanceof Element)) return undefined
    const interactive = source.closest<HTMLElement>('[role="button"]')
    if (interactive === null || !context.inventoryParent.contains(interactive)) return undefined
    if (interactive.matches('[data-mx-ui="crafting-output"]')) {
      return { kind: 'crafting-output' }
    }
    if (!interactive.matches('[data-mx-ui="slot"]')) return undefined
    const region = interactive.closest<HTMLElement>('[data-region]')?.dataset['region']
    const index = Number(interactive.dataset['slotIndex'])
    if (
      !Number.isInteger(index) ||
      (region !== 'hotbar' && region !== 'main' && region !== 'crafting-grid'
        && region !== 'armour' && region !== 'offhand')
    ) {
      return undefined
    }
    return { kind: 'slot', region, index }
  }
  const focusRenderedTarget = (): void => {
    const inventoryMode = context.getInventoryMode()
    const activeScreen = inventoryMode === 'furnace'
      ? 'furnace'
      : inventoryMode === 'chest'
        ? 'chest-storage'
        : 'inventory'
    context.inventoryParent.querySelector<HTMLElement>(
      `[data-mx-ui="${activeScreen}"] [role="button"][tabindex="0"]`,
    )?.focus()
  }
  const applyPlayerDamage = (
    damage: PlayerDamage,
    minimumHealthPoints: EntityHealthPoints = NO_MINIMUM_HEALTH,
  ): void => {
    if (context.isCreativeMode) return
    const equipment = Effect.runSync(context.worldInventory.equipmentSnapshot)
    const enchantedArmor = (['head', 'chest', 'legs', 'feet'] as const).flatMap((slot) => {
      const equippedItem = equipment.slots[slot]
      if (equippedItem === null) return []
      const projected = projectEnchantedItem(
        equippedItem,
        equippedItem.durability ?? undefined,
        context.enchantedItems.get(context.equipmentMetadataKey(slot)),
      )
      return projected === null ? [] : [projected]
    })
    const reducedDamage = armorDamageWithEnchantments(
      damage,
      armorPointsForEquipment(equipment),
      enchantedArmor,
    )
    if (context.getMultiplayer()) {
      if (reducedDamage.amount > 0) {
        context.queuePlayerDamage(reducedDamage.amount, minimumHealthPoints)
      }
      return
    }
    const healthBefore = context.getPlayerHealthPoints()
    context.applyVitalsDamage(reducedDamage)
    const damagedVitals = context.getVitalsDamageSnapshot()
    if (damagedVitals.healthPoints < minimumHealthPoints) {
      context.restoreVitalsDamage({ ...damagedVitals, healthPoints: minimumHealthPoints })
    }
    const healthAfter = context.getPlayerHealthPoints()
    if (healthAfter < healthBefore) {
      const wear = armorDurabilityWearFromPreMitigationDamage(damage)
      if (wear > 0) {
        for (const slot of ['head', 'chest', 'legs', 'feet'] as const) {
          if (equipment.slots[slot] !== null) {
            const enchantedItem = enchantedArmor.find(
              (item) => item.item === equipment.slots[slot]?.item,
            )
            const appliedWear = enchantedItem === undefined
              ? wear
              : durabilityWearWithEnchantments(
                  wear,
                  enchantedItem,
                  Array.from({ length: wear }, () => Math.random()),
                )
            if (appliedWear === 0) continue
            const result = Effect.runSync(
              context.worldInventory.damageAt({ _tag: 'Equipment', slot }, appliedWear),
            )
            if (result._tag === 'Broken') {
              context.enchantedItems.delete(context.equipmentMetadataKey(slot))
              context.customNames.delete(context.equipmentMetadataKey(slot))
            }
          }
        }
      }
      context.audio.play(PLAYER_HURT_CUE)
    }
    if (healthBefore > 0 && playerIsDead() && !context.getMultiplayer()) {
      context.handleLocalPlayerDeath()
    }
    if (playerIsDead()) {
      context.setSwimmingState(initialPlayerSwimmingRuntimeState())
      presentSwimmingState()
      context.resetPrimaryAttackGesture()
      context.resetSimState(false)
    }
    syncTouchControls()
  }
  const explosionBlockAt = (cell: ExplosionBlockPosition, destroysResistantBlocks: boolean) =>
    Result.gen(function* () {
      const reading = Effect.runSync(context.readBlockAt(yield* blockCellOf(cell)))
      if (reading._tag !== 'Block') return undefined
      const block = yield* BlockId.result(reading.block)
      const type = yield* blockTypeOfId(block)
      if (type === 'air') return { resistance: 0, destructible: false }
      const hardness = yield* propertyOfBlockId(block, 'hardness')
      return {
        resistance: destroysResistantBlocks ? 0 : hardness,
        destructible: type !== 'bedrock',
      }
    })
  const applyWorldExplosion = (
    center: Readonly<{ x: number; y: number; z: number }>,
    radius: number,
    seed: number,
    destroysResistantBlocks: boolean,
  ): Result.Result<void, WorldExplosionFailure> => {
    // planExplosion's block reader is synchronous and has no failure channel, so the first
    // read failure is kept here and returned instead of applying a plan over unreadable cells.
    const readFailures: Array<WorldExplosionFailure> = []
    const planned = Result.gen(function* () {
      const plan = yield* planExplosion({
        center: position(
          yield* PositionAxis.result(center.x),
          yield* PositionAxis.result(center.y),
          yield* PositionAxis.result(center.z),
        ),
        radius,
        seed,
        blocks: (cell) => {
          if (readFailures.length > 0) return undefined
          const block = explosionBlockAt(cell, destroysResistantBlocks)
          if (Result.isSuccess(block)) return block.success
          readFailures.push(block.failure)
          return undefined
        },
        entities: context.getEntitiesForExplosion(),
      })
      const readFailure = readFailures[0]
      if (readFailure !== undefined) return yield* Result.fail(readFailure)
      return { plan, destroyed: yield* Result.all(plan.destroyedBlocks.map(blockCellOf)) }
    })
    const explosion = Effect.gen(function* () {
      const { plan, destroyed } = yield* Effect.fromResult(planned)
      yield* writeCells(
        yield* context.getPlayerDimension(),
        destroyed.map((cell) => ({ position: cell, block: AIR_BLOCK })),
      )
      context.resolveExplosionEffects(plan.entityEffects)
      const playerPosition = (yield* context.getPlayerPose()).feetPosition
      const playerDistance = Math.hypot(
        playerPosition.x - center.x,
        playerPosition.y + 0.9 - center.y,
        playerPosition.z - center.z,
      )
      if (playerDistance < radius) {
        const exposure = 1 - playerDistance / radius
        applyPlayerDamage({
          amount: ((exposure * exposure + exposure) / 2) * 7 * radius + 1,
          cause: 'generic',
        })
      }
      context.markSessionDirty()
    })
    return Effect.runSync(Effect.result(explosion))
  }

  const inventorySlotOf = (target: InventoryActionTarget): number | undefined => {
    if (target.kind !== 'slot') return undefined
    if (target.region === 'hotbar') return target.index
    if (target.region === 'main') return 9 + target.index
    return undefined
  }
  // Pointer and close interactions never set data-equipment-action, so their failures
  // show only the status text. The next successful interaction clears that text unless
  // a dispatched action has replaced it since.
  let interactionRejection: string | undefined
  const rejectInventoryAction = (_action: InventoryAction, reason: string): void => {
    interactionRejection = undefined
    context.setEquipmentActionStatus(reason)
    context.documentBody.setAttribute('data-equipment-action', `rejected:${reason}`)
    renderPlayerUi()
  }
  const settledInventoryInteraction = (result: Result.Result<unknown, InventoryInteractionError>): boolean => {
    if (Result.isFailure(result)) {
      interactionRejection = result.failure._tag
      context.setEquipmentActionStatus(result.failure._tag)
      return false
    }
    if (interactionRejection !== undefined && context.getEquipmentActionStatus() === interactionRejection) {
      context.setEquipmentActionStatus('')
    }
    interactionRejection = undefined
    return true
  }
  const completeInventoryAction = (): void => {
    context.setEquipmentActionStatus('')
    context.documentBody.setAttribute('data-equipment-action', 'accepted')
    context.markSessionDirty()
    renderPlayerUi()
  }
  const unequip = (
    action: InventoryAction,
    slot: EquipmentSlotId,
    inventorySlot?: number,
  ): void => {
    if (context.getMultiplayer()) {
      const command = inventorySlot === undefined
        ? { _tag: 'unequip-item' as const, equipmentSlot: slot }
        : { _tag: 'unequip-item' as const, equipmentSlot: slot, destination: inventorySlot }
      if (!context.sendInventoryCommand(command)) {
        rejectInventoryAction(action, 'Inventory update is pending')
        return
      }
      context.setEquipmentActionStatus('')
      context.documentBody.setAttribute('data-equipment-action', 'pending')
      renderPlayerUi()
      return
    }
    const result = Effect.runSync(context.worldInventory.unequipToInventory(slot, inventorySlot))
    if (result._tag === 'Unequipped') {
      context.moveItemMetadata(context.equipmentMetadataKey(slot), String(result.slotIndex))
      completeInventoryAction()
    }
    else rejectInventoryAction(action, result._tag === 'Empty'
      ? 'Equipment slot is empty'
      : result._tag === 'OccupiedInventorySlot'
        ? 'Inventory slot is occupied'
        : result._tag === 'InventoryFull'
          ? 'Inventory is full'
          : 'Invalid equipment action')
  }
  const equip = (
    action: InventoryAction,
    inventorySlot: number,
    equipmentSlot: EquipmentSlotId,
  ): void => {
    if (context.getMultiplayer()) {
      if (!context.sendInventoryCommand({ _tag: 'equip-item', source: inventorySlot, equipmentSlot })) {
        rejectInventoryAction(action, 'Inventory update is pending')
        return
      }
      context.setEquipmentActionStatus('')
      context.documentBody.setAttribute('data-equipment-action', 'pending')
      renderPlayerUi()
      return
    }
    const result = Effect.runSync(context.worldInventory.equipFromInventory(inventorySlot, equipmentSlot))
    if (result._tag === 'Equipped') {
      context.moveItemMetadata(String(inventorySlot), context.equipmentMetadataKey(equipmentSlot))
      completeInventoryAction()
    }
    else rejectInventoryAction(action, result._tag === 'Empty'
      ? 'Inventory slot is empty'
      : result._tag === 'Occupied'
        ? 'Equipment slot is occupied'
        : result._tag === 'Incompatible'
          ? `Item cannot be equipped in ${equipmentSlot}`
          : 'Invalid equipment action')
  }
  const moveInventoryItem = (
    action: InventoryAction,
    source: number,
    destination: number,
    requestedCount?: number,
  ): boolean => {
    if (source === destination) {
      rejectInventoryAction(action, 'Source and destination are the same slot')
      return false
    }
    const inventory = Effect.runSync(context.getInventorySnapshot())
    const sourceStack = inventory.slots[source]
    const destinationStack = inventory.slots[destination]
    if (sourceStack === undefined) {
      rejectInventoryAction(action, 'Source slot is empty')
      return false
    }
    if (context.getMultiplayer()) {
      if (requestedCount !== undefined && destinationStack !== undefined && destinationStack.item !== sourceStack.item) {
        rejectInventoryAction(action, 'Destination contains another item')
        return false
      }
      const count = Math.min(
        requestedCount ?? sourceStack.count,
        sourceStack.count,
        destinationStack === undefined
          ? sourceStack.count
          : maxStackCountForItem(sourceStack.item) - destinationStack.count,
      )
      const command = requestedCount === undefined && destinationStack !== undefined && destinationStack.item !== sourceStack.item
        ? { _tag: 'swap-items' as const, source, destination }
        : {
          _tag: 'move-item' as const,
          source,
          destination,
          count,
        }
      if ('count' in command && command.count <= 0) {
        rejectInventoryAction(action, 'Destination stack is full')
        return false
      }
      if (!context.sendInventoryCommand(command)) {
        rejectInventoryAction(action, 'Inventory update is pending')
        return false
      }
      context.setEquipmentActionStatus('')
      context.documentBody.setAttribute('data-equipment-action', 'pending')
      renderPlayerUi()
      return true
    }
    if (inventoryInteraction.state().inventoryCarried !== undefined) {
      rejectInventoryAction(action, 'Place the carried stack first')
      return false
    }
    const pickedUp = Effect.runSync(Effect.result(inventoryInteraction.clickInventoryItem(source, 'left')))
    if (Result.isFailure(pickedUp)) {
      rejectInventoryAction(action, pickedUp.failure._tag)
      return false
    }
    const placed = Effect.runSync(Effect.result(inventoryInteraction.clickInventoryItem(destination, 'left')))
    if (Result.isFailure(placed)) {
      rejectInventoryAction(action, placed.failure._tag)
      return false
    }
    completeInventoryAction()
    return true
  }
  const dispatchInventoryAction = (action: InventoryAction): void => {
    if (action.kind === 'drag') {
      if (action.source.kind === 'slot' && action.target.kind === 'equipment-slot') {
        const sourceSlot = inventorySlotOf(action.source)
        if (sourceSlot !== undefined) equip(action, sourceSlot, action.target.slot)
        else rejectInventoryAction(action, 'Crafting slots cannot equip items')
        return
      }
      if (action.source.kind === 'equipment-slot' && action.target.kind === 'slot') {
        const targetSlot = inventorySlotOf(action.target)
        if (targetSlot !== undefined) unequip(action, action.source.slot, targetSlot)
        else rejectInventoryAction(action, 'Equipment cannot move to crafting slots')
        return
      }
      if (action.source.kind === 'slot' && action.target.kind === 'slot') {
        const sourceSlot = inventorySlotOf(action.source)
        const targetSlot = inventorySlotOf(action.target)
        if (sourceSlot !== undefined && action.target.region === 'crafting-grid') {
          if (context.getMultiplayer()) {
            rejectInventoryAction(action, 'Crafting drag is unavailable in multiplayer')
          } else if (context.hasPendingCrafting()) {
            rejectInventoryAction(action, 'Crafting update is pending')
          } else if (inventoryInteraction.state().inventoryCarried !== undefined) {
            rejectInventoryAction(action, 'Place the carried stack first')
          } else {
            const pickedUp = Effect.runSync(Effect.result(inventoryInteraction.clickInventoryItem(sourceSlot, 'left')))
            const placed = Result.isFailure(pickedUp)
              ? pickedUp
              : Effect.runSync(Effect.result(inventoryInteraction.interactCraftingCellFromInventory(action.target.index)))
            if (Result.isFailure(placed)) {
              rejectInventoryAction(action, placed.failure._tag)
            } else {
              Effect.runSync(inventoryInteraction.preview())
              completeInventoryAction()
            }
          }
          return
        }
        if (sourceSlot === undefined || targetSlot === undefined) {
          rejectInventoryAction(action, 'Crafting slots cannot move inventory items')
        } else {
          moveInventoryItem(action, sourceSlot, targetSlot)
        }
        return
      }
      rejectInventoryAction(action, 'Drag between these slots is not supported')
      return
    }
    if (action.target.kind === 'equipment-slot') {
      unequip(action, action.target.slot)
      return
    }
    if (action.kind === 'shift-click') {
      const inventorySlot = inventorySlotOf(action.target)
      const stack = inventorySlot === undefined
        ? undefined
        : Effect.runSync(context.getInventorySnapshot()).slots[inventorySlot]
      const equipmentSlot = stack === undefined ? undefined : equipmentDefinitionFor(stack.item)?.slot
      if (inventorySlot === undefined || equipmentSlot === undefined) {
        rejectInventoryAction(action, 'Item cannot be equipped')
      } else {
        equip(action, inventorySlot, equipmentSlot)
      }
      return
    }
    context.setEquipmentActionStatus('')
    activateInventoryTarget(action.target)
  }
  const activateInventoryTarget = (
    target: InventoryInteractionTarget,
    button: 'left' | 'right' = 'left',
  ): void => {
    if (playerIsDead() || context.getBowInteractionLocked()) return
    context.setInventoryFocus(target)
    const inventorySlot = target.kind !== 'slot'
      ? undefined
      : target.region === 'hotbar'
        ? target.index
        : target.region === 'main'
          ? 9 + target.index
          : undefined
    const actionTarget = inventoryActionTarget(target)
    if (context.getMultiplayer() && inventorySlot !== undefined && actionTarget !== null) {
      const selection = context.getMultiplayerInventorySelection()
      const sourceStack = Effect.runSync(context.getInventorySnapshot()).slots[inventorySlot]
      if (selection === null) {
        if (sourceStack === undefined) {
          context.setEquipmentActionStatus('Source slot is empty')
          context.documentBody.setAttribute('data-equipment-action', 'rejected:source-empty')
        } else {
          context.setMultiplayerInventorySelection({
            source: inventorySlot,
            remaining: button === 'right' ? Math.ceil(sourceStack.count / 2) : sourceStack.count,
            mode: button === 'right' ? 'split' : 'all',
          })
          context.setEquipmentActionStatus(button === 'right'
            ? 'Select destinations to place one item each'
            : 'Select an inventory destination')
          context.documentBody.setAttribute('data-equipment-action', 'selecting')
        }
      } else if (selection.source === inventorySlot) {
        context.setMultiplayerInventorySelection(null)
        context.setEquipmentActionStatus('')
        context.documentBody.setAttribute('data-equipment-action', 'accepted')
      } else {
        const moved = selection.mode === 'split'
          ? button === 'right' ? 1 : selection.remaining
          : undefined
        if (moveInventoryItem({ kind: 'click', target: actionTarget }, selection.source, inventorySlot, moved)) {
          const remaining = moved === undefined ? 0 : selection.remaining - moved
          context.setMultiplayerInventorySelection(remaining > 0 ? { ...selection, remaining } : null)
        }
      }
      renderPlayerUi()
      return
    }
    if (target.kind === 'crafting-output') {
      if (!context.getMultiplayer()) settledInventoryInteraction(Effect.runSync(Effect.result(inventoryInteraction.craftOnce())))
      else context.requestCrafting()
    } else if (target.region === 'crafting-grid') {
      if (context.hasPendingCrafting()) return
      if (
        context.getMultiplayer()
        && context.getMultiplayerInventorySelection() !== null
        && inventoryInteraction.state().carried === undefined
      ) {
        const selection = context.getMultiplayerInventorySelection()
        if (selection === null) return
        const pickedUp = Effect.runSync(Effect.result(inventoryInteraction.pickupInventoryItem(selection.source)))
        const placed = Result.isFailure(pickedUp)
          ? pickedUp
          : Effect.runSync(Effect.result(inventoryInteraction.interactCraftingCellFromInventory(target.index)))
        if (settledInventoryInteraction(placed)) {
          const remaining = selection.remaining - 1
          context.setMultiplayerInventorySelection(remaining > 0 ? { ...selection, remaining } : null)
          context.setEquipmentActionStatus('')
          context.documentBody.setAttribute('data-equipment-action', 'accepted')
        }
      } else {
        settledInventoryInteraction(
          Effect.runSync(Effect.result(inventoryInteraction.interactCraftingCellFromInventory(target.index))),
        )
      }
      Effect.runSync(inventoryInteraction.preview())
    } else if (target.region === 'hotbar') {
      settledInventoryInteraction(Effect.runSync(Effect.result(inventoryInteraction.clickInventoryItem(target.index, button))))
    } else if (target.region === 'main') {
      settledInventoryInteraction(Effect.runSync(Effect.result(inventoryInteraction.clickInventoryItem(9 + target.index, button))))
    }
    renderPlayerUi()
  }
  const removeInventoryItem = (
    item: ItemStack['item'],
    count: number,
  ): Result.Result<boolean, ItemStackFailure | PlayerStorageFailure> => {
    if (!Number.isSafeInteger(count) || count < 0) return Result.succeed(false)
    if (count === 0) return Result.succeed(true)
    const slots = Effect.runSync(context.getInventorySnapshot()).slots
    const available = slots.reduce(
      (total, stack) => total + (stack?.item === item ? stack.count : 0),
      0,
    )
    if (available < count) return Result.succeed(false)
    let remaining = count
    for (let index = 0; index < slots.length && remaining > 0; index += 1) {
      const stack = slots[index]
      if (stack?.item !== item) continue
      const removed = Math.min(stack.count, remaining)
      const removal = Effect.runSync(Effect.result(context.worldInventory.removeAt(index, item, removed)))
      if (Result.isFailure(removal)) return Result.fail(removal.failure)
      remaining -= removed
    }
    return Result.succeed(remaining === 0)
  }
  const activateAnvilOutput = (): void => {
    if (context.getMultiplayer()) {
      context.setAnvilStatus(context.requestAnvil()
        ? 'Applying anvil operation...'
        : 'Anvil operation is unavailable')
      renderPlayerUi()
      return
    }
    const storage = Effect.runSync(context.inventoryStorageSnapshot)
    const selectedHotbarIndex = context.getSelectedHotbarIndex()
    const selected = storage.inventory.slots[selectedHotbarIndex]
    const vitals = context.getVitalsSnapshot()
    const normalizedName = context.getAnvilName().trim()
    const itemKey = String(selectedHotbarIndex)
    const currentName = context.customNames.get(itemKey) ?? null
    const existingEnchantment = context.enchantedItems.get(itemKey)
    const anvilResult = selected == null
      ? undefined
      : applyAnvilOperation(storage, selectedHotbarIndex, {
          name: normalizedName,
          currentName,
          ...(existingEnchantment === undefined ? {} : { enchantedItem: existingEnchantment }),
        })
    const remainingExperience = anvilResult === undefined
      ? undefined
      : spendExperienceLevels(vitals.totalExperience, anvilResult.levelCost)
    if (selected == null || anvilResult === undefined || remainingExperience === undefined) {
      context.setAnvilStatus('Repair or rename requirements are not met')
      renderPlayerUi()
      return
    }
    const outputName = anvilResult.output.customName === null
      ? null
      : String(anvilResult.output.customName)
    const outputEnchantment = enchantedItemFromAnvilOutput(anvilResult.output)
    if (anvilResult.output.enchantments.length > 0 && outputEnchantment === undefined) {
      context.setAnvilStatus('Anvil operation is invalid')
      renderPlayerUi()
      return
    }
    const restored = Effect.runSync(Effect.result(context.worldInventory.restoreStorage(anvilResult.storage)))
    if (Result.isFailure(restored)) {
      context.setAnvilStatus(restored.failure._tag)
      renderPlayerUi()
      return
    }
    context.restoreVitalsAtExperience(remainingExperience)
    if (outputEnchantment === undefined) context.enchantedItems.delete(itemKey)
    else context.enchantedItems.set(itemKey, outputEnchantment)
    if (outputName === null) context.customNames.delete(itemKey)
    else context.customNames.set(itemKey, outputName)
    const status = outputName === null ? 'Item repaired' : `Renamed to ${outputName}`
    context.setAnvilStatus(status)
    context.documentBody.setAttribute('data-anvil-result', status)
    context.markSessionDirty()
    renderPlayerUi()
  }
  const activateEnchantingOffer = (slot: 0 | 1 | 2): void => {
    if (context.getMultiplayer()) {
      context.setEnchantingStatus(context.requestEnchanting(slot)
        ? 'Applying enchantment...'
        : 'Enchanting is unavailable')
      renderPlayerUi()
      return
    }
    const storage = Effect.runSync(context.inventoryStorageSnapshot)
    const selectedHotbarIndex = context.getSelectedHotbarIndex()
    const selected = storage.inventory.slots[selectedHotbarIndex]
    if (selected === undefined) return
    const lapis = storage.inventory.slots.reduce(
      (count, stack) => count + (stack?.item === 'lapis_lazuli' ? stack.count : 0),
      0,
    )
    const playerLevel = context.getExperienceLevel()
    const key = String(selectedHotbarIndex)
    const seed = context.getEnchantmentSeed()
    const offers = enchantmentOffers(seed, 15)
    if (Result.isFailure(offers)) {
      context.setEnchantingStatus(offers.failure._tag)
      renderPlayerUi()
      return
    }
    const result = applyEnchantmentOffer({
      seed,
      bookshelfCount: 15,
      playerLevel,
      lapis,
      item: projectEnchantedItem(
        selected,
        storage.inventoryDurability[selectedHotbarIndex],
        context.enchantedItems.get(key),
      ),
    }, offers.success[slot])
    if (!result.ok || result.state.item === null) {
      context.setEnchantingStatus(result.ok ? 'No item selected' : result.reason)
      renderPlayerUi()
      return
    }
    const nextLevel = ExperienceLevel.result(result.state.playerLevel)
    if (Result.isFailure(nextLevel)) {
      context.setEnchantingStatus(nextLevel.failure._tag)
      renderPlayerUi()
      return
    }
    const consumed = removeInventoryItem('lapis_lazuli', lapis - result.state.lapis)
    if (Result.isFailure(consumed) || !consumed.success) {
      context.setEnchantingStatus(Result.isFailure(consumed)
        ? consumed.failure._tag
        : 'Lapis cost could not be consumed')
      renderPlayerUi()
      return
    }
    context.enchantedItems.set(key, result.state.item)
    context.setEnchantmentSeed(result.state.seed)
    context.restoreVitalsAtExperience(totalExperienceAtLevel(nextLevel.success))
    const status = `Applied ${result.state.item.enchantments.at(-1)?.id ?? 'enchantment'}`
    context.setEnchantingStatus(status)
    context.documentBody.setAttribute('data-enchanting-result', status)
    context.markSessionDirty()
    renderPlayerUi()
  }
  const installInventoryListeners = (): void => {
    context.inventoryParent.addEventListener('input', (event) => {
      if (context.getInventoryMode() !== 'anvil' || !(event.target instanceof HTMLInputElement)) return
      if (event.target.matches('[data-operation-target="name"]')) {
        context.setAnvilName(event.target.value.slice(0, 50))
        renderPlayerUi()
      }
    })
    context.inventoryParent.addEventListener('click', (event) => {
      if (playerIsDead()) return
      if (context.getInventoryMode() === 'anvil') {
        const target = event.target instanceof Element
          ? event.target.closest('[data-operation-target]')?.getAttribute('data-operation-target')
          : null
        if (target === 'output') activateAnvilOutput()
        return
      }
      if (context.getInventoryMode() === 'enchanting') {
        const target = event.target instanceof Element
          ? event.target.closest('[data-operation-target]')?.getAttribute('data-operation-target')
          : null
        const slot = target === 'offer-1' ? 0 : target === 'offer-2' ? 1 : target === 'offer-3' ? 2 : undefined
        if (slot !== undefined) activateEnchantingOffer(slot)
        return
      }
      if (context.getInventoryMode() === 'chest') {
        if (event.target instanceof Element && event.target.closest(
          '[data-interaction-target="chest-storage-close"]',
        ) !== null) {
          if (chestStorageCloseIntent()._tag === 'CloseRequested') setInventoryOpen(false)
          return
        }
        const chestTarget = chestTargetOf(event.target)
        if (chestTarget !== undefined) activateChestSlot(chestTarget)
        return
      }
      if (context.getInventoryMode() === 'furnace') {
        const furnaceTarget = furnaceTargetOf(event.target)
        if (furnaceTarget !== undefined) activateFurnaceSlot(furnaceTarget)
        return
      }
      const target = targetOf(event.target)
      const actionTarget = target === undefined ? null : inventoryActionTarget(target)
      if (actionTarget !== null) {
        dispatchInventoryAction({
          kind: event.shiftKey ? 'shift-click' : 'click',
          target: actionTarget,
        })
      }
    })
    context.inventoryParent.addEventListener('contextmenu', (event) => {
      if (playerIsDead()) return
      if (['furnace', 'chest', 'anvil', 'enchanting'].includes(context.getInventoryMode())) return
      const target = targetOf(event.target)
      if (target === undefined) return
      event.preventDefault()
      if (target.kind !== 'slot' || target.region === 'crafting-grid') return
      if (target.region === 'armour' || target.region === 'offhand') {
        const actionTarget = inventoryActionTarget(target)
        if (actionTarget !== null) dispatchInventoryAction({ kind: 'click', target: actionTarget })
      } else {
        activateInventoryTarget(target, 'right')
      }
    })
    context.inventoryParent.addEventListener('dragstart', (event) => {
      if (context.getInventoryMode() !== 'player' && context.getInventoryMode() !== 'craftingTable') return
      const target = targetOf(event.target)
      const actionTarget = target === undefined ? null : inventoryActionTarget(target)
      if (actionTarget === null || actionTarget.kind === 'crafting-output') return
      context.setInventoryDragSource(actionTarget)
      event.dataTransfer?.setData('text/plain', 'inventory-action')
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move'
    })
    context.inventoryParent.addEventListener('dragover', (event) => {
      if (context.getInventoryDragSource() === undefined) return
      const target = targetOf(event.target)
      const actionTarget = target === undefined ? null : inventoryActionTarget(target)
      if (actionTarget === null || actionTarget.kind === 'crafting-output') return
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    })
    context.inventoryParent.addEventListener('drop', (event) => {
      const source = context.getInventoryDragSource()
      context.setInventoryDragSource(undefined)
      const target = targetOf(event.target)
      const actionTarget = target === undefined ? null : inventoryActionTarget(target)
      if (source === undefined || actionTarget === null || actionTarget.kind === 'crafting-output') return
      event.preventDefault()
      dispatchInventoryAction({ kind: 'drag', source, target: actionTarget })
    })
    context.inventoryParent.addEventListener('dragend', () => {
      context.setInventoryDragSource(undefined)
    })
    context.inventoryParent.addEventListener('keydown', (event) => {
      if (playerIsDead()) return
      if (event.key !== 'Enter' && event.key !== ' ') return
      if (context.getInventoryMode() === 'anvil' || context.getInventoryMode() === 'enchanting') return
      if (context.getInventoryMode() === 'chest') {
        if (event.target instanceof Element && event.target.closest(
          '[data-interaction-target="chest-storage-close"]',
        ) !== null) {
          event.preventDefault()
          if (chestStorageCloseIntent()._tag === 'CloseRequested') setInventoryOpen(false)
          return
        }
        const chestTarget = chestTargetOf(event.target)
        if (chestTarget === undefined) return
        event.preventDefault()
        activateChestSlot(chestTarget)
        focusRenderedTarget()
        return
      }
      if (context.getInventoryMode() === 'furnace') {
        const furnaceTarget = furnaceTargetOf(event.target)
        if (furnaceTarget === undefined) return
        event.preventDefault()
        activateFurnaceSlot(furnaceTarget)
        focusRenderedTarget()
        return
      }
      const target = targetOf(event.target)
      if (target === undefined) return
      event.preventDefault()
      activateInventoryTarget(target)
      focusRenderedTarget()
    })
  }
  const installRespawnListener = (hudParent: HTMLElement, respawn: () => void): void => {
    hudParent.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return
      const control = event.target.closest('[data-mx-ui="respawn"]')
      if (control === null || !hudParent.contains(control)) return
      respawn()
    })
  }

  const setInventoryOpen = (open: boolean, mode: InventoryMode = 'player'): void => {
    if (open && playerIsDead()) return
    if (open && context.getBowInteractionLocked()) return
    if (!open && context.getMultiplayer() && context.getInventoryOpen()
      && context.getInventoryMode() === 'chest' && context.getActiveChestId() !== undefined) {
      const activeChestId = context.getActiveChestId()
      if (activeChestId === undefined) return
      if (!context.sendFacilityCommand({
        _tag: 'ContainerCommand',
        containerId: activeChestId,
        action: { _tag: 'close' },
      })) {
        context.setChestStatus('Wait for the pending facility action before closing')
        context.setCloseChestOnFacilityIdle(true)
        renderPlayerUi()
        return
      }
    }
    if (open && context.isTradeOpen()) context.closeTrade()
    if (open && context.isBrewingOpen()) context.closeBrewing()
    const previousOpen = context.getInventoryOpen()
    const switchingMode = open && previousOpen && context.getInventoryMode() !== mode
    if (previousOpen === open && !switchingMode) return
    context.resetPrimaryAttackGesture()
    if (!open) context.clearMultiplayerInventorySelection()

    if (
      previousOpen
      && (context.getInventoryMode() === 'player' || context.getInventoryMode() === 'craftingTable')
      && (!open || switchingMode)
    ) {
      // A failed close keeps the carried stack in the interaction state, so the screen stays
      // open with the failure shown instead of hiding a stack the player still holds.
      if (!settledInventoryInteraction(Effect.runSync(Effect.result(inventoryInteraction.close())))) {
        renderPlayerUi()
        return
      }
    }

    context.setInventoryOpenState(open)
    if (previousOpen !== open) announceInventoryTransition(context.audio, previousOpen, open)
    context.inventoryParent.hidden = !open
    context.inventoryParent.setAttribute('aria-hidden', String(!open))
    context.document.body.setAttribute('data-inventory-open', String(open))
    if (open) {
      context.setInventoryMode(mode)
      const presentation = context.inventoryPresentations[mode]
      if (mode === 'player' || mode === 'craftingTable') {
        // main.ts INVENTORY_PRESENTATIONS gives the crafting modes 2x2 and 3x3 grids.
        inventoryInteraction.configureGrid(
          RecipeGridDimension(presentation.width),
          RecipeGridDimension(presentation.height),
        )
      }
      context.inventoryParent.setAttribute('aria-label', presentation.label)
      if (mode === 'furnace') {
        context.setFurnaceFocus('input')
        context.setFurnaceStatus('')
      } else if (mode === 'chest') {
        context.setChestFocus({ region: 'chest', slot: 0 })
        context.setChestSelected(undefined)
        context.setChestStatus('')
      } else if (mode === 'anvil') {
        context.setAnvilName(context.customNames.get(String(context.getSelectedHotbarIndex())) ?? '')
        context.setAnvilStatus('')
      } else if (mode === 'enchanting') {
        context.setEnchantingStatus('')
      } else {
        context.setInventoryFocus({ kind: 'slot', region: 'hotbar', index: context.getSelectedHotbarIndex() })
      }
    }
    if (!open && context.getInventoryMode() === 'chest') {
      context.setActiveChestId(undefined)
      context.setChestSelected(undefined)
      context.setChestStatus('')
    }
    renderPlayerUi()
    context.renderCrosshair()
    syncTouchControls()
    if (open) context.window.requestAnimationFrame(focusRenderedTarget)
    if (open && context.document.pointerLockElement === context.canvas) {
      context.document.exitPointerLock()
    }
  }
  const requestFlush = async (): Promise<void> => {
    const targetGeneration = context.getDirtyGeneration()
    do {
      await context.saveSession()
    } while (context.getSavedGeneration() < targetGeneration)
    context.documentBody.setAttribute('data-session-persistence', 'saved')
  }
  const requestBackgroundFlush = (): void => {
    void requestFlush().catch(() => {
      // The coordinator already made the failure visible; background callers consume it.
    })
  }
  const flushDirty = (): void => {
    if (context.getDirtyGeneration() !== context.getSavedGeneration()) requestBackgroundFlush()
  }
  const markSessionDirty = (): void => {
    context.setDirtyGeneration(context.getDirtyGeneration() + 1)
    context.documentBody.setAttribute('data-session-persistence', 'dirty')
    const previousTimer = context.getDebounceTimer()
    if (previousTimer !== undefined) context.clearDebounce(previousTimer)
    context.setDebounceTimer(context.scheduleDebounce(flushDirty, context.saveDebounceMs))
  }

  return {
    inventoryInteraction,
    setInventoryOpen,
    projectedInventoryEnchantedItem,
    inventoryMeleeDamage,
    playerIsDead,
    coordinateKey,
    interactionStatus,
    syncTouchControls,
    resetTouchInput,
    presentSwimmingState,
    setFishingResult,
    renderPlayerUi,
    targetedBlock,
    fishingEnvironmentAt,
    furnaceTargetOf,
    chestTargetOf,
    sameChestTarget,
    activateChestSlot,
    activateFurnaceSlot,
    targetOf,
    focusRenderedTarget,
    activateInventoryTarget,
    dispatchInventoryAction,
    installInventoryListeners,
    installRespawnListener,
    materializeEndArrival,
    useEndFeature,
    applyPlayerDamage,
    applyWorldExplosion,
    requestFlush,
    requestBackgroundFlush,
    flushDirty,
    markSessionDirty,
  }
}
