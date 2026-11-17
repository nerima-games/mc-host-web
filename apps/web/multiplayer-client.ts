import { Data, Effect, Option, Queue, Result, Schema, type Brand } from 'effect'
import type { YieldableError } from 'effect/Cause'
import {
  BlockAxis,
  blockIdOf,
  blockPosition,
  EntityHealthPoints,
  InterpolationFraction,
  isBlockType,
  isDimension,
  isItemType,
  itemStackFromUnknown,
  position,
  PositionAxis,
  type BrewingState,
  type ItemStackFailure,
  type ItemType,
  type Position as Vec3,
} from '@nerima-games/mc-kernel'
import {
  CONTAINER_STORAGE_SNAPSHOT_VERSION,
  durabilityForItem,
  equipmentItem,
  EQUIPMENT_SLOTS,
  BrewingServiceStateSchema,
  HungerPoints,
  makeTimeService,
  makeVehicleService,
  makeWeatherService,
  OccupantId,
  TotalExperience,
  validateContainerStorageSnapshot,
  validatePlayerStorageSnapshot,
  validateWeatherState,
  type ContainerStorageSnapshot,
  type ContainerSlot,
  type ContainerStorageValidationError,
  type EquipmentItemFailure,
  type ItemStack,
  type PlayerStorage,
  type PlayerStorageValidationError,
  type Vehicle,
  type WeatherValidationFailure,
  type WorldCommitCoordinatorError,
} from '@nerima-games/mc-sim'
import {
  BrewingCommand,
  brewingStateFromWire,
  CommandId,
  EntityId,
  furnaceStateFromWire,
  makeMultiplayerHost,
  PlayerId,
  PlayerName,
  TransportPort,
  WorldId,
  type AuthoritativeEntityState,
  type BrewingAction,
  type BrewingWireConversionFailure,
  type FurnaceWireConversionFailure,
  type MultiplayerHost,
  type NetworkMessage,
} from '@nerima-games/mx-multiplayer'
import {
  GAMEPLAY_BREWING_OWNER_ID,
  GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
  GameplayVillagerTradeSnapshotSchema,
  type GeneratedWorld,
  restoreStatusEffects,
  StatusEffectStateSchema,
  type EnchantedItem,
  type GameplayFrameState,
  type MobBehaviour,
  type WeatherState,
} from '@nerima-games/mx-gameplay'
import { enchantedItemWithLevels } from './enchanted-item-state'
import type { GameplayCommitServices } from './host-modules'
import { validateMultiplayerUrl } from './multiplayer-url'
import type { OwnerBackedWorld } from './owner-backed-services'
import {
  initialSleepRuntimeState,
  enterSleep,
  sleepRatioFromPercentage,
} from './sleep-runtime'
import {
  applySleepCommandResult,
  applySleepEvents,
  type AnvilCommand,
  type AnvilCommandResult,
  type CraftingCommand,
  type CraftingCommandResult,
  type EnchantingCommand,
  type EnchantingCommandResult,
  type PlayerDamageCommand,
  type PlayerDamageCommandResult,
  sleepClientFromSnapshot,
  restoreWitherRuntime,
  type SleepClientState,
} from '@nerima-games/mc-server/shared'
import {
  launchRuntimeEyeOfEnder,
  initialEyeOfEnderRuntimeState,
} from './eye-of-ender-runtime'
import {
  type PersistedFurnaceState,
  type PersistedLeverState,
  type SessionState,
} from './session-persistence'

import {
  makeBrowserWebSocketTransport,
  type BrowserWebSocketTransport,
} from './multiplayer-websocket'

export type MultiplayerQuery = {
  readonly url: string
  readonly player: PlayerId
  readonly name: PlayerName
}

export type RemotePlayer = {
  readonly name: PlayerName
  readonly world: WorldId
  readonly at: { readonly x: number; readonly y: number; readonly z: number }
  readonly facing: { readonly yawRadians: number; readonly pitchRadians: number }
}

export type MultiplayerRuntime = {
  readonly query: MultiplayerQuery
  readonly host: MultiplayerHost
  readonly transport: BrowserWebSocketTransport
  readonly players: Map<PlayerId, RemotePlayer>
}

export type WithoutAuthority<T> = T extends unknown
  ? Omit<T, 'commandId' | 'player' | 'world' | 'expectedRevision'>
  : never

export const readMultiplayerQuery = (search: string): MultiplayerQuery | undefined => {
  const query = new URLSearchParams(search)
  const url = query.get('multiplayer')
  const player = query.get('player')
  const name = query.get('multiplayerName')
  if (url === null || player === null || name === null || player.length === 0 || name.length === 0) {
    return undefined
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return undefined
  } catch {
    return undefined
  }
  return { url, player: PlayerId.make(player), name: PlayerName.make(name) }
}

export const multiplayerReconnectTokenKey = (
  url: string,
  worldId: string,
  player: PlayerId,
): string => `mc-compose:multiplayer-reconnect:${JSON.stringify([url, worldId, String(player)])}`

export const multiplayerRegistrationTokenKey = (
  url: string,
  worldId: string,
  player: string,
): string => `mc-compose:multiplayer-registration:${JSON.stringify([url, worldId, player])}`

export type MultiplayerCommandIds<CommandIdValue> = Readonly<{
  commandIdFor: (scope: string, sequence: number) => CommandIdValue
  requestIdFor: (scope: string, sequence: number) => string
}>

export const makeMultiplayerCommandIds = <CommandIdValue>(
  sessionId: string,
  makeCommandId: (value: string) => CommandIdValue,
): MultiplayerCommandIds<CommandIdValue> => ({
  commandIdFor: (scope: string, sequence: number) =>
    makeCommandId(`${scope}-${sessionId}-${String(sequence)}`),
  requestIdFor: (scope: string, sequence: number) => `${scope}-${sessionId}-${String(sequence)}`,
})

export const makeMultiplayerChatCommand = (
  multiplayer: { readonly query: { readonly player: PlayerId } } | undefined,
  handshakeComplete: boolean,
  input: string,
): Extract<NetworkMessage, { readonly _tag: 'Chat' }> | undefined => {
  const text = input.trim()
  if (multiplayer === undefined || !handshakeComplete || text.length === 0) return undefined
  return {
    _tag: 'Chat',
    player: multiplayer.query.player,
    text: text.slice(0, 256),
  }
}

export type MultiplayerChatInputContext = {
  readonly multiplayer: Pick<MultiplayerRuntime, 'query' | 'host'> | undefined
  readonly ui: Pick<MultiplayerClientContext['ui'], 'multiplayerChat' | 'multiplayerChatForm' | 'multiplayerChatInput'>
  readonly state: Pick<MultiplayerClientContext['state'], 'multiplayerHandshakeComplete'>
}

export const setMultiplayerChatVisibility = (
  multiplayerChat: Pick<HTMLElement, 'hidden'>,
  multiplayer: Pick<MultiplayerRuntime, 'query' | 'host'> | undefined,
): void => {
  multiplayerChat.hidden = multiplayer === undefined
}

export const installMultiplayerChatInputListeners = (clientContext: MultiplayerChatInputContext): void => {
  clientContext.ui.multiplayerChatForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const currentMultiplayer = clientContext.multiplayer
    const command = makeMultiplayerChatCommand(
      currentMultiplayer,
      clientContext.state.multiplayerHandshakeComplete,
      clientContext.ui.multiplayerChatInput.value,
    )
    if (command === undefined || currentMultiplayer === undefined) return
    Effect.runSync(currentMultiplayer.host.enqueueOutbound(command))
    clientContext.ui.multiplayerChatInput.value = ''
  })
  for (const eventName of ['keydown', 'keyup'] as const) {
    clientContext.ui.multiplayerChatInput.addEventListener(eventName, (event) => event.stopPropagation())
  }
}

type EffectValue<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never
type Dimension = SessionState['dimension']
type World = GeneratedWorld<MobBehaviour>
type TimeService = EffectValue<ReturnType<typeof makeTimeService>>
type WeatherService = EffectValue<ReturnType<typeof makeWeatherService>>
type VehicleService = EffectValue<ReturnType<typeof makeVehicleService>>
type EnderDragonSnapshot = EffectValue<GameplayFrameState['enderDragonEncounter']['snapshot']>
type ClientChunkContext = Readonly<{
  dimension: Dimension
  chunkStore: World['chunkStore']
}>

export type MultiplayerInventorySelection = Readonly<{
  source: number
  remaining: number
  mode: 'all' | 'split'
}>

export type QueuedPlayerDamage = Readonly<{
  readonly amount: number
  readonly minimumHealthPoints: number
}>

export type MultiplayerConnectionContext = {
  readonly sessionId: string
  readonly search: string
  readonly href: string
  readonly getSessionStorage: () => Pick<Storage, 'getItem' | 'removeItem'>
  readonly getLocalStorage: () => Pick<Storage, 'getItem' | 'setItem'>
  readonly failBoot: (message: string) => void
}

export type MultiplayerClientContext = {
  readonly multiplayer: MultiplayerRuntime | undefined
  readonly ui: {
    readonly canvas: Pick<HTMLCanvasElement, 'setAttribute'>
    readonly multiplayerStatus: Pick<HTMLOutputElement, 'hidden' | 'textContent'>
    readonly multiplayerChat: Pick<HTMLElement, 'hidden'>
    readonly multiplayerChatLog: Pick<HTMLOListElement, 'append' | 'childElementCount' | 'firstElementChild'>
    readonly multiplayerChatForm: Pick<HTMLFormElement, 'addEventListener'>
    readonly multiplayerChatInput: Pick<HTMLInputElement, 'value' | 'addEventListener'>
  }
  readonly state: {
    inventoryOpen: boolean
    inventoryMode: 'player' | 'craftingTable' | 'furnace' | 'chest' | 'anvil' | 'enchanting'
    tradeOpen: boolean
    activeVillagerId: string | undefined
    brewingOpen: boolean
    brewingStatus: string
    tradeStatus: string
    enchantmentSeed: number
    anvilName: string
    anvilStatus: string
    enchantingStatus: string
    readonly customNames: Map<string, string>
    readonly enchantedItems: Map<string, EnchantedItem>
    eyeOfEnderRuntimeState: ReturnType<typeof initialEyeOfEnderRuntimeState>
    sleepRuntimeState: ReturnType<typeof initialSleepRuntimeState>
    witherRevision: number
    witherRuntimeState: ReturnType<typeof restoreWitherRuntime>
    authoritativeEnderDragonSnapshot: EnderDragonSnapshot
    enderDragonRevision: number
    redstoneDirty: boolean
    readonly leverStates: Map<string, PersistedLeverState>
    readonly poweredRails: Set<string>
    fishingResult: string
    networkFishingState: { readonly phase: 'idle' | 'waiting' | 'bite' | 'escaped'; readonly result: string }
    readonly furnaceStates: Map<string, PersistedFurnaceState>
    activeFurnaceKey: string | undefined
    activeChestId: string | undefined
    selectedHotbarIndex: number
    chestStatus: string
    furnaceStatus: string
    authoritativeLightning: Readonly<{ sequence: number; at: Vec3; expiresAtSecs: number }> | undefined
    readonly multiplayerEntities: Map<string, AuthoritativeEntityState>
    multiplayerInventorySelection: MultiplayerInventorySelection | null
    queuedPlayerDamages: QueuedPlayerDamage[]
    pendingCrafting: { readonly commandId: string; readonly acceptedRevision: number | null } | null
    activeBrewingStandAt: { readonly x: number; readonly y: number; readonly z: number } | undefined
    closeChestOnFacilityIdle: boolean
    networkSleepState: SleepClientState
    nextSleepRequest: number
    appliedNightSkipRevision: number | null
    multiplayerRejection: string
    multiplayerHandshakeComplete: boolean
    multiplayerClosed: boolean
    lastPlayerMoveSentAt: number
    lastPlayerMoveSent: {
      readonly world: WorldId
      readonly at: { readonly x: number; readonly y: number; readonly z: number }
      readonly facing: { readonly yawRadians: number; readonly pitchRadians: number }
    } | undefined
  }
  readonly services: {
    /** Runs `work` at the next frame boundary, for DOM events that read the world. */
    readonly deferToFrameBoundary: (work: () => void) => void
    readonly world: Pick<OwnerBackedWorld, 'inventory' | 'vitals'>
    readonly gameplayState: GameplayFrameState
    /** The gameplay owners' commit services; server deltas for owner state are committed through them. */
    readonly gameplayCommit: GameplayCommitServices
    readonly playerApi: OwnerBackedWorld['player']
    readonly time: TimeService
    readonly weather: WeatherService
    readonly currentChunkContext: () => ClientChunkContext
    readonly getOrCreateDimensionChunkContext: (dimension: Dimension) => ClientChunkContext
    readonly leverKeyOf: (lever: Pick<PersistedLeverState, 'dimension' | 'position'>) => string
    readonly vehicleById: (id: string) => Vehicle | undefined
    readonly vehicleService: VehicleService
    readonly applyAuthoritativeVehicle: (vehicle: DecodedVehicle) => void
    readonly alignActiveDimension: (dimension: Dimension) => void
    readonly resetSimState: (reset: boolean) => void
    readonly presentWeather: (state: WeatherState) => void
    readonly queueEndAudio: (cue: 'eyeThrow', position: Vec3) => void
    readonly craftingStaleRetryLimit: number
  }
  readonly callbacks: {
    readonly getInventoryInteraction: () => {
      readonly state: () => {
        readonly grid: {
          readonly width: number
          readonly height: number
          readonly cells: ReadonlyArray<{ readonly item: ItemStack['item'] } | undefined>
        }
      }
      readonly confirmCraftOnce: () => Effect.Effect<unknown, import('@nerima-games/mc-sim').ItemStackFailure>
    }
    readonly renderPlayerUi: () => void
    readonly renderTradeUi: () => void
    readonly renderBrewingUi: () => void
    readonly setInventoryOpen: (open: boolean) => void
  }
}

type MultiplayerPosition = Readonly<{ x: number; y: number; z: number }>

type UnknownNetworkNameFields = {
  readonly kind: 'block' | 'item'
  readonly name: string
}

/** A server message named a block or item this client does not know. */
type UnknownNetworkName = YieldableError &
  UnknownNetworkNameFields & { readonly _tag: 'UnknownNetworkName' }

const UnknownNetworkName: new (fields: UnknownNetworkNameFields) => UnknownNetworkName =
  Data.TaggedError('UnknownNetworkName')

type InvalidFurnaceIdFields = {
  readonly furnaceId: string
}

/** A server furnace id that this client does not know and that does not encode a location. */
type InvalidFurnaceId = YieldableError &
  InvalidFurnaceIdFields & { readonly _tag: 'InvalidFurnaceId' }

const InvalidFurnaceId: new (fields: InvalidFurnaceIdFields) => InvalidFurnaceId =
  Data.TaggedError('InvalidFurnaceId')

/** Why a server message's state cannot be represented in the local world. */
type InvalidServerStateFailure =
  | Brand.BrandError
  | UnknownNetworkName
  | InvalidFurnaceId
  | ItemStackFailure
  | EquipmentItemFailure
  | FurnaceWireConversionFailure
  | BrewingWireConversionFailure
  | Schema.SchemaError
  | PlayerStorageValidationError
  | ContainerStorageValidationError
  | WeatherValidationFailure

type InvalidServerStateFields = {
  readonly what: string
  readonly failure: InvalidServerStateFailure
}

/** A server message did not decode, so none of it was applied. */
type InvalidServerState = YieldableError &
  InvalidServerStateFields & { readonly _tag: 'InvalidServerState' }

const InvalidServerState: new (fields: InvalidServerStateFields) => InvalidServerState =
  Data.TaggedError('InvalidServerState')

type ClientServices = MultiplayerClientContext['services']
type ClientInventoryInteraction = ReturnType<MultiplayerClientContext['callbacks']['getInventoryInteraction']>

/** Why a local owner refused decoded server state. */
type ServerStateApplyFailure =
  | Effect.Error<ClientServices['world']['vitals']['snapshot']>
  | Effect.Error<ReturnType<ClientServices['world']['vitals']['restore']>>
  | Effect.Error<ClientServices['world']['inventory']['storageSnapshot']>
  | Effect.Error<ReturnType<ClientServices['world']['inventory']['restoreStorage']>>
  | Effect.Error<ReturnType<ClientServices['world']['inventory']['restoreContainerStorage']>>
  | Effect.Error<ReturnType<ClientServices['weather']['applyTransition']>>
  | Effect.Error<ReturnType<ClientServices['playerApi']['restore']>>
  | Effect.Error<ClientServices['playerApi']['dimension']>
  | Effect.Error<ReturnType<typeof restoreStatusEffects>>
  | Effect.Error<ReturnType<ClientChunkContext['chunkStore']['setBlock']>>
  | Effect.Error<ReturnType<ClientInventoryInteraction['confirmCraftOnce']>>
  | WorldCommitCoordinatorError

type ServerStateNotAppliedFields = {
  readonly what: string
  readonly failure: ServerStateApplyFailure
}

/** A local owner refused a decoded server message. */
type ServerStateNotApplied = YieldableError &
  ServerStateNotAppliedFields & { readonly _tag: 'ServerStateNotApplied' }

const ServerStateNotApplied: new (fields: ServerStateNotAppliedFields) => ServerStateNotApplied =
  Data.TaggedError('ServerStateNotApplied')

type ServerStateFailure = InvalidServerState | ServerStateNotApplied

const invalidServerState = (what: string) => (failure: InvalidServerStateFailure): InvalidServerState =>
  new InvalidServerState({ what, failure })

const appliedAs = <A>(
  what: string,
  effect: Effect.Effect<A, ServerStateApplyFailure>,
): Effect.Effect<A, ServerStateNotApplied> =>
  Effect.mapError(effect, (failure) => new ServerStateNotApplied({ what, failure }))

const networkPosition = (at: MultiplayerPosition): Result.Result<Vec3, Brand.BrandError> =>
  Result.gen(function* () {
    return position(
      yield* PositionAxis.result(at.x),
      yield* PositionAxis.result(at.y),
      yield* PositionAxis.result(at.z),
    )
  })

const networkItemType = (name: string): Result.Result<ItemType, UnknownNetworkName> =>
  isItemType(name) ? Result.succeed(name) : Result.fail(new UnknownNetworkName({ kind: 'item', name }))

const dimensionFromWorld = (worldId: WorldId): Dimension | undefined =>
  isDimension(worldId) ? worldId : undefined

type NetworkWorldSnapshot = Extract<NetworkMessage, { readonly _tag: 'WorldSnapshot' }>
type NetworkAuthoritativeSnapshot = Extract<NetworkMessage, { readonly _tag: 'AuthoritativeSnapshot' }>
type NetworkVitalsState = Extract<NetworkMessage, { readonly _tag: 'PlayerVitalsDelta' }>['state']
type NetworkInventoryState = Extract<NetworkMessage, { readonly _tag: 'PlayerInventoryDelta' }>['state']
type NetworkVillagerTradeState = Extract<NetworkMessage, { readonly _tag: 'VillagerTradeDelta' }>['state']
type NetworkTimeWeatherState = Extract<NetworkMessage, { readonly _tag: 'WorldTimeWeatherDelta' }>['state']
type NetworkContainerState = Extract<NetworkMessage, { readonly _tag: 'ContainerDelta' }>['state']
type NetworkFurnaceState = Extract<NetworkMessage, { readonly _tag: 'FurnaceDelta' }>['state']
type FurnaceLocation = Pick<PersistedFurnaceState, 'dimension' | 'position'>

// Every decoder below only reads: it turns one server value into a value the
// local owners accept, or fails without touching any state. A message is
// applied only after every part of it decoded.

/** A block in a world this client does not host decodes to `undefined` and is skipped. */
const decodeNetworkBlock = (worldId: WorldId, at: MultiplayerPosition, block: string | null) => {
  const dimension = dimensionFromWorld(worldId)
  const blockName = block ?? 'air'
  return Result.mapError(Result.gen(function* () {
    if (dimension === undefined) return undefined
    const cell = blockPosition(
      yield* BlockAxis.result(at.x),
      yield* BlockAxis.result(at.y),
      yield* BlockAxis.result(at.z),
    )
    const id = isBlockType(blockName) ? blockIdOf(blockName) : Option.none()
    if (Option.isNone(id)) return yield* Result.fail(new UnknownNetworkName({ kind: 'block', name: blockName }))
    return { dimension, cell, id: id.value }
  }), invalidServerState('block'))
}

const decodeWorldSnapshot = (message: NetworkWorldSnapshot) =>
  Result.map(
    Result.all(message.blocks.map((block) => decodeNetworkBlock(block.world, block.at, block.block))),
    (blocks) => ({ message, blocks: blocks.filter((edit) => edit !== undefined) }),
  )

const decodeNetworkVitals = (state: NetworkVitalsState) =>
  Result.mapError(Result.gen(function* () {
    return {
      healthPoints: yield* EntityHealthPoints.result(state.health),
      hungerPoints: yield* HungerPoints.result(state.hunger),
      totalExperience: yield* TotalExperience.result(state.experience),
    }
  }), invalidServerState('vitals'))

/** The server's inventory over the local storage, validated as `restoreStorage` validates it. */
const decodeNetworkInventory = (state: NetworkInventoryState, storage: PlayerStorage) =>
  Result.mapError(Result.gen(function* () {
    const slots: Array<ItemStack | undefined> = []
    for (const stack of state.slots) {
      slots.push(stack === null ? undefined : yield* itemStackFromUnknown(stack.item, stack.count))
    }
    const equipmentSlots = { ...storage.equipment.slots }
    if (state.equipment !== undefined) {
      for (const slot of EQUIPMENT_SLOTS) {
        const stack = state.equipment[slot]
        if (stack === null) {
          equipmentSlots[slot] = null
          continue
        }
        const equipped = yield* itemStackFromUnknown(stack.item, stack.count)
        equipmentSlots[slot] = yield* equipmentItem(equipped, stack.durability ?? durabilityForItem(equipped.item))
      }
    }
    const validated = validatePlayerStorageSnapshot({
      inventory: { slots },
      inventoryDurability: slots.map((stack, index) => {
        const durability = state.slots[index]?.durability ?? state.durability?.[index]
        if (durability !== undefined) return durability
        const previous = storage.inventory.slots[index]
        return previous?.item === stack?.item
          ? storage.inventoryDurability[index]
          : stack === undefined ? null : durabilityForItem(stack.item)
      }),
      equipment: { slots: equipmentSlots },
    })
    if (validated._tag !== 'Valid') return yield* Result.fail(validated.error)
    return { storage: validated.storage, selectedSlot: state.selectedSlot }
  }), invalidServerState('inventory'))

const decodeNetworkVillagerTrade = (state: NetworkVillagerTradeState) =>
  Result.mapError(Result.gen(function* () {
    const offers = new Map<string, Readonly<{
      input: Readonly<{ item: ItemType; count: number }>
      output: Readonly<{ item: ItemType; count: number }>
      uses: number
      maxUses: number
    }>>()
    for (const offer of state.offers) {
      const input = offer.input[0]
      if (input === undefined) continue
      offers.set(offer.offerId, {
        input: { item: yield* networkItemType(input.item), count: input.count },
        output: { item: yield* networkItemType(offer.output.item), count: offer.output.count },
        uses: offer.uses,
        maxUses: offer.maxUses,
      })
    }
    return { villagerId: state.villagerId, offers }
  }), invalidServerState('villager trade'))

const decodeNetworkTimeWeather = (state: NetworkTimeWeatherState) =>
  Result.gen(function* () {
    return {
      timeOfDay: yield* Result.mapError(
        InterpolationFraction.result(state.timeOfDay / 24_000),
        invalidServerState('time of day'),
      ),
      weather: yield* Result.mapError(
        validateWeatherState({ weather: state.weather, remainingSecs: 300 }),
        invalidServerState('weather'),
      ),
    }
  })

const decodeNetworkContainer = (state: NetworkContainerState) =>
  Result.mapError(Result.gen(function* () {
    const slots: Array<ContainerSlot> = []
    for (const stack of state.slots) {
      slots.push(stack === null
        ? null
        : { ...(yield* itemStackFromUnknown(stack.item, stack.count)), durability: stack.durability ?? null })
    }
    return { id: state.containerId, kind: state.kind, slots }
  }), invalidServerState('container'))

/** The whole container storage, validated as `restoreContainerStorage` validates it. */
const decodeNetworkContainers = (
  containers: ReadonlyArray<unknown>,
): Result.Result<ContainerStorageSnapshot, InvalidServerState> => {
  const validated = validateContainerStorageSnapshot({ version: CONTAINER_STORAGE_SNAPSHOT_VERSION, containers })
  return validated._tag === 'Valid'
    ? Result.succeed({ version: CONTAINER_STORAGE_SNAPSHOT_VERSION, containers: validated.storage.containers })
    : Result.fail(new InvalidServerState({ what: 'container', failure: validated.error }))
}

/** A furnace id the client has not seen names its location as `[dimension, x, y, z]`. */
const furnaceLocationFromId = (furnaceId: string): Result.Result<FurnaceLocation, InvalidFurnaceId> => {
  const invalid = Result.fail(new InvalidFurnaceId({ furnaceId }))
  const parsed = Result.try((): unknown => JSON.parse(furnaceId))
  if (Result.isFailure(parsed) || !Array.isArray(parsed.success) || parsed.success.length !== 4) return invalid
  const [dimension, x, y, z]: ReadonlyArray<unknown> = parsed.success
  if (
    !isDimension(dimension)
    || typeof x !== 'number' || !Number.isFinite(x)
    || typeof y !== 'number' || !Number.isFinite(y)
    || typeof z !== 'number' || !Number.isFinite(z)
  ) return invalid
  return Result.succeed({ dimension, position: { x, y, z } })
}

type NetworkVehicleState = Extract<AuthoritativeEntityState, { readonly _tag: 'vehicle' }>

/** A server vehicle whose occupant is a valid local occupant id. */
export type DecodedVehicle = {
  readonly entity: NetworkVehicleState
  readonly occupant: OccupantId | undefined
}

// The wire PlayerId accepts a blank string, which OccupantId refuses.
const decodeNetworkVehicle = (entity: NetworkVehicleState): Result.Result<DecodedVehicle, InvalidServerState> =>
  Result.mapError(Result.gen(function* () {
    return { entity, occupant: entity.occupant === null ? undefined : yield* OccupantId.result(entity.occupant) }
  }), invalidServerState('vehicle occupant'))

const decodeNetworkVehicles = (
  entities: ReadonlyArray<AuthoritativeEntityState>,
): Result.Result<ReadonlyArray<DecodedVehicle>, InvalidServerState> =>
  Result.all(entities.flatMap((entity) => entity._tag === 'vehicle' ? [decodeNetworkVehicle(entity)] : []))

const decodeNetworkFurnace = (state: NetworkFurnaceState, known: FurnaceLocation | undefined) =>
  Result.mapError(Result.gen(function* () {
    const location = known ?? (yield* furnaceLocationFromId(state.furnaceId))
    const furnace: PersistedFurnaceState = {
      dimension: location.dimension,
      position: location.position,
      state: yield* furnaceStateFromWire(state),
    }
    return { furnaceId: state.furnaceId, furnace }
  }), invalidServerState('furnace'))

/** Brewing stands are keyed by world and block position, as the server addresses them. */
const brewingStandKey = (world: WorldId, at: MultiplayerPosition): string =>
  JSON.stringify([world, at.x, at.y, at.z])

export type MultiplayerClientApi = Readonly<{
  enqueueMultiplayerPlayerMove: (nowSecs: number) => void
  drainMultiplayerInbound: () => void
  sendVitalsCommand: (action: Extract<NetworkMessage, { readonly _tag: 'PlayerVitalsCommand' }>['action']) => void
  sendPortalUseCommand: (portal: MultiplayerPosition, tag: 'EndPortalUseCommand' | 'NetherPortalUseCommand') => boolean
  sendEndProgressCommand: (
    command: { readonly _tag: 'ThrowEyeOfEnderCommand' }
      | { readonly _tag: 'InsertEyeIntoEndPortalFrameCommand'; readonly frame: MultiplayerPosition },
  ) => boolean
  sendToggleLeverCommand: (lever: MultiplayerPosition) => boolean
  sendInventoryCommand: (action: Extract<NetworkMessage, { readonly _tag: 'PlayerInventoryCommand' }>['action']) => boolean
  sendInventorySelection: (slot: number) => boolean
  sendVillagerTradeCommand: (villagerId: string, offerId: string) => boolean
  sendEntityCommand: (
    command: WithoutAuthority<Extract<NetworkMessage, {
      readonly _tag: 'EntityAttackCommand' | 'EntityPickupCommand' | 'BowUseCommand' | 'IgniteTntCommand' | 'EnderPearlCommand' | 'BucketUseCommand' | 'VehicleUseCommand' | 'FishingCommand' | 'VehicleCommand'
    }>>,
  ) => void
  sendFacilityCommand: (
    command: WithoutAuthority<Extract<NetworkMessage, { readonly _tag: 'ContainerCommand' | 'FurnaceCommand' }>>,
  ) => boolean
  pumpPlayerDamage: () => void
  drainPlayerDamageInbound: () => void
  requestCrafting: () => void
  drainCraftingInbound: () => void
  requestBrewing: (action: BrewingAction) => Effect.Effect<boolean>
  requestAnvil: () => boolean
  drainAnvilInbound: () => void
  requestEnchanting: (offer: 0 | 1 | 2) => boolean
  drainEnchantingInbound: () => void
  requestIdFor: (scope: string, sequence: number) => string
}>

export type MultiplayerConnectionResult =
  | {
      readonly status: 'started'
      readonly multiplayer: MultiplayerRuntime | undefined
      readonly multiplayerInboundStage: MultiplayerHost['stages'][number] | undefined
      readonly multiplayerOutboundStage: MultiplayerHost['stages'][number] | undefined
      readonly requiredSleepRatio: number
    }
  | { readonly status: 'failed' }

export const connectMultiplayer = async (
  context: MultiplayerConnectionContext,
): Promise<MultiplayerConnectionResult> => {
  const multiplayerQuery = readMultiplayerQuery(context.search)
  const multiplayerUrlValidation = multiplayerQuery === undefined
    ? undefined
    : validateMultiplayerUrl(multiplayerQuery.url, context.href)
  if (multiplayerUrlValidation?.ok === false) {
    context.failBoot(multiplayerUrlValidation.message)
    return { status: 'failed' }
  }
  let registrationToken: string | undefined
  if (multiplayerQuery !== undefined && multiplayerUrlValidation?.ok === true) {
    const registrationTokenKey = multiplayerRegistrationTokenKey(
      multiplayerUrlValidation.url.href,
      context.sessionId,
      String(multiplayerQuery.player),
    )
    try {
      const sessionStorage = context.getSessionStorage()
      registrationToken = sessionStorage.getItem(registrationTokenKey) ?? undefined
      sessionStorage.removeItem(registrationTokenKey)
    } catch (error: unknown) {
      context.failBoot('Legacy registration token could not be read securely. Return to the title screen and try again.')
      console.error('[mc-compose] multiplayer registration token retrieval failed', error)
      return { status: 'failed' }
    }
  }
  const requiredSleepRatio = sleepRatioFromPercentage(
    new URLSearchParams(context.search).get('sleepPercentage'),
  )
  const multiplayer = multiplayerQuery === undefined
    ? undefined
    : await Effect.runPromise(
        Effect.gen(function* () {
          const reconnectTokenKey = multiplayerReconnectTokenKey(
            multiplayerQuery.url,
            context.sessionId,
            multiplayerQuery.player,
          )
          let reconnectToken: string | undefined
          const transport = yield* makeBrowserWebSocketTransport({
            url: multiplayerUrlValidation?.url.href ?? multiplayerQuery.url,
            reconnectAuth: {
              playerId: String(multiplayerQuery.player),
              loadToken: () => {
                if (reconnectToken !== undefined) return reconnectToken
                try {
                  reconnectToken = context.getLocalStorage().getItem(reconnectTokenKey) ?? undefined
                } catch {
                  // Fall back to the latest token retained for this page lifetime.
                }
                return reconnectToken
              },
              saveToken: (token) => {
                reconnectToken = token
                context.getLocalStorage().setItem(reconnectTokenKey, token)
              },
              loadRegistrationToken: () => registrationToken,
              clearRegistrationToken: () => {
                registrationToken = undefined
              },
            },
          })
          const host = yield* makeMultiplayerHost.pipe(
            Effect.provideService(TransportPort, transport),
          )
          yield* host.transitionConnection({ _tag: 'ConnectRequested' })
          return {
            query: multiplayerQuery,
            host,
            transport,
            players: new Map<PlayerId, RemotePlayer>(),
          } satisfies MultiplayerRuntime
        }),
      )
  return {
    status: 'started',
    multiplayer,
    multiplayerInboundStage: multiplayer?.host.stages.find(
      (stage) => stage.id === 'multiplayer:inbound',
    ),
    multiplayerOutboundStage: multiplayer?.host.stages.find(
      (stage) => stage.id === 'multiplayer:outbound',
    ),
    requiredSleepRatio,
  }
}


export const createMultiplayerClient = (clientContext: MultiplayerClientContext): MultiplayerClientApi => {
  // The server deduplicates commands across reconnects, so a fresh page must not reuse its counters.
  const multiplayerCommandSessionId = crypto.randomUUID()
  const { commandIdFor, requestIdFor } = makeMultiplayerCommandIds(multiplayerCommandSessionId, CommandId.make)

  let multiplayerRevision = 0
  let nextVitalsCommand = 0
  let nextEntityCommand = 0
  let nextFacilityCommand = 0
  let nextInventoryCommand = 0
  let nextPlayerDamageCommand = 0
  let nextCraftingCommand = 0
  let nextBrewingCommand = 0
  let pendingBrewingCommand: CommandId | null = null
  // Every stand the server has described, so opening one shows its state
  // before the reply to the open command arrives.
  const brewingStands = new Map<string, BrewingState>()
  let nextAnvilCommand = 0
  let nextEnchantingCommand = 0
  let nextVillagerTradeCommand = 0
  let pendingVitalsCommand: CommandId | null = null
  let pendingInventoryCommand: {
    readonly commandId: CommandId
    readonly action: Extract<NetworkMessage, { readonly _tag: 'PlayerInventoryCommand' }>['action']
    acceptedRevision: number | null
  } | null = null
  type RetryableEntityCommand = WithoutAuthority<Extract<NetworkMessage, {
    readonly _tag: 'EntityAttackCommand' | 'EntityPickupCommand' | 'VehicleCommand'
  }>>
  let pendingEntityCommand: { readonly commandId: CommandId; readonly command: RetryableEntityCommand } | null = null
  let queuedEntityCommands: ReadonlyArray<RetryableEntityCommand> = []
  let pendingInventoryRetry: Extract<NetworkMessage, { readonly _tag: 'PlayerInventoryCommand' }>['action'] | null = null
  let pendingVillagerTradeCommand: CommandId | null = null
  let queuedHotbarSelection: number | null = null
  let pendingPlayerDamage: {
    readonly commandId: string
    readonly acceptedRevision: number | null
  } | null = null
  let playerDamageResyncPending = false
  let lastPlayerVitalsRevision = -1
  let lastCraftingInventoryRevision = -1
  let craftingStaleRetries = 0
  let pendingAnvilCommand: {
    readonly commandId: string
  } | null = null
  let pendingEnchantingCommand: {
    readonly commandId: string
  } | null = null
  let pendingFacilityCommand: {
    readonly commandId: CommandId
    readonly facility: 'container' | 'furnace'
    readonly facilityId: string
    readonly expectsDelta: boolean
    acceptedRevision: number | null
    facilityDeltaRevision: number | null
    inventoryDeltaRevision: number | null
  } | null = null
  // Set when a chest close was requested while a facility command was
  // already in flight (`setInventoryOpen`'s guard below) — the close never
  // got sent, so it must be retried once that command clears rather than
  // silently dropped. See `clearPendingFacilityCommand`.
  let nextPortalCommand = 1
  let pendingPortalCommand: CommandId | null = null
  let nextLeverCommand = 1
  let pendingLeverCommand: CommandId | null = null

  const enqueueMultiplayerPlayerMove = (nowSecs: number): void => {
    if (
      clientContext.multiplayer === undefined
      || !clientContext.state.multiplayerHandshakeComplete
      || nowSecs - clientContext.state.lastPlayerMoveSentAt < 0.1
    ) return
    const pose = Effect.runSync(clientContext.services.playerApi.pose)
    const worldId = WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension))
    const facing = { yawRadians: pose.yawRadians, pitchRadians: pose.pitchRadians }
    const changed = clientContext.state.lastPlayerMoveSent === undefined
      || clientContext.state.lastPlayerMoveSent.world !== worldId
      || clientContext.state.lastPlayerMoveSent.at.x !== pose.feetPosition.x
      || clientContext.state.lastPlayerMoveSent.at.y !== pose.feetPosition.y
      || clientContext.state.lastPlayerMoveSent.at.z !== pose.feetPosition.z
      || clientContext.state.lastPlayerMoveSent.facing.yawRadians !== facing.yawRadians
      || clientContext.state.lastPlayerMoveSent.facing.pitchRadians !== facing.pitchRadians
    if (!changed && nowSecs - clientContext.state.lastPlayerMoveSentAt < 1) return
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      _tag: 'PlayerMove',
      player: clientContext.multiplayer.query.player,
      world: worldId,
      at: pose.feetPosition,
      facing,
    }))
    clientContext.state.lastPlayerMoveSent = { world: worldId, at: pose.feetPosition, facing }
    clientContext.state.lastPlayerMoveSentAt = nowSecs
  }

  const drainMultiplayerInbound = (): void => {
    if (clientContext.multiplayer === undefined) return
    for (const message of Effect.runSync(Queue.clear(clientContext.multiplayer.transport.sleepInbound))) {
      if (message._tag === 'SleepSnapshot') clientContext.state.networkSleepState = sleepClientFromSnapshot(message.snapshot)
      else if (message._tag === 'SleepCommandResult') clientContext.state.networkSleepState = applySleepCommandResult(clientContext.state.networkSleepState, message.result)
      else if (message._tag === 'SleepEvents') clientContext.state.networkSleepState = applySleepEvents(clientContext.state.networkSleepState, message.revision, message.events)
      clientContext.state.sleepRuntimeState = initialSleepRuntimeState()
      for (const [player, location] of clientContext.state.networkSleepState.sleepers) {
        clientContext.state.sleepRuntimeState = enterSleep(clientContext.state.sleepRuntimeState, String(player), {
          dimension: 'overworld',
          position: location.bed,
          bedPosition: location.bed,
        })
      }
    }
    for (const message of Effect.runSync(Queue.clear(clientContext.multiplayer.transport.witherInbound))) {
      if (message._tag === 'WitherSnapshot') {
        clientContext.state.witherRevision = message.revision
        clientContext.state.witherRuntimeState = restoreWitherRuntime(message.snapshot)
      }
    }
    for (const message of Effect.runSync(Queue.clear(clientContext.multiplayer.transport.enderDragonInbound))) {
      if (message._tag === 'EnderDragonSnapshot' && message.revision >= clientContext.state.enderDragonRevision) {
        clientContext.state.enderDragonRevision = message.revision
        clientContext.state.authoritativeEnderDragonSnapshot = message.snapshot
      }
    }
    const multiplayer = clientContext.multiplayer
    Effect.runSync(Effect.flatMap(multiplayer.host.drainInbound, (messages) => Effect.forEach(messages, (message) => applyNetworkMessage(multiplayer, message), { discard: true })))
  }
  clientContext.ui.multiplayerStatus.hidden = clientContext.multiplayer === undefined
  clientContext.ui.multiplayerStatus.textContent = clientContext.multiplayer === undefined ? '' : 'Connecting to multiplayer server...'
  setMultiplayerChatVisibility(clientContext.ui.multiplayerChat, clientContext.multiplayer)
  clientContext.ui.canvas.setAttribute('data-multiplayer-connection', clientContext.multiplayer === undefined ? 'disabled' : 'connecting')
  clientContext.ui.canvas.setAttribute('data-multiplayer-player-count', '0')
  clientContext.ui.canvas.setAttribute('data-multiplayer-revision', '0')
  clientContext.ui.canvas.setAttribute('data-multiplayer-rejection', '')

  // A server message that does not decode, or that a local owner refuses, is
  // not applied; the failure is shown on the multiplayer status line like a
  // rejected mutation, and nothing later in the same message overwrites it.
  const reportServerStateFailure = (failure: ServerStateFailure): void => {
    console.error(`[mc-compose] multiplayer ${failure.what} from the server could not be applied`, failure.failure)
    if (failure._tag === 'InvalidServerState') {
      clientContext.state.multiplayerRejection = `invalid ${failure.what}`
      clientContext.ui.multiplayerStatus.textContent = `Invalid ${failure.what} from the multiplayer server was not applied.`
    } else {
      clientContext.state.multiplayerRejection = `unapplied ${failure.what}`
      clientContext.ui.multiplayerStatus.textContent = `The ${failure.what} from the multiplayer server could not be applied.`
    }
    clientContext.ui.multiplayerStatus.hidden = false
  }

  const sendVitalsCommand = (action: Extract<NetworkMessage, { readonly _tag: 'PlayerVitalsCommand' }>['action']): void => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete || pendingVitalsCommand !== null) return
    nextVitalsCommand += 1
    const commandId = commandIdFor('vitals', nextVitalsCommand)
    pendingVitalsCommand = commandId
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      _tag: 'PlayerVitalsCommand',
      commandId,
      player: clientContext.multiplayer.query.player,
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      expectedRevision: multiplayerRevision,
      action,
    }))
  }

  const sendPortalUseCommand = (
    portal: { readonly x: number; readonly y: number; readonly z: number },
    tag: 'EndPortalUseCommand' | 'NetherPortalUseCommand',
  ): boolean => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete || pendingPortalCommand !== null) return false
    nextPortalCommand += 1
    const commandId = commandIdFor(`${tag === 'EndPortalUseCommand' ? 'end' : 'nether'}-portal`, nextPortalCommand)
    pendingPortalCommand = commandId
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      _tag: tag,
      commandId,
      player: clientContext.multiplayer.query.player,
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      expectedRevision: multiplayerRevision,
      portal,
    }))
    return true
  }

  const sendEndProgressCommand = (
    command: { readonly _tag: 'ThrowEyeOfEnderCommand' }
      | { readonly _tag: 'InsertEyeIntoEndPortalFrameCommand'; readonly frame: { readonly x: number; readonly y: number; readonly z: number } },
  ): boolean => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete || pendingPortalCommand !== null) return false
    nextPortalCommand += 1
    const commandId = commandIdFor('end-eye', nextPortalCommand)
    pendingPortalCommand = commandId
    const header = {
      commandId,
      player: clientContext.multiplayer.query.player,
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      expectedRevision: multiplayerRevision,
    }
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound(
      command._tag === 'ThrowEyeOfEnderCommand'
        ? { _tag: command._tag, ...header }
        : { _tag: command._tag, ...header, frame: command.frame },
    ))
    return true
  }

  const sendToggleLeverCommand = (lever: { readonly x: number; readonly y: number; readonly z: number }): boolean => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete || pendingLeverCommand !== null) return false
    nextLeverCommand += 1
    const commandId = commandIdFor('lever', nextLeverCommand)
    pendingLeverCommand = commandId
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      _tag: 'ToggleLeverCommand',
      commandId,
      player: clientContext.multiplayer.query.player,
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      expectedRevision: multiplayerRevision,
      lever,
    }))
    return true
  }

  const sendInventoryCommand = (
    action: Extract<NetworkMessage, { readonly _tag: 'PlayerInventoryCommand' }>['action'],
  ): boolean => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete || pendingInventoryCommand !== null) return false
    nextInventoryCommand += 1
    const commandId = commandIdFor('inventory', nextInventoryCommand)
    pendingInventoryCommand = { commandId, action, acceptedRevision: null }
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      _tag: 'PlayerInventoryCommand',
      commandId,
      player: clientContext.multiplayer.query.player,
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      expectedRevision: multiplayerRevision,
      action,
    }))
    return true
  }

  const sendInventorySelection = (slot: number): boolean => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete) return false
    if (pendingInventoryCommand !== null) {
      queuedHotbarSelection = slot
      return true
    }
    return sendInventoryCommand({ _tag: 'select-slot', slot })
  }

  const sendVillagerTradeCommand = (villagerId: string, offerId: string): boolean => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete || pendingVillagerTradeCommand !== null) return false
    nextVillagerTradeCommand += 1
    const commandId = commandIdFor('villager-trade', nextVillagerTradeCommand)
    pendingVillagerTradeCommand = commandId
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      _tag: 'VillagerTradeCommand',
      commandId,
      player: clientContext.multiplayer.query.player,
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      expectedRevision: multiplayerRevision,
      villagerId,
      offerId,
      action: 'execute-trade',
    }))
    return true
  }

  const flushQueuedHotbarSelection = (): void => {
    if (pendingInventoryCommand !== null || queuedHotbarSelection === null) return
    const slot = queuedHotbarSelection
    queuedHotbarSelection = null
    sendInventorySelection(slot)
  }

  const replayPendingInventoryCommand = (): void => {
    if (pendingInventoryRetry === null || pendingInventoryCommand !== null) return
    const action = pendingInventoryRetry
    pendingInventoryRetry = null
    sendInventoryCommand(action)
  }

  const sendEntityCommand = (
    command: WithoutAuthority<Extract<NetworkMessage, { readonly _tag: 'EntityAttackCommand' | 'EntityPickupCommand' | 'BowUseCommand' | 'IgniteTntCommand' | 'EnderPearlCommand' | 'BucketUseCommand' | 'VehicleUseCommand' | 'FishingCommand' | 'VehicleCommand' }>>,
  ): void => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete) return
    if (command._tag === 'EntityAttackCommand' || command._tag === 'EntityPickupCommand' || command._tag === 'VehicleCommand') {
      const pickupIsPendingOrQueued = command._tag === 'EntityPickupCommand'
        && (
          (pendingEntityCommand?.command._tag === 'EntityPickupCommand'
            && pendingEntityCommand.command.entityId === command.entityId)
          || queuedEntityCommands.some((queued) =>
            queued._tag === 'EntityPickupCommand' && queued.entityId === command.entityId)
        )
      if (pickupIsPendingOrQueued) return
      if (pendingEntityCommand !== null) {
        queuedEntityCommands = [...queuedEntityCommands, command]
        return
      }
      nextEntityCommand += 1
      const commandId = commandIdFor('entity', nextEntityCommand)
      pendingEntityCommand = { commandId, command }
      Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
        ...command,
        commandId,
        player: clientContext.multiplayer.query.player,
        world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
        expectedRevision: multiplayerRevision,
      } as NetworkMessage))
      return
    }
    nextEntityCommand += 1
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      ...command,
      commandId: commandIdFor('entity', nextEntityCommand),
      player: clientContext.multiplayer.query.player,
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      expectedRevision: multiplayerRevision,
    } as NetworkMessage))
  }

  const pumpEntityCommands = (): void => {
    if (pendingEntityCommand !== null) return
    const [next, ...remaining] = queuedEntityCommands
    if (next === undefined) return
    queuedEntityCommands = remaining
    sendEntityCommand(next)
  }

  const resumeCommandsAfterResync = (): void => {
    replayPendingInventoryCommand()
    flushQueuedHotbarSelection()
    pumpEntityCommands()
  }

  const sendFacilityCommand = (
    command: WithoutAuthority<Extract<NetworkMessage, { readonly _tag: 'ContainerCommand' | 'FurnaceCommand' }>>,
  ): boolean => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete || pendingFacilityCommand !== null) return false
    nextFacilityCommand += 1
    const commandId = commandIdFor('facility', nextFacilityCommand)
    pendingFacilityCommand = {
      commandId,
      facility: command._tag === 'ContainerCommand' ? 'container' : 'furnace',
      facilityId: command._tag === 'ContainerCommand' ? command.containerId : command.furnaceId,
      expectsDelta: command.action._tag !== 'open' && command.action._tag !== 'close',
      acceptedRevision: null,
      facilityDeltaRevision: null,
      inventoryDeltaRevision: null,
    }
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      ...command,
      commandId,
      player: clientContext.multiplayer.query.player,
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      expectedRevision: multiplayerRevision,
    } as NetworkMessage))
    return true
  }

  // Every site that clears `pendingFacilityCommand` must go through here,
  // so a close that was blocked by an in-flight command (the guard in
  // `setInventoryOpen`) gets retried the moment that command resolves,
  // instead of leaving the dialog open until the player notices and
  // presses again. `setInventoryOpen(false)` is itself a safe no-op if
  // the inventory already closed some other way in the meantime.
  const clearPendingFacilityCommand = (): void => {
    pendingFacilityCommand = null
    if (clientContext.state.closeChestOnFacilityIdle) {
      clientContext.state.closeChestOnFacilityIdle = false
      clientContext.callbacks.setInventoryOpen(false)
    }
  }

  const pumpPlayerDamage = (): void => {
    if (
      clientContext.multiplayer === undefined
      || !clientContext.state.multiplayerHandshakeComplete
      || playerDamageResyncPending
      || pendingPlayerDamage !== null
    ) return
    const next = clientContext.state.queuedPlayerDamages[0]
    if (next === undefined) return
    clientContext.state.queuedPlayerDamages = clientContext.state.queuedPlayerDamages.slice(1)
    nextPlayerDamageCommand += 1
    const commandId = requestIdFor('damage', nextPlayerDamageCommand)
    pendingPlayerDamage = { commandId, acceptedRevision: null }
    const command = {
      _tag: 'PlayerDamageCommand' as const,
      commandId,
      player: String(clientContext.multiplayer.query.player),
      world: String(WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension))),
      expectedRevision: multiplayerRevision,
      amount: next.amount,
      minimumHealthPoints: next.minimumHealthPoints,
    } as PlayerDamageCommand & Readonly<{ minimumHealthPoints: number }>
    Effect.runSync(clientContext.multiplayer.transport.sendPlayerDamage(command))
  }

  const settlePlayerDamageAfterVitals = (revision: number): void => {
    lastPlayerVitalsRevision = Math.max(lastPlayerVitalsRevision, revision)
    const pending = pendingPlayerDamage
    if (
      pending !== null
      && pending.acceptedRevision !== null
      && revision >= pending.acceptedRevision
    ) {
      pendingPlayerDamage = null
      pumpPlayerDamage()
    }
  }

  const applyPlayerDamageResult = (message: PlayerDamageCommandResult): void => {
    if (clientContext.multiplayer === undefined || pendingPlayerDamage?.commandId !== message.commandId) return
    multiplayerRevision = Math.max(multiplayerRevision, message.revision)
    if (message.accepted) {
      pendingPlayerDamage = { ...pendingPlayerDamage, acceptedRevision: message.revision }
      if (lastPlayerVitalsRevision >= message.revision) {
        pendingPlayerDamage = null
        pumpPlayerDamage()
      }
      return
    }
    pendingPlayerDamage = null
    playerDamageResyncPending = true
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      _tag: 'AuthoritativeResyncRequest',
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      lastKnownRevision: multiplayerRevision,
    }))
  }

  const drainPlayerDamageInbound = (): void => {
    if (clientContext.multiplayer === undefined) return
    for (const message of Effect.runSync(Queue.clear(clientContext.multiplayer.transport.playerDamageInbound))) {
      if (message._tag === 'PlayerDamageCommandResult') applyPlayerDamageResult(message)
    }
  }

  const requestCrafting = (): void => {
    if (
      clientContext.multiplayer === undefined
      || !clientContext.state.multiplayerHandshakeComplete
      || clientContext.state.pendingCrafting !== null
    ) return
    const grid = clientContext.callbacks.getInventoryInteraction().state().grid
    const dimensions = grid.width === 2 && grid.height === 2
      ? { width: 2 as const, height: 2 as const }
      : grid.width === 3 && grid.height === 3
        ? { width: 3 as const, height: 3 as const }
        : undefined
    if (dimensions === undefined) return
    nextCraftingCommand += 1
    const commandId = requestIdFor('craft', nextCraftingCommand)
    clientContext.state.pendingCrafting = { commandId, acceptedRevision: null }
    const command: CraftingCommand = {
      _tag: 'CraftingCommand',
      commandId,
      player: String(clientContext.multiplayer.query.player),
      world: String(WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension))),
      expectedRevision: multiplayerRevision,
      grid: {
        ...dimensions,
        cells: grid.cells.map((cell) => cell?.item ?? null),
      },
    }
    Effect.runSync(clientContext.multiplayer.transport.sendCrafting(command))
  }

  const settleCraftingAfterInventory = (revision: number): Effect.Effect<void, ServerStateNotApplied> =>
    Effect.suspend(() => {
      lastCraftingInventoryRevision = Math.max(lastCraftingInventoryRevision, revision)
      const pending = clientContext.state.pendingCrafting
      if (
        pending === null
        || pending.acceptedRevision === null
        || revision < pending.acceptedRevision
      ) return Effect.void
      clientContext.state.pendingCrafting = null
      return appliedAs('crafting', Effect.asVoid(clientContext.callbacks.getInventoryInteraction().confirmCraftOnce()))
    })

  const applyCraftingResult = (message: CraftingCommandResult): void => {
    const pending = clientContext.state.pendingCrafting
    if (clientContext.multiplayer === undefined || pending?.commandId !== message.commandId) return
    multiplayerRevision = Math.max(multiplayerRevision, message.revision)
    if (!message.accepted) {
      clientContext.state.pendingCrafting = null
      Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
        _tag: 'AuthoritativeResyncRequest',
        world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
        lastKnownRevision: multiplayerRevision,
      }))
      // The server compares revisions for strict equality and advances its own
      // on any world activity, so a perfectly valid craft loses this race
      // whenever anything at all happens between reading the revision and the
      // server handling the command — another player, an entity tick, the
      // clock. The rejection carries the server's current revision, adopted
      // just above, so re-issuing sends a fresh one. Bounded, because a craft
      // rejected for any other reason must not spin.
      if (message.reason === 'stale-revision' && craftingStaleRetries < clientContext.services.craftingStaleRetryLimit) {
        craftingStaleRetries += 1
        requestCrafting()
        return
      }
      craftingStaleRetries = 0
      document.body.setAttribute('data-crafting-rejection', message.reason ?? 'unknown')
      return
    }
    craftingStaleRetries = 0
    document.body.removeAttribute('data-crafting-rejection')
    clientContext.state.pendingCrafting = { ...pending, acceptedRevision: message.revision }
    if (lastCraftingInventoryRevision >= message.revision) {
      clientContext.state.pendingCrafting = null
      Effect.runSync(clientContext.callbacks.getInventoryInteraction().confirmCraftOnce())
    }
  }

  const drainCraftingInbound = (): void => {
    if (clientContext.multiplayer === undefined) return
    for (const message of Effect.runSync(Queue.clear(clientContext.multiplayer.transport.craftingInbound))) {
      if (message._tag === 'CraftingCommandResult') applyCraftingResult(message)
    }
  }

  const activeBrewingStandKey = (world: WorldId): string | undefined =>
    clientContext.state.brewingOpen && clientContext.state.activeBrewingStandAt !== undefined
      ? brewingStandKey(world, clientContext.state.activeBrewingStandAt)
      : undefined

  // The brewing owner holds the open stand, so the brewing UI reads the
  // server's stand exactly as it reads the single-player one.
  const applyBrewingStand = (state: BrewingState): Effect.Effect<void, ServerStateNotApplied> =>
    appliedAs('brewing stand', Effect.asVoid(clientContext.services.gameplayCommit.coordinator.commitFromSnapshot(
      GAMEPLAY_BREWING_OWNER_ID,
      BrewingServiceStateSchema,
      (snapshot) => Effect.succeed({
        expectedRevision: snapshot.revision,
        expectedDimensions: [],
        changes: [{ ownerId: GAMEPLAY_BREWING_OWNER_ID, state }],
      }),
    )))

  const requestBrewing = (action: BrewingAction): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const multiplayer = clientContext.multiplayer
      const at = clientContext.state.activeBrewingStandAt
      if (multiplayer === undefined || !clientContext.state.brewingOpen || at === undefined) return false
      const world = WorldId.make(yield* appliedAs('brewing stand', clientContext.services.playerApi.dimension))
      const known = action._tag === 'open' ? brewingStands.get(brewingStandKey(world, at)) : undefined
      if (known !== undefined) {
        yield* applyBrewingStand(known)
        clientContext.callbacks.renderBrewingUi()
      }
      if (!clientContext.state.multiplayerHandshakeComplete || pendingBrewingCommand !== null) return false
      // The codec bounds slot and bottle indices; an out-of-range command is
      // refused here rather than dropped unencoded by the outbound stage.
      const command = Schema.decodeUnknownResult(BrewingCommand)({
        _tag: 'BrewingCommand',
        action,
        at: { x: at.x, y: at.y, z: at.z },
        commandId: commandIdFor('brewing', nextBrewingCommand + 1),
        expectedRevision: multiplayerRevision,
        player: multiplayer.query.player,
        world,
      })
      if (Result.isFailure(command)) {
        console.error('[mc-compose] multiplayer brewing command is invalid', command.failure)
        clientContext.state.brewingStatus = 'Cannot send brewing command: invalid-command'
        clientContext.callbacks.renderBrewingUi()
        return false
      }
      nextBrewingCommand += 1
      pendingBrewingCommand = command.success.commandId
      yield* multiplayer.host.enqueueOutbound(command.success)
      return true
    }).pipe(Effect.catch((failure) => Effect.sync(() => {
      reportServerStateFailure(failure)
      return false
    })))

  const requestAnvil = (): boolean => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete || pendingAnvilCommand !== null) return false
    nextAnvilCommand += 1
    const commandId = requestIdFor('anvil', nextAnvilCommand)
    pendingAnvilCommand = { commandId }
    const command: AnvilCommand = {
      _tag: 'AnvilCommand',
      commandId,
      player: String(clientContext.multiplayer.query.player),
      world: String(WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension))),
      expectedRevision: multiplayerRevision,
      slot: clientContext.state.selectedHotbarIndex,
      name: clientContext.state.anvilName.trim(),
    }
    Effect.runSync(clientContext.multiplayer.transport.sendAnvil(command))
    return true
  }

  const requestEnchanting = (offer: 0 | 1 | 2): boolean => {
    if (clientContext.multiplayer === undefined || !clientContext.state.multiplayerHandshakeComplete || pendingEnchantingCommand !== null) return false
    nextEnchantingCommand += 1
    const commandId = requestIdFor('enchanting', nextEnchantingCommand)
    pendingEnchantingCommand = { commandId }
    const command: EnchantingCommand = {
      _tag: 'EnchantingCommand',
      commandId,
      player: String(clientContext.multiplayer.query.player),
      world: String(WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension))),
      expectedRevision: multiplayerRevision,
      slot: clientContext.state.selectedHotbarIndex,
      offer,
    }
    Effect.runSync(clientContext.multiplayer.transport.sendEnchanting(command))
    return true
  }

  const resyncAnvil = (): void => {
    if (clientContext.multiplayer === undefined) return
    Effect.runSync(clientContext.multiplayer.host.enqueueOutbound({
      _tag: 'AuthoritativeResyncRequest',
      world: WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)),
      lastKnownRevision: multiplayerRevision,
    }))
  }

  const applyAnvilResult = (message: AnvilCommandResult): void => {
    if (clientContext.multiplayer === undefined || pendingAnvilCommand?.commandId !== message.commandId) return
    multiplayerRevision = Math.max(multiplayerRevision, message.revision)
    pendingAnvilCommand = null
    if (message.accepted) return
    clientContext.state.anvilStatus = `Cannot use anvil: ${message.reason}`
    resyncAnvil()
    clientContext.callbacks.renderPlayerUi()
  }

  const drainAnvilInbound = (): void => {
    if (clientContext.multiplayer === undefined) return
    const currentWorld = String(WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)))
    for (const message of Effect.runSync(Queue.clear(clientContext.multiplayer.transport.anvilInbound))) {
      if (message._tag === 'AnvilCommandResult') {
        applyAnvilResult(message)
        continue
      }
      if (message._tag !== 'PlayerAnvilNamesDelta') continue
      if (
        message.world !== currentWorld
        || message.revision < multiplayerRevision
        || message.player !== String(clientContext.multiplayer.query.player)
      ) continue
      multiplayerRevision = Math.max(multiplayerRevision, message.revision)
      for (const key of [...clientContext.state.customNames.keys()]) if (/^\d+$/u.test(key)) clientContext.state.customNames.delete(key)
      for (const { slot, name } of message.names) clientContext.state.customNames.set(String(slot), name)
      clientContext.callbacks.renderPlayerUi()
    }
  }

  const applyEnchantingResult = (message: EnchantingCommandResult): void => {
    if (clientContext.multiplayer === undefined || pendingEnchantingCommand?.commandId !== message.commandId) return
    multiplayerRevision = Math.max(multiplayerRevision, message.revision)
    pendingEnchantingCommand = null
    if (message.accepted) return
    clientContext.state.enchantingStatus = `Cannot enchant: ${message.reason}`
    resyncAnvil()
    clientContext.callbacks.renderPlayerUi()
  }

  const drainEnchantingInbound = (): void => {
    if (clientContext.multiplayer === undefined) return
    const currentWorld = String(WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension)))
    for (const message of Effect.runSync(Queue.clear(clientContext.multiplayer.transport.enchantingInbound))) {
      if (message._tag === 'EnchantingCommandResult') {
        applyEnchantingResult(message)
        continue
      }
      if (message._tag !== 'PlayerEnchantmentsDelta') continue
      if (
        message.world !== currentWorld
        || message.revision < multiplayerRevision
        || message.player !== String(clientContext.multiplayer.query.player)
      ) continue
      const items = Result.all(message.items.map(({ slot, item }) =>
        Result.map(enchantedItemWithLevels(item), (decoded) => ({ slot, item: decoded }))))
      if (Result.isFailure(items)) {
        reportServerStateFailure(invalidServerState('enchantments')(items.failure))
        continue
      }
      multiplayerRevision = Math.max(multiplayerRevision, message.revision)
      clientContext.state.enchantmentSeed = message.seed
      for (const key of [...clientContext.state.enchantedItems.keys()]) if (/^\d+$/u.test(key)) clientContext.state.enchantedItems.delete(key)
      for (const { slot, item } of items.success) clientContext.state.enchantedItems.set(String(slot), item)
      clientContext.callbacks.renderPlayerUi()
    }
  }

  document.addEventListener('mc-entity-command', (event) => {
    const detail = (event as CustomEvent<{ readonly entityId: string; readonly action: 'attack' | 'pickup' | 'mount' | 'dismount' | 'move'; readonly direction?: 'forward' | 'backward' }>).detail
    if (detail === undefined) return
    const entityId = EntityId.make(detail.entityId)
    // A command names the player's dimension, which is read from the world.
    clientContext.services.deferToFrameBoundary(() => {
      if (detail.action === 'attack') sendEntityCommand({ _tag: 'EntityAttackCommand', entityId, heldSlot: clientContext.state.selectedHotbarIndex })
      else if (detail.action === 'pickup') sendEntityCommand({ _tag: 'EntityPickupCommand', entityId })
      else if (detail.action !== 'move') sendEntityCommand({
        _tag: 'VehicleCommand',
        entityId,
        action: detail.action,
      })
      else if (detail.direction !== undefined) sendEntityCommand({ _tag: 'VehicleCommand', entityId, action: { _tag: 'move', direction: detail.direction } })
    })
  })

  // The apply steps below run only on fully decoded values. Each owner write
  // that can still fail comes before the revision update and the resolution
  // of pending commands, so a refused write leaves both untouched.

  type DecodedWorldSnapshot = Result.Result.Success<ReturnType<typeof decodeWorldSnapshot>>
  type DecodedBlockEdit = DecodedWorldSnapshot['blocks'][number]
  type DecodedVitals = Result.Result.Success<ReturnType<typeof decodeNetworkVitals>>
  type DecodedInventory = Result.Result.Success<ReturnType<typeof decodeNetworkInventory>>
  type DecodedVillagerTrade = Result.Result.Success<ReturnType<typeof decodeNetworkVillagerTrade>>
  type DecodedTimeWeather = Result.Result.Success<ReturnType<typeof decodeNetworkTimeWeather>>

  const decodeLocalInventory = (state: NetworkInventoryState): Effect.Effect<DecodedInventory, ServerStateFailure> =>
    Effect.flatMap(
      appliedAs('inventory', clientContext.services.world.inventory.storageSnapshot),
      (storage) => Effect.fromResult(decodeNetworkInventory(state, storage)),
    )

  const decodeAuthoritativeSnapshot = (message: NetworkAuthoritativeSnapshot, localPlayer: PlayerId) =>
    Effect.gen(function* () {
      const vitals = message.vitals.find(({ player }) => player === localPlayer)
      const inventory = message.inventories.find(({ player }) => player === localPlayer)
      return {
        message,
        vitals: vitals === undefined ? undefined : yield* Effect.fromResult(decodeNetworkVitals(vitals.state)),
        inventory: inventory === undefined ? undefined : yield* decodeLocalInventory(inventory.state),
        villagerTrades: yield* Effect.fromResult(Result.all(message.villagerTrades.map(decodeNetworkVillagerTrade))),
        timeWeather: yield* Effect.fromResult(decodeNetworkTimeWeather(message.timeWeather)),
        containers: yield* Effect.fromResult(Result.flatMap(
          Result.all(message.containers.map(decodeNetworkContainer)),
          decodeNetworkContainers,
        )),
        // A snapshot replaces every furnace, so each location comes from its id.
        furnaces: yield* Effect.fromResult(Result.all(message.furnaces.map((furnace) => decodeNetworkFurnace(furnace, undefined)))),
        vehicles: yield* Effect.fromResult(decodeNetworkVehicles(message.entities ?? [])),
      }
    })

  type DecodedAuthoritativeSnapshot = Effect.Success<ReturnType<typeof decodeAuthoritativeSnapshot>>

  const applyNetworkBlockEdit = (edit: DecodedBlockEdit): Effect.Effect<void, ServerStateNotApplied> =>
    Effect.gen(function* () {
      const context = clientContext.services.getOrCreateDimensionChunkContext(edit.dimension)
      yield* appliedAs('block', context.chunkStore.setBlock(edit.cell, edit.id))
      if (edit.dimension === clientContext.services.currentChunkContext().dimension) clientContext.state.redstoneDirty = true
    })

  const applyWorldSnapshot = (
    multiplayer: MultiplayerRuntime,
    { message, blocks }: DecodedWorldSnapshot,
  ): Effect.Effect<void, ServerStateNotApplied> =>
    Effect.gen(function* () {
      for (const edit of blocks) yield* applyNetworkBlockEdit(edit)
      multiplayerRevision = message.revision
      multiplayer.players.clear()
      for (const player of message.players) {
        if (player.player !== multiplayer.query.player) multiplayer.players.set(player.player, player)
      }
      const dimension = dimensionFromWorld(message.world)
      if (dimension !== undefined) {
        const dimensionKeyPrefix = `${JSON.stringify(dimension)},`
        for (const key of clientContext.state.poweredRails) {
          if (key.startsWith(dimensionKeyPrefix)) clientContext.state.poweredRails.delete(key)
        }
        for (const rail of message.poweredRails) {
          const key = clientContext.services.leverKeyOf({ dimension, position: rail.at })
          if (rail.powered) clientContext.state.poweredRails.add(key)
        }
        for (const [key, lever] of clientContext.state.leverStates) {
          if (lever.dimension === dimension) clientContext.state.leverStates.delete(key)
        }
        for (const lever of message.levers) {
          clientContext.state.leverStates.set(clientContext.services.leverKeyOf({ dimension, position: lever.at }), {
            dimension,
            position: { ...lever.at },
            active: lever.active,
          })
        }
        if (dimension === clientContext.services.currentChunkContext().dimension) clientContext.state.redstoneDirty = true
      }
      pendingLeverCommand = null
    })

  const applyNetworkVitals = (vitals: DecodedVitals): Effect.Effect<void, ServerStateNotApplied> =>
    Effect.gen(function* () {
      const current = yield* appliedAs('vitals', clientContext.services.world.vitals.snapshot)
      yield* appliedAs('vitals', clientContext.services.world.vitals.restore({ ...current, ...vitals }))
      clientContext.callbacks.renderPlayerUi()
    })

  const applyNetworkInventory = (inventory: DecodedInventory): Effect.Effect<void, ServerStateNotApplied> =>
    Effect.gen(function* () {
      yield* appliedAs('inventory', clientContext.services.world.inventory.restoreStorage(inventory.storage))
      clientContext.state.selectedHotbarIndex = inventory.selectedSlot
    })

  // The villager-trade owner is the store, so the server's offers are
  // committed to it on top of whatever the owner holds at commit time, all
  // villagers of one message in one commit.
  const applyNetworkVillagerTrades = (
    trades: ReadonlyArray<DecodedVillagerTrade>,
  ): Effect.Effect<void, ServerStateNotApplied> =>
    trades.length === 0
      ? Effect.void
      : appliedAs('villager trade', Effect.asVoid(clientContext.services.gameplayCommit.coordinator.commitFromSnapshot(
          GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
          GameplayVillagerTradeSnapshotSchema,
          (snapshot) => Effect.sync(() => ({
            expectedRevision: snapshot.revision,
            expectedDimensions: [],
            changes: [{
              ownerId: GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
              state: {
                ...snapshot.state,
                villagers: snapshot.state.villagers.map((villager) => trades
                  .filter((trade) => trade.villagerId === villager.id)
                  .reduce((current, trade) => ({
                    ...current,
                    offers: current.offers.map((offer) => {
                      const networkOffer = trade.offers.get(offer.id)
                      return networkOffer === undefined ? offer : { ...offer, ...networkOffer }
                    }),
                  }), villager)),
              },
            }],
          })),
        )))

  const applyNetworkTimeWeather = (timeWeather: DecodedTimeWeather): Effect.Effect<void, ServerStateNotApplied> =>
    Effect.gen(function* () {
      yield* appliedAs('weather', clientContext.services.weather.applyTransition(timeWeather.weather))
      yield* clientContext.services.time.setTimeOfDay(timeWeather.timeOfDay)
      clientContext.services.presentWeather(timeWeather.weather)
    })

  const applyAuthoritativeSnapshot = (decoded: DecodedAuthoritativeSnapshot): Effect.Effect<void, ServerStateNotApplied> =>
    Effect.gen(function* () {
      const { message } = decoded
      if (decoded.vitals !== undefined) yield* applyNetworkVitals(decoded.vitals)
      if (decoded.inventory !== undefined) yield* applyNetworkInventory(decoded.inventory)
      yield* applyNetworkVillagerTrades(decoded.villagerTrades)
      yield* applyNetworkTimeWeather(decoded.timeWeather)
      yield* appliedAs('container', clientContext.services.world.inventory.restoreContainerStorage(decoded.containers))
      multiplayerRevision = message.revision
      if (decoded.vitals !== undefined) settlePlayerDamageAfterVitals(message.revision)
      clientContext.state.networkFishingState = { phase: 'idle', result: 'idle' }
      clientContext.state.furnaceStates.clear()
      for (const { furnaceId, furnace } of decoded.furnaces) clientContext.state.furnaceStates.set(furnaceId, furnace)
      if (
        clientContext.state.inventoryOpen
        && clientContext.state.inventoryMode === 'chest'
        && clientContext.state.activeChestId !== undefined
        && !message.containers.some(({ containerId }) => containerId === clientContext.state.activeChestId)
      ) {
        clientContext.state.activeChestId = undefined
        clientContext.callbacks.setInventoryOpen(false)
      }
      if (
        clientContext.state.inventoryOpen
        && clientContext.state.inventoryMode === 'furnace'
        && clientContext.state.activeFurnaceKey !== undefined
        && !clientContext.state.furnaceStates.has(clientContext.state.activeFurnaceKey)
      ) {
        clientContext.state.activeFurnaceKey = undefined
        clientContext.callbacks.setInventoryOpen(false)
      }
      clientContext.state.multiplayerEntities.clear()
      for (const entity of message.entities ?? []) clientContext.state.multiplayerEntities.set(entity.entityId, entity)
      for (const vehicle of decoded.vehicles) clientContext.services.applyAuthoritativeVehicle(vehicle)
      if (playerDamageResyncPending) {
        playerDamageResyncPending = false
        pendingPlayerDamage = null
        pumpPlayerDamage()
      }
      resumeCommandsAfterResync()
      pendingVillagerTradeCommand = null
    })

  const handleNetworkMessage = (
    multiplayer: MultiplayerRuntime,
    message: NetworkMessage,
  ): Effect.Effect<void, ServerStateFailure> =>
    Effect.gen(function* () {
      const localPlayer = multiplayer.query.player
      switch (message._tag) {
        case 'WorldSnapshot': {
          if (message.revision < multiplayerRevision) return
          const decoded = yield* Effect.fromResult(decodeWorldSnapshot(message))
          yield* applyWorldSnapshot(multiplayer, decoded)
          return
        }
        case 'AuthoritativeSnapshot': {
          if (message.revision < multiplayerRevision) {
            resumeCommandsAfterResync()
            return
          }
          const decoded = yield* decodeAuthoritativeSnapshot(message, localPlayer)
          yield* applyAuthoritativeSnapshot(decoded)
          return
        }
        case 'RealmTransferSnapshot': {
          if (message.player !== localPlayer) return
          const dimension = dimensionFromWorld(message.destinationWorld)
          if (dimension === undefined) return
          const feet = yield* Effect.fromResult(
            Result.mapError(networkPosition(message.at), invalidServerState('realm transfer position')),
          )
          const worldSnapshot = yield* Effect.fromResult(decodeWorldSnapshot(message.worldSnapshot))
          const authoritativeSnapshot = yield* decodeAuthoritativeSnapshot(message.authoritativeSnapshot, localPlayer)
          // Each realm maintains its own revision sequence, so the destination's
          // world snapshot is adopted whatever the current revision.
          yield* applyWorldSnapshot(multiplayer, worldSnapshot)
          if (authoritativeSnapshot.message.revision < multiplayerRevision) resumeCommandsAfterResync()
          else yield* applyAuthoritativeSnapshot(authoritativeSnapshot)
          yield* appliedAs('realm transfer position', clientContext.services.playerApi.restore({
            feetPosition: feet,
            yawRadians: message.facing.yawRadians,
            pitchRadians: message.facing.pitchRadians,
          }, dimension))
          clientContext.services.alignActiveDimension(dimension)
          clientContext.services.resetSimState(true)
          clientContext.state.lastPlayerMoveSent = { world: message.destinationWorld, at: message.at, facing: message.facing }
          clientContext.state.lastPlayerMoveSentAt = performance.now() / 1_000
          pendingPortalCommand = null
          clientContext.ui.multiplayerStatus.textContent = `Connected to multiplayer server (${dimension})`
          return
        }
        case 'EyeOfEnderThrown': {
          if (message.revision < multiplayerRevision) return
          const origin = yield* Effect.fromResult(
            Result.mapError(networkPosition(message.origin), invalidServerState('eye of ender position')),
          )
          multiplayerRevision = message.revision
          const dimension = dimensionFromWorld(message.world)
          if (dimension === undefined || dimension !== clientContext.services.currentChunkContext().dimension) return
          const dx = message.target.x - message.origin.x
          const dz = message.target.z - message.origin.z
          clientContext.ui.canvas.setAttribute('data-stronghold-direction', String(Math.atan2(dx, -dz)))
          clientContext.ui.canvas.setAttribute('data-stronghold-distance', String(Math.round(Math.hypot(dx, dz))))
          clientContext.state.eyeOfEnderRuntimeState = launchRuntimeEyeOfEnder(clientContext.state.eyeOfEnderRuntimeState, {
            dimension,
            position: message.origin,
            target: message.target,
            breaks: message.breaks,
          })
          clientContext.services.queueEndAudio('eyeThrow', origin)
          return
        }
        case 'EntitySpawnDelta':
        case 'EntityUpdateDelta': {
          if (message.revision < multiplayerRevision) return
          const vehicles = yield* Effect.fromResult(decodeNetworkVehicles([message.entity]))
          multiplayerRevision = message.revision
          clientContext.state.multiplayerEntities.set(message.entity.entityId, message.entity)
          for (const vehicle of vehicles) clientContext.services.applyAuthoritativeVehicle(vehicle)
          return
        }
        case 'EntityDespawnDelta': {
          if (message.revision < multiplayerRevision) return
          multiplayerRevision = message.revision
          clientContext.state.multiplayerEntities.delete(message.entityId)
          const existingVehicle = clientContext.services.vehicleById(String(message.entityId))
          if (existingVehicle !== undefined) Effect.runSync(clientContext.services.vehicleService.despawn(existingVehicle.id))
          return
        }
        case 'PlayerInventoryDelta': {
          if (message.revision < multiplayerRevision) return
          if (message.player !== localPlayer) {
            multiplayerRevision = message.revision
            return
          }
          const inventory = yield* decodeLocalInventory(message.state)
          yield* applyNetworkInventory(inventory)
          multiplayerRevision = message.revision
          yield* settleCraftingAfterInventory(message.revision)
          if (pendingFacilityCommand !== null) {
            pendingFacilityCommand.inventoryDeltaRevision = message.revision
            if (
              pendingFacilityCommand.acceptedRevision !== null
              && pendingFacilityCommand.facilityDeltaRevision !== null
              && message.revision >= pendingFacilityCommand.acceptedRevision
              && pendingFacilityCommand.facilityDeltaRevision >= pendingFacilityCommand.acceptedRevision
            ) clearPendingFacilityCommand()
          }
          if (
            pendingInventoryCommand !== null
            && pendingInventoryCommand.acceptedRevision !== null
            && message.revision >= pendingInventoryCommand.acceptedRevision
          ) {
            pendingInventoryCommand = null
            flushQueuedHotbarSelection()
          }
          return
        }
        case 'PlayerVitalsDelta': {
          if (message.revision < multiplayerRevision) return
          if (message.player !== localPlayer) {
            multiplayerRevision = message.revision
            return
          }
          const vitals = yield* Effect.fromResult(decodeNetworkVitals(message.state))
          yield* applyNetworkVitals(vitals)
          multiplayerRevision = message.revision
          settlePlayerDamageAfterVitals(message.revision)
          return
        }
        case 'PlayerFishingDelta':
          if (message.revision < multiplayerRevision) return
          multiplayerRevision = message.revision
          if (message.player === localPlayer) {
            clientContext.state.networkFishingState = message.state
            clientContext.state.fishingResult = message.state.result
            document.body.setAttribute('data-fishing-result', message.state.result)
            document.body.setAttribute('data-fishing-phase', message.state.phase)
          }
          return
        case 'WorldTimeWeatherDelta': {
          if (message.revision < multiplayerRevision) return
          const timeWeather = yield* Effect.fromResult(decodeNetworkTimeWeather(message.state))
          yield* applyNetworkTimeWeather(timeWeather)
          multiplayerRevision = message.revision
          return
        }
        case 'LightningStrikeDelta': {
          if (message.revision < multiplayerRevision) return
          const strike = yield* Effect.fromResult(
            Result.mapError(networkPosition(message.at), invalidServerState('lightning position')),
          )
          multiplayerRevision = message.revision
          clientContext.state.authoritativeLightning = {
            sequence: message.revision,
            at: strike,
            expiresAtSecs: performance.now() / 1_000 + 0.35,
          }
          return
        }
        case 'ContainerDelta': {
          if (message.revision < multiplayerRevision) return
          const current = yield* clientContext.services.world.inventory.containerStorageSnapshot
          const container = yield* Effect.fromResult(decodeNetworkContainer(message.state))
          const containers = yield* Effect.fromResult(decodeNetworkContainers([
            ...current.containers.filter(({ id }) => id !== message.state.containerId),
            container,
          ]))
          yield* appliedAs('container', clientContext.services.world.inventory.restoreContainerStorage(containers))
          multiplayerRevision = message.revision
          if (
            pendingFacilityCommand?.facility === 'container'
            && pendingFacilityCommand.facilityId === message.state.containerId
          ) pendingFacilityCommand.facilityDeltaRevision = message.revision
          if (clientContext.state.inventoryOpen && clientContext.state.inventoryMode === 'chest' && clientContext.state.activeChestId === message.state.containerId) clientContext.callbacks.renderPlayerUi()
          return
        }
        case 'FurnaceDelta': {
          if (message.revision < multiplayerRevision) return
          const { furnaceId, furnace } = yield* Effect.fromResult(
            decodeNetworkFurnace(message.state, clientContext.state.furnaceStates.get(message.state.furnaceId)),
          )
          multiplayerRevision = message.revision
          clientContext.state.furnaceStates.set(furnaceId, furnace)
          if (
            pendingFacilityCommand?.facility === 'furnace'
            && pendingFacilityCommand.facilityId === message.state.furnaceId
          ) pendingFacilityCommand.facilityDeltaRevision = message.revision
          if (clientContext.state.inventoryOpen && clientContext.state.inventoryMode === 'furnace' && clientContext.state.activeFurnaceKey === message.state.furnaceId) clientContext.callbacks.renderPlayerUi()
          return
        }
        case 'BrewingStandDelta': {
          if (message.revision < multiplayerRevision) return
          const stand = yield* Effect.fromResult(
            Result.mapError(brewingStateFromWire(message.state), invalidServerState('brewing stand')),
          )
          const key = brewingStandKey(message.world, message.at)
          const world = WorldId.make(yield* appliedAs('brewing stand', clientContext.services.playerApi.dimension))
          const active = activeBrewingStandKey(world) === key
          if (active) yield* applyBrewingStand(stand)
          brewingStands.set(key, stand)
          multiplayerRevision = message.revision
          if (active) clientContext.callbacks.renderBrewingUi()
          return
        }
        case 'PlayerStatusEffectsDelta': {
          if (message.revision < multiplayerRevision) return
          if (message.player === localPlayer) {
            // The wire may omit an amplifier the owner requires; such a state is refused.
            const effects = yield* Effect.fromResult(Result.mapError(
              Schema.decodeUnknownResult(StatusEffectStateSchema)(message.state),
              invalidServerState('status effects'),
            ))
            yield* appliedAs('status effects', restoreStatusEffects(
              clientContext.services.gameplayState,
              effects,
              clientContext.services.gameplayCommit,
            ))
          }
          multiplayerRevision = message.revision
          return
        }
        case 'BrewingCommandAccepted':
        case 'BrewingCommandRejected':
          multiplayerRevision = Math.max(multiplayerRevision, message.revision)
          if (message.commandId !== pendingBrewingCommand) return
          pendingBrewingCommand = null
          clientContext.state.brewingStatus = message._tag === 'BrewingCommandAccepted'
            ? ''
            : `Cannot use brewing stand: ${message.reason}`
          clientContext.callbacks.renderBrewingUi()
          return
        case 'VillagerTradeDelta': {
          if (message.revision < multiplayerRevision) return
          const trade = yield* Effect.fromResult(decodeNetworkVillagerTrade(message.state))
          yield* applyNetworkVillagerTrades([trade])
          multiplayerRevision = message.revision
          if (clientContext.state.activeVillagerId === message.state.villagerId) {
            clientContext.state.tradeStatus = 'Trade complete'
            clientContext.callbacks.renderTradeUi()
          }
          return
        }
        case 'AuthoritativeCommandAccepted':
          multiplayerRevision = Math.max(multiplayerRevision, message.revision)
          if (message.commandId === pendingVitalsCommand) pendingVitalsCommand = null
          if (message.commandId === pendingPortalCommand) pendingPortalCommand = null
          if (message.commandId === pendingInventoryCommand?.commandId) {
            pendingInventoryCommand.acceptedRevision = message.revision
          }
          if (message.commandId === pendingEntityCommand?.commandId) {
            pendingEntityCommand = null
            pumpEntityCommands()
          }
          if (message.commandId === pendingFacilityCommand?.commandId) {
            if (!pendingFacilityCommand.expectsDelta) clearPendingFacilityCommand()
            else if (
              pendingFacilityCommand.facilityDeltaRevision !== null
              && pendingFacilityCommand.inventoryDeltaRevision !== null
              && pendingFacilityCommand.facilityDeltaRevision >= message.revision
              && pendingFacilityCommand.inventoryDeltaRevision >= message.revision
            ) clearPendingFacilityCommand()
            else pendingFacilityCommand.acceptedRevision = message.revision
          }
          if (message.commandId === pendingVillagerTradeCommand) {
            pendingVillagerTradeCommand = null
            clientContext.state.tradeStatus = 'Trade complete'
            if (clientContext.state.tradeOpen) clientContext.callbacks.renderTradeUi()
          }
          return
        case 'AuthoritativeCommandRejected':
          multiplayerRevision = Math.max(multiplayerRevision, message.revision)
          clientContext.state.multiplayerRejection = message.reason
          if (message.commandId === pendingPortalCommand) pendingPortalCommand = null
          if (message.commandId === pendingLeverCommand) pendingLeverCommand = null
          if (message.commandId === pendingVitalsCommand) pendingVitalsCommand = null
          if (message.commandId === pendingInventoryCommand?.commandId) {
            if (message.resyncRequired) pendingInventoryRetry = pendingInventoryCommand.action
            pendingInventoryCommand = null
            if (!message.resyncRequired) flushQueuedHotbarSelection()
          }
          if (message.commandId === pendingEntityCommand?.commandId) {
            const command = pendingEntityCommand.command
            pendingEntityCommand = null
            if (message.resyncRequired) {
              queuedEntityCommands = [command, ...queuedEntityCommands]
            }
            else pumpEntityCommands()
          }
          if (message.commandId === pendingFacilityCommand?.commandId) {
            clearPendingFacilityCommand()
            clientContext.state.chestStatus = message.reason
            clientContext.state.furnaceStatus = message.reason
            if (clientContext.state.inventoryOpen) clientContext.callbacks.renderPlayerUi()
          }
          if (message.resyncRequired) yield* multiplayer.host.enqueueOutbound({ _tag: 'AuthoritativeResyncRequest', world: message.world, lastKnownRevision: multiplayerRevision })
          return
        case 'PlayerJoin':
          if (message.player !== localPlayer) {
            multiplayer.players.set(message.player, {
              name: message.name,
              world: WorldId.make(clientContext.services.currentChunkContext().dimension),
              at: message.at,
              facing: { yawRadians: 0, pitchRadians: 0 },
            })
          }
          return
        case 'PlayerMove': {
          if (message.player === localPlayer) {
            const worldId = message.world ?? WorldId.make(Effect.runSync(clientContext.services.playerApi.dimension))
            const dimension = dimensionFromWorld(worldId)
            if (dimension === undefined) return
            const feet = yield* Effect.fromResult(
              Result.mapError(networkPosition(message.at), invalidServerState('movement correction')),
            )
            yield* appliedAs('movement correction', clientContext.services.playerApi.restore({
              feetPosition: feet,
              yawRadians: message.facing.yawRadians,
              pitchRadians: message.facing.pitchRadians,
            }, dimension))
            clientContext.state.lastPlayerMoveSent = { world: worldId, at: message.at, facing: message.facing }
            clientContext.state.lastPlayerMoveSentAt = performance.now() / 1_000
            clientContext.ui.multiplayerStatus.textContent = 'Movement corrected by server.'
            clientContext.ui.multiplayerStatus.hidden = false
            return
          }
          const previous = multiplayer.players.get(message.player)
          multiplayer.players.set(message.player, {
            name: previous?.name ?? PlayerName.make(String(message.player)),
            world: message.world ?? previous?.world ?? WorldId.make(clientContext.services.currentChunkContext().dimension),
            at: message.at,
            facing: message.facing,
          })
          return
        }
        case 'PlayerLeave':
          multiplayer.players.delete(message.player)
          return
        case 'BlockPlace': {
          const worldId = message.world ?? WorldId.make(clientContext.services.currentChunkContext().dimension)
          const edit = yield* Effect.fromResult(decodeNetworkBlock(worldId, message.at, message.block))
          if (edit !== undefined) yield* applyNetworkBlockEdit(edit)
          multiplayerRevision += 1
          return
        }
        case 'BlockBreak': {
          const worldId = message.world ?? WorldId.make(clientContext.services.currentChunkContext().dimension)
          const edit = yield* Effect.fromResult(decodeNetworkBlock(worldId, message.at, null))
          if (edit !== undefined) {
            yield* applyNetworkBlockEdit(edit)
            clientContext.state.leverStates.delete(clientContext.services.leverKeyOf({ dimension: edit.dimension, position: message.at }))
          }
          multiplayerRevision += 1
          return
        }
        case 'BlockMutationRejected':
          multiplayerRevision = Math.max(multiplayerRevision, message.revision)
          clientContext.state.multiplayerRejection = `${message.operation}: ${message.reason}`
          clientContext.ui.multiplayerStatus.textContent = clientContext.state.multiplayerRejection
          clientContext.ui.multiplayerStatus.hidden = false
          return
        case 'Chat': {
          const row = document.createElement('li')
          const sender = message.player === localPlayer
            ? multiplayer.query.name
            : multiplayer.players.get(message.player)?.name ?? message.player
          row.textContent = `<${String(sender)}> ${message.text}`
          clientContext.ui.multiplayerChatLog.append(row)
          while (clientContext.ui.multiplayerChatLog.childElementCount > 50) {
            clientContext.ui.multiplayerChatLog.firstElementChild?.remove()
          }
          return
        }
        default:
          return
      }
    })

  const applyNetworkMessage = (multiplayer: MultiplayerRuntime, message: NetworkMessage): Effect.Effect<void> =>
    Effect.map(Effect.result(handleNetworkMessage(multiplayer, message)), (handled) => {
      if (Result.isFailure(handled)) reportServerStateFailure(handled.failure)
      clientContext.ui.canvas.setAttribute('data-multiplayer-player-count', String(multiplayer.players.size + 1))
      clientContext.ui.canvas.setAttribute('data-multiplayer-revision', String(multiplayerRevision))
      clientContext.ui.canvas.setAttribute('data-multiplayer-rejection', clientContext.state.multiplayerRejection)
    })

  installMultiplayerChatInputListeners(clientContext)
  return {
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
  }
}
