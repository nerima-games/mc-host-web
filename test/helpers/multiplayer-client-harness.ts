import { Effect, Result } from 'effect'
import { vi } from 'vitest'
import {
  DeltaTimeSecs,
  EpochMillis,
  FixedClockLayer,
  MonotonicTimeSecs,
  WorldId as KernelWorldId,
} from '@nerima-games/mc-kernel'
import {
  makeTimeService,
  makeVehicleService,
  makeWeatherService,
  makeWorldCommitCoordinator,
  type WeatherState,
} from '@nerima-games/mc-sim'
import {
  GAMEPLAY_ENTITIES_OWNER_ID,
  GAMEPLAY_PLAYER_OWNER_ID,
  GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  GAMEPLAY_STATUS_EFFECTS_OWNER_ID,
  GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
  GAMEPLAY_VITALS_OWNER_ID,
  gameplayOwnerRegistrations,
  makeGameplayFrameState,
  makeInMemoryWorld,
  type MobBehaviour,
} from '@nerima-games/mx-gameplay'
import {
  CommandId,
  encodeFrame,
  makeMultiplayerHost,
  PlayerId,
  PlayerName,
  TransportPort,
  type NetworkMessage,
} from '@nerima-games/mx-multiplayer'
import { initialSleepClientState, restoreWitherRuntime } from '@nerima-games/mc-server/shared'
import { initialEyeOfEnderRuntimeState } from '../../apps/web/eye-of-ender-runtime'
import {
  createMultiplayerClient,
  makeMultiplayerCommandIds,
  type DecodedVehicle,
  type MultiplayerClientApi,
  type MultiplayerCommandIds,
  type MultiplayerClientContext,
  type MultiplayerRuntime,
} from '../../apps/web/multiplayer-client'
import {
  makeBrowserWebSocketTransport,
  type BrowserWebSocketEventMap,
  type BrowserWebSocketLike,
} from '../../apps/web/multiplayer-websocket'
import { makeOwnerBackedWorld, type OwnerBackedWorld } from '../../apps/web/owner-backed-services'
import { initialSleepRuntimeState } from '../../apps/web/sleep-runtime'

type Dimension = Parameters<MultiplayerClientContext['services']['alignActiveDimension']>[0]

class ServerSocketDouble implements BrowserWebSocketLike {
  readyState = 0
  readonly listeners: {
    [K in keyof BrowserWebSocketEventMap]: Set<(event: BrowserWebSocketEventMap[K]) => void>
  } = { open: new Set(), message: new Set(), close: new Set(), error: new Set() }

  readonly send = vi.fn<(data: string) => void>()

  close(): void {
    this.readyState = 3
  }

  addEventListener<K extends keyof BrowserWebSocketEventMap>(
    type: K,
    listener: (event: BrowserWebSocketEventMap[K]) => void,
  ): void {
    this.listeners[type].add(listener)
  }

  removeEventListener<K extends keyof BrowserWebSocketEventMap>(
    type: K,
    listener: (event: BrowserWebSocketEventMap[K]) => void,
  ): void {
    this.listeners[type].delete(listener)
  }

  emit<K extends keyof BrowserWebSocketEventMap>(type: K, event: BrowserWebSocketEventMap[K]): void {
    if (type === 'open') this.readyState = 1
    for (const listener of this.listeners[type]) listener(event)
  }
}

const HARNESS_SESSION_ID = '00000000-0000-4000-8000-000000000000'

export type MultiplayerClientHarnessCalls = {
  confirmCraftOnce: number
  renderPlayerUi: number
  readonly setInventoryOpen: Array<boolean>
  readonly resetSimState: Array<boolean>
  readonly alignActiveDimension: Array<Dimension>
  readonly presentWeather: Array<WeatherState>
  readonly applyAuthoritativeVehicle: Array<DecodedVehicle>
}

export type MultiplayerClientHarness = Readonly<{
  client: MultiplayerClientApi
  context: MultiplayerClientContext
  calls: MultiplayerClientHarnessCalls
  canvasAttributes: ReadonlyMap<string, string>
  multiplayerStatus: Readonly<{ hidden: boolean; textContent: string }>
  localPlayer: PlayerId
  world: MultiplayerClientContext['services']['world'] & Pick<OwnerBackedWorld, 'player'>
  time: MultiplayerClientContext['services']['time']
  weather: MultiplayerClientContext['services']['weather']
  commandIds: MultiplayerCommandIds<CommandId>
  deliver: (message: NetworkMessage) => void
}>

/**
 * A multiplayer client over in-memory owners and a real transport and host:
 * `deliver` encodes a server message, hands it to the socket, runs the
 * inbound stage, and drains it into the client as one frame does.
 */
export const makeMultiplayerClientHarness = async (): Promise<MultiplayerClientHarness> => {
  const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
    world: KernelWorldId('multiplayer-client-test'),
    owners: gameplayOwnerRegistrations(),
  }))
  const inMemoryWorld = await Effect.runPromise(makeInMemoryWorld<MobBehaviour>())
  const world = await Effect.runPromise(makeOwnerBackedWorld({
    coordinator,
    world: inMemoryWorld,
    ownerIds: {
      player: GAMEPLAY_PLAYER_OWNER_ID,
      playerStorage: GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
      vitals: GAMEPLAY_VITALS_OWNER_ID,
      entities: GAMEPLAY_ENTITIES_OWNER_ID,
    },
  }))
  const gameplayState = await Effect.runPromise(makeGameplayFrameState)
  const time = await Effect.runPromise(makeTimeService())
  const weather = await Effect.runPromise(makeWeatherService())
  const vehicleService = await Effect.runPromise(makeVehicleService())

  const socket = new ServerSocketDouble()
  const transport = await Effect.runPromise(makeBrowserWebSocketTransport({
    url: 'ws://multiplayer.example.test/world',
    socketFactory: () => socket,
  }))
  socket.emit('open', undefined)
  const host = await Effect.runPromise(makeMultiplayerHost.pipe(Effect.provideService(TransportPort, transport)))
  const inboundStage = host.stages.find((stage) => stage.id === 'multiplayer:inbound')
  if (inboundStage === undefined) throw new Error('the multiplayer host registers no inbound stage')
  const localPlayer = PlayerId.make('local-player')
  const multiplayer: MultiplayerRuntime = {
    query: { url: 'ws://multiplayer.example.test/world', player: localPlayer, name: PlayerName.make('Local') },
    host,
    transport,
    players: new Map(),
  }

  const canvasAttributes = new Map<string, string>()
  const multiplayerStatus = { hidden: true, textContent: '' }
  const calls: MultiplayerClientHarnessCalls = {
    confirmCraftOnce: 0,
    renderPlayerUi: 0,
    setInventoryOpen: [],
    resetSimState: [],
    alignActiveDimension: [],
    presentWeather: [],
    applyAuthoritativeVehicle: [],
  }
  const chunkContext: ReturnType<MultiplayerClientContext['services']['currentChunkContext']> = {
    dimension: 'overworld',
    chunkStore: inMemoryWorld.chunkStore,
  }
  // The client registers a document listener and writes body attributes.
  vi.stubGlobal('document', {
    addEventListener: () => undefined,
    body: { setAttribute: () => undefined, removeAttribute: () => undefined },
  })

  const context: MultiplayerClientContext = {
    multiplayer,
    ui: {
      canvas: { setAttribute: (name, value) => { canvasAttributes.set(name, value) } },
      multiplayerStatus,
      multiplayerChat: { hidden: true },
      multiplayerChatLog: { append: () => undefined, childElementCount: 0, firstElementChild: null },
      multiplayerChatForm: { addEventListener: () => undefined },
      multiplayerChatInput: { value: '', addEventListener: () => undefined },
    },
    state: {
      inventoryOpen: false,
      inventoryMode: 'player',
      tradeOpen: false,
      activeVillagerId: undefined,
      brewingOpen: false,
      brewingStatus: '',
      tradeStatus: '',
      enchantmentSeed: 0,
      anvilName: '',
      anvilStatus: '',
      enchantingStatus: '',
      customNames: new Map(),
      enchantedItems: new Map(),
      eyeOfEnderRuntimeState: initialEyeOfEnderRuntimeState(),
      sleepRuntimeState: initialSleepRuntimeState(),
      witherRevision: 0,
      witherRuntimeState: restoreWitherRuntime(undefined),
      authoritativeEnderDragonSnapshot: Effect.runSync(gameplayState.enderDragonEncounter.snapshot),
      enderDragonRevision: 0,
      redstoneDirty: false,
      leverStates: new Map(),
      poweredRails: new Set(),
      fishingResult: '',
      networkFishingState: { phase: 'idle', result: 'idle' },
      furnaceStates: new Map(),
      activeFurnaceKey: undefined,
      activeChestId: undefined,
      selectedHotbarIndex: 0,
      chestStatus: '',
      furnaceStatus: '',
      authoritativeLightning: undefined,
      multiplayerEntities: new Map(),
      multiplayerInventorySelection: null,
      queuedPlayerDamages: [],
      pendingCrafting: null,
      activeBrewingStandAt: undefined,
      closeChestOnFacilityIdle: false,
      networkSleepState: initialSleepClientState(),
      nextSleepRequest: 0,
      appliedNightSkipRevision: null,
      multiplayerRejection: '',
      multiplayerHandshakeComplete: true,
      multiplayerClosed: false,
      lastPlayerMoveSentAt: 0,
      lastPlayerMoveSent: undefined,
    },
    services: {
      deferToFrameBoundary: (work) => work(),
      world,
      gameplayState,
      gameplayCommit: {
        coordinator,
        playerOwnerId: GAMEPLAY_PLAYER_OWNER_ID,
        playerStorageOwnerId: GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
        vitalsOwnerId: GAMEPLAY_VITALS_OWNER_ID,
        statusEffectsOwnerId: GAMEPLAY_STATUS_EFFECTS_OWNER_ID,
        villagerTradesOwnerId: GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
      },
      playerApi: world.player,
      time,
      weather,
      currentChunkContext: () => chunkContext,
      getOrCreateDimensionChunkContext: () => chunkContext,
      leverKeyOf: (lever) => JSON.stringify([lever.dimension, lever.position.x, lever.position.y, lever.position.z]),
      vehicleById: () => undefined,
      vehicleService,
      applyAuthoritativeVehicle: (vehicle) => { calls.applyAuthoritativeVehicle.push(vehicle) },
      alignActiveDimension: (dimension) => { calls.alignActiveDimension.push(dimension) },
      resetSimState: (reset) => { calls.resetSimState.push(reset) },
      presentWeather: (state) => { calls.presentWeather.push(state) },
      queueEndAudio: () => undefined,
      craftingStaleRetryLimit: 0,
    },
    callbacks: {
      getInventoryInteraction: () => ({
        state: () => ({ grid: { width: 2, height: 2, cells: [undefined, undefined, undefined, undefined] } }),
        confirmCraftOnce: () => Effect.sync(() => { calls.confirmCraftOnce += 1 }),
      }),
      renderPlayerUi: () => { calls.renderPlayerUi += 1 },
      renderTradeUi: () => undefined,
      renderBrewingUi: () => undefined,
      setInventoryOpen: (open) => { calls.setInventoryOpen.push(open) },
    },
  }
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(HARNESS_SESSION_ID)
  const client: MultiplayerClientApi = createMultiplayerClient(context)

  const deliver = (message: NetworkMessage): void => {
    const frame = encodeFrame(message)
    if (Result.isFailure(frame)) throw new Error(`the test message does not encode: ${String(frame.failure)}`)
    socket.emit('message', { data: frame.success })
    Effect.runSync(inboundStage.run(DeltaTimeSecs(0)).pipe(Effect.provide(FixedClockLayer({
      monotonicSecs: MonotonicTimeSecs(0),
      wallClockEpochMillis: EpochMillis(0),
    }))))
    client.drainMultiplayerInbound()
  }

  return {
    client,
    context,
    calls,
    canvasAttributes,
    multiplayerStatus,
    localPlayer,
    world,
    time,
    weather,
    commandIds: makeMultiplayerCommandIds(HARNESS_SESSION_ID, CommandId.make),
    deliver,
  }
}
