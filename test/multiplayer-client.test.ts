import { Effect, Result } from 'effect'
import { BrewingServiceStateSchema, CHEST_CONTAINER_CAPACITY, furnaceState, INVENTORY_SLOT_COUNT } from '@nerima-games/mc-sim'
import { GAMEPLAY_BREWING_OWNER_ID, snapshotStatusEffects } from '@nerima-games/mx-gameplay'
import {
  CommandId,
  encodeFrame,
  encodeFrameAsVersion,
  EntityId,
  PlayerId,
  PROTOCOL_VERSION,
  WorldId,
  type BrewingAction,
  type BrewingStandState,
  type NetworkMessage,
} from '@nerima-games/mx-multiplayer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  connectMultiplayer,
  makeMultiplayerChatCommand,
  makeMultiplayerCommandIds,
} from '../apps/web/multiplayer-client'
import type { PersistedFurnaceState } from '../apps/web/session-persistence'
import { makeMultiplayerClientHarness } from './helpers/multiplayer-client-harness'

describe('multiplayer client', () => {
  it('keeps singleplayer connection setup inert', async () => {
    const storageEvents: Array<string> = []
    const bootErrors: Array<string> = []
    const result = await connectMultiplayer({
      sessionId: 'singleplayer-session',
      search: '?sleepPercentage=50',
      href: 'https://game.example.test/',
      getSessionStorage: () => {
        storageEvents.push('session:access')
        return {
          getItem: (key) => {
            storageEvents.push(`session:get:${key}`)
            return null
          },
          removeItem: (key) => storageEvents.push(`session:remove:${key}`),
        }
      },
      getLocalStorage: () => {
        storageEvents.push('local:access')
        return {
          getItem: (key) => {
            storageEvents.push(`local:get:${key}`)
            return null
          },
          setItem: (key, value) => storageEvents.push(`local:set:${key}:${value}`),
        }
      },
      failBoot: (message) => bootErrors.push(message),
    })

    expect(result.status).toBe('started')
    if (result.status !== 'started') return
    expect(result.multiplayer).toBeUndefined()
    expect(result.multiplayerInboundStage).toBeUndefined()
    expect(result.multiplayerOutboundStage).toBeUndefined()
    expect(storageEvents).toEqual([])
    expect(bootErrors).toEqual([])
  })

  it('builds bounded chat commands only after the multiplayer handshake', () => {
    const player = PlayerId.make('alice')
    const multiplayer = { query: { player } }

    expect(makeMultiplayerChatCommand(multiplayer, false, 'hello')).toBeUndefined()
    expect(makeMultiplayerChatCommand(undefined, true, 'hello')).toBeUndefined()
    expect(makeMultiplayerChatCommand(multiplayer, true, '   ')).toBeUndefined()
    expect(makeMultiplayerChatCommand(multiplayer, true, '  hello  ')).toEqual({
      _tag: 'Chat',
      player,
      text: 'hello',
    })
    expect(makeMultiplayerChatCommand(multiplayer, true, ` ${'x'.repeat(300)} `)).toEqual({
      _tag: 'Chat',
      player,
      text: 'x'.repeat(256),
    })
  })

  it('keeps command ids scoped to the page session and request kind', () => {
    const ids = makeMultiplayerCommandIds('session-1', (value) => value)

    expect(ids.commandIdFor('facility', 4)).toBe('facility-session-1-4')
    expect(ids.requestIdFor('craft', 9)).toBe('craft-session-1-9')
  })
})

type InventoryState = Extract<NetworkMessage, { readonly _tag: 'PlayerInventoryDelta' }>['state']
type AuthoritativeSnapshotMessage = Extract<NetworkMessage, { readonly _tag: 'AuthoritativeSnapshot' }>
type VehicleEntityState = Extract<Extract<NetworkMessage, { readonly _tag: 'EntityUpdateDelta' }>['entity'], { readonly _tag: 'vehicle' }>

const OVERWORLD = WorldId.make('overworld')
const NETHER = WorldId.make('nether')
const UNKNOWN_ITEM = 'not_a_real_item'

const inventoryWith = (first: InventoryState['slots'][number]): InventoryState => ({
  selectedSlot: 0,
  slots: [first, ...Array.from({ length: INVENTORY_SLOT_COUNT - 1 }, () => null)],
})

const chest = (
  containerId: string,
  first: NonNullable<AuthoritativeSnapshotMessage['containers'][number]['slots'][number]>,
): AuthoritativeSnapshotMessage['containers'][number] => ({
  containerId,
  kind: 'chest',
  slots: [first, ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
})

const emptyFurnace = (): ReturnType<typeof furnaceState> => furnaceState({
  station: 'furnace',
  input: undefined,
  fuel: undefined,
  output: undefined,
  fuelTimeRemainingSecs: 0,
  fuelTimeTotalSecs: 0,
  cookProgressSecs: 0,
})

const authoritativeSnapshot = (
  localPlayer: PlayerId,
  furnaces: AuthoritativeSnapshotMessage['furnaces'],
): AuthoritativeSnapshotMessage => ({
  _tag: 'AuthoritativeSnapshot',
  revision: 3,
  world: OVERWORLD,
  vitals: [{ player: localPlayer, state: { health: 5, hunger: 3, experience: 7 } }],
  inventories: [],
  villagerTrades: [],
  timeWeather: { timeOfDay: 6_000, weather: 'thunder' },
  containers: [],
  furnaces,
})

describe('multiplayer client server-state rejection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('leaves the inventory, the pending craft and the pending inventory command alone for an unknown item', async () => {
    const harness = await makeMultiplayerClientHarness()
    harness.deliver({
      _tag: 'PlayerInventoryDelta',
      revision: 1,
      world: OVERWORLD,
      player: harness.localPlayer,
      state: inventoryWith({ item: 'stone', count: 3 }),
    })
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('1')
    const storageBefore = Effect.runSync(harness.world.inventory.storageSnapshot)
    expect(storageBefore.inventory.slots[0]).toMatchObject({ item: 'stone', count: 3 })

    harness.context.state.pendingCrafting = { commandId: 'craft-pending', acceptedRevision: 4 }
    expect(harness.client.sendInventoryCommand({ _tag: 'select-slot', slot: 2 })).toBe(true)
    harness.deliver({
      _tag: 'AuthoritativeCommandAccepted',
      commandId: harness.commandIds.commandIdFor('inventory', 1),
      revision: 4,
      world: OVERWORLD,
    })

    harness.deliver({
      _tag: 'PlayerInventoryDelta',
      revision: 4,
      world: OVERWORLD,
      player: harness.localPlayer,
      state: inventoryWith({ item: UNKNOWN_ITEM, count: 1 }),
    })

    expect(Effect.runSync(harness.world.inventory.storageSnapshot)).toEqual(storageBefore)
    expect(harness.context.state.pendingCrafting).toEqual({ commandId: 'craft-pending', acceptedRevision: 4 })
    expect(harness.calls.confirmCraftOnce).toBe(0)
    // The accepted inventory command is still waiting for its delta.
    expect(harness.client.sendInventoryCommand({ _tag: 'select-slot', slot: 3 })).toBe(false)
    expect(harness.context.state.multiplayerRejection).toBe('invalid inventory')
    expect(harness.multiplayerStatus.textContent).toBe('Invalid inventory from the multiplayer server was not applied.')
    expect(harness.canvasAttributes.get('data-multiplayer-rejection')).toBe('invalid inventory')
  })

  it('applies neither time nor weather when the time of day is out of range', async () => {
    const harness = await makeMultiplayerClientHarness()
    const timeBefore = Effect.runSync(harness.time.snapshot)
    const weatherBefore = Effect.runSync(harness.weather.snapshot)

    harness.deliver({
      _tag: 'WorldTimeWeatherDelta',
      revision: 2,
      world: OVERWORLD,
      state: { timeOfDay: 24_000, weather: 'rain' },
    })

    expect(Effect.runSync(harness.time.snapshot)).toEqual(timeBefore)
    expect(Effect.runSync(harness.weather.snapshot)).toEqual(weatherBefore)
    expect(harness.calls.presentWeather).toEqual([])
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
    expect(harness.context.state.multiplayerRejection).toBe('invalid time of day')
  })

  it.each([
    ['furnace', (): NetworkMessage => ({
      _tag: 'FurnaceDelta',
      revision: 2,
      world: OVERWORLD,
      state: {
        furnaceId: JSON.stringify(['overworld', 1, 64, 2]),
        input: { item: UNKNOWN_ITEM, count: 1 },
        fuel: null,
        output: null,
        station: 'furnace',
        burnTicksRemaining: 0,
        burnTicksTotal: 0,
        cookTicks: 0,
      },
    })],
    ['villager trade', (): NetworkMessage => ({
      _tag: 'VillagerTradeDelta',
      revision: 2,
      world: OVERWORLD,
      state: {
        villagerId: 'villager-1',
        offers: [{ offerId: 'offer-1', input: [{ item: UNKNOWN_ITEM, count: 1 }], output: { item: 'emerald', count: 1 }, uses: 0, maxUses: 4 }],
      },
    })],
  ])('keeps the revision when a %s delta is rejected', async (what, message) => {
    const harness = await makeMultiplayerClientHarness()

    harness.deliver(message())

    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
    expect(harness.context.state.multiplayerRejection).toBe(`invalid ${what}`)
    expect(harness.context.state.furnaceStates.size).toBe(0)
  })

  it('keeps the furnaces, the furnace UI, the player and the rejection when a realm transfer carries an invalid furnace', async () => {
    const harness = await makeMultiplayerClientHarness()
    const furnace = emptyFurnace()
    if (Result.isFailure(furnace)) throw new Error('the existing furnace fixture is invalid')
    const furnaceKey = JSON.stringify(['overworld', 1, 64, 2])
    const existing: PersistedFurnaceState = { dimension: 'overworld', position: { x: 1, y: 64, z: 2 }, state: furnace.success }
    harness.context.state.furnaceStates.set(furnaceKey, existing)
    harness.context.state.inventoryOpen = true
    harness.context.state.inventoryMode = 'furnace'
    harness.context.state.activeFurnaceKey = furnaceKey
    const poseBefore = Effect.runSync(harness.world.player.pose)
    const vitalsBefore = Effect.runSync(harness.world.vitals.snapshot)
    const weatherBefore = Effect.runSync(harness.weather.snapshot)

    harness.deliver({
      _tag: 'RealmTransferSnapshot',
      commandId: CommandId.make('nether-portal-1'),
      player: harness.localPlayer,
      fromWorld: OVERWORLD,
      destinationWorld: NETHER,
      at: { x: 8, y: 70, z: 8 },
      facing: { yawRadians: 1, pitchRadians: 0 },
      worldSnapshot: {
        _tag: 'WorldSnapshot',
        revision: 3,
        seed: 1,
        world: NETHER,
        blocks: [],
        levers: [],
        players: [],
        poweredRails: [],
      },
      authoritativeSnapshot: authoritativeSnapshot(harness.localPlayer, [{
        furnaceId: JSON.stringify(['nether', 4, 70, 4]),
        input: { item: UNKNOWN_ITEM, count: 1 },
        fuel: null,
        output: null,
        station: 'furnace',
        burnTicksRemaining: 0,
        burnTicksTotal: 0,
        cookTicks: 0,
      }]),
    })

    expect([...harness.context.state.furnaceStates]).toEqual([[furnaceKey, existing]])
    expect(harness.context.state.activeFurnaceKey).toBe(furnaceKey)
    expect(harness.calls.setInventoryOpen).toEqual([])
    expect(Effect.runSync(harness.world.player.dimension)).toBe('overworld')
    expect(Effect.runSync(harness.world.player.pose)).toEqual(poseBefore)
    expect(Effect.runSync(harness.world.vitals.snapshot)).toEqual(vitalsBefore)
    expect(Effect.runSync(harness.weather.snapshot)).toEqual(weatherBefore)
    expect(harness.calls.alignActiveDimension).toEqual([])
    expect(harness.calls.resetSimState).toEqual([])
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
    expect(harness.context.state.multiplayerRejection).toBe('invalid furnace')
    expect(harness.multiplayerStatus.textContent).toBe('Invalid furnace from the multiplayer server was not applied.')
  })

  const vehicle = (occupant: PlayerId | null): VehicleEntityState => ({
    _tag: 'vehicle',
    entityId: EntityId.make('v:0'),
    at: { x: 4, y: 64, z: 4 },
    occupant,
    vehicleType: 'boat',
  })

  it.each<'EntitySpawnDelta' | 'EntityUpdateDelta'>(['EntitySpawnDelta', 'EntityUpdateDelta'])(
    'keeps the revision, the entities and the vehicles when a %s carries a blank vehicle occupant',
    async (tag) => {
      const harness = await makeMultiplayerClientHarness()
      const existing = vehicle(harness.localPlayer)
      harness.context.state.multiplayerEntities.set(existing.entityId, existing)

      harness.deliver({ _tag: tag, revision: 3, world: OVERWORLD, entity: vehicle(PlayerId.make(' ')) })

      expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
      expect(harness.context.state.multiplayerRejection).toBe('invalid vehicle occupant')
      expect([...harness.context.state.multiplayerEntities]).toEqual([[existing.entityId, existing]])
      expect(harness.calls.applyAuthoritativeVehicle).toEqual([])
    },
  )

  it('keeps the revision, the owners, the entities and the vehicles when a snapshot carries a blank vehicle occupant', async () => {
    const harness = await makeMultiplayerClientHarness()
    const existing = vehicle(harness.localPlayer)
    harness.context.state.multiplayerEntities.set(existing.entityId, existing)
    const vitalsBefore = Effect.runSync(harness.world.vitals.snapshot)
    const weatherBefore = Effect.runSync(harness.weather.snapshot)

    harness.deliver({ ...authoritativeSnapshot(harness.localPlayer, []), entities: [vehicle(PlayerId.make(' '))] })

    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
    expect(harness.context.state.multiplayerRejection).toBe('invalid vehicle occupant')
    expect([...harness.context.state.multiplayerEntities]).toEqual([[existing.entityId, existing]])
    expect(harness.calls.applyAuthoritativeVehicle).toEqual([])
    expect(Effect.runSync(harness.world.vitals.snapshot)).toEqual(vitalsBefore)
    expect(Effect.runSync(harness.weather.snapshot)).toEqual(weatherBefore)
  })

  it('hands a vehicle delta to the vehicle owner with its decoded occupant', async () => {
    const harness = await makeMultiplayerClientHarness()
    const entity = vehicle(harness.localPlayer)

    harness.deliver({ _tag: 'EntityUpdateDelta', revision: 3, world: OVERWORLD, entity })

    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('3')
    expect(harness.context.state.multiplayerRejection).toBe('')
    expect(harness.calls.applyAuthoritativeVehicle).toEqual([{ entity, occupant: 'local-player' }])
  })

  it('applies a valid authoritative snapshot and a container delta over it', async () => {
    const harness = await makeMultiplayerClientHarness()

    harness.deliver({
      ...authoritativeSnapshot(harness.localPlayer, [{
        furnaceId: JSON.stringify(['overworld', 4, 70, 4]),
        input: { item: 'stone', count: 1 },
        fuel: null,
        output: null,
        station: 'furnace',
        burnTicksRemaining: 0,
        burnTicksTotal: 0,
        cookTicks: 0,
      }]),
      containers: [chest('chest-a', { item: 'stone', count: 2 })],
    })

    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('3')
    expect(harness.context.state.multiplayerRejection).toBe('')
    expect(Effect.runSync(harness.world.vitals.snapshot)).toMatchObject({ healthPoints: 5, hungerPoints: 3, totalExperience: 7 })
    expect(Effect.runSync(harness.weather.snapshot).weather).toBe('thunder')
    expect([...harness.context.state.furnaceStates.keys()]).toEqual([JSON.stringify(['overworld', 4, 70, 4])])

    harness.deliver({ _tag: 'ContainerDelta', revision: 4, world: OVERWORLD, state: chest('chest-b', { item: 'dirt', count: 5 }) })

    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('4')
    expect(harness.context.state.multiplayerRejection).toBe('')
    const containers = Effect.runSync(harness.world.inventory.containerStorageSnapshot).containers
    expect(containers.map(({ id, slots }) => [id, slots[0]?.item, slots[0]?.count])).toEqual([
      ['chest-a', 'stone', 2],
      ['chest-b', 'dirt', 5],
    ])
  })
})

const OPEN_STAND = { x: 3, y: 64, z: 5 }
const OTHER_STAND = { x: -2, y: 70, z: 9 }

const brewingStand = (overrides: Partial<BrewingStandState> = {}): BrewingStandState => ({
  bottles: [{ item: 'water_bottle', count: 1 }, null, { item: 'water_bottle', count: 1 }],
  ingredient: { item: 'nether_wart', count: 1 },
  fuel: { item: 'blaze_powder', count: 2 },
  fuelCharges: 17,
  brewProgressSecs: 4.5,
  ...overrides,
})

const brewingStandDelta = (
  revision: number,
  at: { readonly x: number; readonly y: number; readonly z: number },
  state: BrewingStandState,
): NetworkMessage => ({ _tag: 'BrewingStandDelta', revision, world: OVERWORLD, at, state })

const encodedFrame = (message: NetworkMessage): string => {
  const frame = encodeFrame(message)
  if (Result.isFailure(frame)) throw new Error(`the test message does not encode: ${String(frame.failure)}`)
  return frame.success
}

/** A valid frame with its message edited after encoding, so the codec sees what the server could send. */
const editedFrame = (message: NetworkMessage, edit: (message: Record<string, unknown>) => void): string => {
  const envelope: { message: Record<string, unknown> } = JSON.parse(encodedFrame(message))
  edit(envelope.message)
  return JSON.stringify(envelope)
}

type Harness = Awaited<ReturnType<typeof makeMultiplayerClientHarness>>

const runtimeOf = (harness: Harness): NonNullable<Harness['context']['multiplayer']> => {
  const multiplayer = harness.context.multiplayer
  if (multiplayer === undefined) throw new Error('the harness has no multiplayer runtime')
  return multiplayer
}

describe('multiplayer brewing over protocol 12', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const openStand = (harness: Harness, at = OPEN_STAND): void => {
    harness.context.state.brewingOpen = true
    harness.context.state.activeBrewingStandAt = at
  }

  const brewingOwner = (harness: Harness) =>
    Effect.runSync(harness.context.services.gameplayCommit.coordinator.snapshot(GAMEPLAY_BREWING_OWNER_ID, BrewingServiceStateSchema))

  const slotNames = (state: ReturnType<typeof brewingOwner>['state']) => ({
    bottles: state.bottles.map((slot) => slot === undefined ? null : [slot.item, slot.count]),
    ingredient: state.ingredient === undefined ? null : [state.ingredient.item, state.ingredient.count],
    fuel: state.fuel === undefined ? null : [state.fuel.item, state.fuel.count],
    fuelCharges: state.fuelCharges,
    brewProgressSecs: state.brewProgressSecs,
  })

  it('restores all three bottles, the ingredient, the fuel and the progress of the open stand', async () => {
    const harness = await makeMultiplayerClientHarness()
    const renderBrewingUi = vi.spyOn(harness.context.callbacks, 'renderBrewingUi')
    openStand(harness)

    harness.deliver(brewingStandDelta(2, OPEN_STAND, brewingStand()))

    expect(slotNames(brewingOwner(harness).state)).toEqual({
      bottles: [['water_bottle', 1], null, ['water_bottle', 1]],
      ingredient: ['nether_wart', 1],
      fuel: ['blaze_powder', 2],
      fuelCharges: 17,
      brewProgressSecs: 4.5,
    })
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('2')
    expect(harness.context.state.multiplayerRejection).toBe('')
    expect(renderBrewingUi).toHaveBeenCalledOnce()
  })

  it('keeps a delta for a stand that is not open and shows it when that stand opens', async () => {
    const harness = await makeMultiplayerClientHarness()
    const enqueueOutbound = vi.spyOn(runtimeOf(harness).host, 'enqueueOutbound')
    openStand(harness)
    harness.deliver(brewingStandDelta(1, OPEN_STAND, brewingStand()))
    const openOwner = brewingOwner(harness)

    harness.deliver(brewingStandDelta(2, OTHER_STAND, brewingStand({
      bottles: [null, { item: 'awkward_potion', count: 1 }, null],
      ingredient: null,
      brewProgressSecs: 0,
    })))

    expect(brewingOwner(harness)).toEqual(openOwner)
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('2')

    openStand(harness, OTHER_STAND)
    expect(Effect.runSync(harness.client.requestBrewing({ _tag: 'open' }))).toBe(true)

    expect(slotNames(brewingOwner(harness).state)).toMatchObject({
      bottles: [null, ['awkward_potion', 1], null],
      ingredient: null,
      brewProgressSecs: 0,
    })
    expect(enqueueOutbound).toHaveBeenCalledExactlyOnceWith({
      _tag: 'BrewingCommand',
      action: { _tag: 'open' },
      at: OTHER_STAND,
      commandId: harness.commandIds.commandIdFor('brewing', 1),
      expectedRevision: 2,
      player: harness.localPlayer,
      world: OVERWORLD,
    })
    const sent = enqueueOutbound.mock.calls[0]?.[0]
    expect(sent === undefined ? undefined : Result.isSuccess(encodeFrame(sent))).toBe(true)
  })

  it('refuses a stand state that mc-sim rejects and keeps the owner and the revision', async () => {
    const harness = await makeMultiplayerClientHarness()
    openStand(harness)
    harness.deliver(brewingStandDelta(1, OPEN_STAND, brewingStand()))
    const before = brewingOwner(harness)

    harness.deliver(brewingStandDelta(2, OPEN_STAND, brewingStand({
      bottles: [{ item: UNKNOWN_ITEM, count: 1 }, null, null],
    })))

    expect(brewingOwner(harness)).toEqual(before)
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('1')
    expect(harness.context.state.multiplayerRejection).toBe('invalid brewing stand')
    expect(harness.multiplayerStatus.textContent).toBe('Invalid brewing stand from the multiplayer server was not applied.')
  })

  it.each([
    ['two bottles', (message: Record<string, unknown>) => {
      message['state'] = { ...brewingStand(), bottles: [null, null] }
    }],
    ['four bottles', (message: Record<string, unknown>) => {
      message['state'] = { ...brewingStand(), bottles: [null, null, null, null] }
    }],
    ['the protocol 11 single-bottle state', (message: Record<string, unknown>) => {
      message['state'] = { fuelUnits: 2, bottle: 'water_bottle', brewing: { output: 'awkward', remainingSecs: 10 } }
    }],
  ])('drops a brewing stand delta carrying %s at the codec', async (_what, edit) => {
    const harness = await makeMultiplayerClientHarness()
    openStand(harness)
    const before = brewingOwner(harness)
    const countersBefore = Effect.runSync(runtimeOf(harness).host.countersSnapshot)

    harness.deliverFrame(editedFrame(brewingStandDelta(1, OPEN_STAND, brewingStand()), edit))

    expect(brewingOwner(harness)).toEqual(before)
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
    expect(Effect.runSync(runtimeOf(harness).host.countersSnapshot).malformed).toBe(countersBefore.malformed + 1)
  })

  it('drops brewing frames whose protocol version is not exactly the current one', async () => {
    const harness = await makeMultiplayerClientHarness()
    openStand(harness)
    const before = brewingOwner(harness)
    const countersBefore = Effect.runSync(runtimeOf(harness).host.countersSnapshot)

    for (const version of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1]) {
      const frame = encodeFrameAsVersion(version, brewingStandDelta(1, OPEN_STAND, brewingStand()))
      if (Result.isFailure(frame)) throw new Error(`protocol ${String(version)} does not encode the delta`)
      harness.deliverFrame(frame.success)
    }

    expect(brewingOwner(harness)).toEqual(before)
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
    expect(Effect.runSync(runtimeOf(harness).host.countersSnapshot).versionMismatched)
      .toBe(countersBefore.versionMismatched + 2)
  })

  const statusEffects = (harness: Harness) =>
    Effect.runSync(snapshotStatusEffects(harness.context.services.gameplayState, harness.context.services.gameplayCommit))

  const poisonDelta = (player: PlayerId, revision: number): NetworkMessage => ({
    _tag: 'PlayerStatusEffectsDelta',
    revision,
    world: OVERWORLD,
    player,
    state: { effects: [{ type: 'poison', amplifier: 0, remainingSecs: 30, pulseClockSecs: 0 }] },
  })

  it('applies visible status effects to the local player only', async () => {
    const harness = await makeMultiplayerClientHarness()

    harness.deliver(poisonDelta(PlayerId.make('remote-player'), 1))
    expect(statusEffects(harness).effects).toEqual([])
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('1')

    harness.deliver(poisonDelta(harness.localPlayer, 2))
    expect(statusEffects(harness).effects).toMatchObject([{ type: 'poison', amplifier: 0, remainingSecs: 30 }])
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('2')
  })

  it('drops a status-effect delta naming an effect outside the visible set at the codec', async () => {
    const harness = await makeMultiplayerClientHarness()
    const countersBefore = Effect.runSync(runtimeOf(harness).host.countersSnapshot)

    harness.deliverFrame(editedFrame(poisonDelta(harness.localPlayer, 1), (message) => {
      message['state'] = { effects: [{ type: 'night_vision', amplifier: 0, remainingSecs: 30, pulseClockSecs: 0 }] }
    }))

    expect(statusEffects(harness).effects).toEqual([])
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
    expect(Effect.runSync(runtimeOf(harness).host.countersSnapshot).malformed).toBe(countersBefore.malformed + 1)
  })

  it('refuses a status effect without the amplifier the owner requires', async () => {
    const harness = await makeMultiplayerClientHarness()

    harness.deliver({
      _tag: 'PlayerStatusEffectsDelta',
      revision: 1,
      world: OVERWORLD,
      player: harness.localPlayer,
      state: { effects: [{ type: 'speed', remainingSecs: 30, pulseClockSecs: 0 }] },
    })

    expect(statusEffects(harness).effects).toEqual([])
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
    expect(harness.context.state.multiplayerRejection).toBe('invalid status effects')
  })

  it('sends one brewing command at a time and settles it on its own result', async () => {
    const harness = await makeMultiplayerClientHarness()
    const enqueueOutbound = vi.spyOn(runtimeOf(harness).host, 'enqueueOutbound')
    const renderBrewingUi = vi.spyOn(harness.context.callbacks, 'renderBrewingUi')
    openStand(harness)

    expect(Effect.runSync(harness.client.requestBrewing({ _tag: 'insert-bottle', slot: 4, bottleIndex: 2 }))).toBe(true)
    expect(Effect.runSync(harness.client.requestBrewing({ _tag: 'drink', slot: 0 }))).toBe(false)
    expect(enqueueOutbound).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      _tag: 'BrewingCommand', action: { _tag: 'insert-bottle', slot: 4, bottleIndex: 2 }, at: OPEN_STAND, expectedRevision: 0,
    }))

    harness.deliver({ _tag: 'BrewingCommandAccepted', commandId: CommandId.make('another-command'), revision: 1 })
    expect(Effect.runSync(harness.client.requestBrewing({ _tag: 'drink', slot: 0 }))).toBe(false)

    harness.deliver({ _tag: 'BrewingCommandAccepted', commandId: harness.commandIds.commandIdFor('brewing', 1), revision: 2 })
    expect(harness.context.state.brewingStatus).toBe('')
    expect(Effect.runSync(harness.client.requestBrewing({ _tag: 'collect', bottleIndex: 0 }))).toBe(true)
    expect(enqueueOutbound).toHaveBeenLastCalledWith(expect.objectContaining({
      action: { _tag: 'collect', bottleIndex: 0 }, commandId: harness.commandIds.commandIdFor('brewing', 2), expectedRevision: 2,
    }))

    harness.deliver({ _tag: 'BrewingCommandRejected', commandId: harness.commandIds.commandIdFor('brewing', 2), reason: 'no-room', revision: 3 })
    expect(harness.context.state.brewingStatus).toBe('Cannot use brewing stand: no-room')
    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('3')
    expect(renderBrewingUi).toHaveBeenCalledTimes(2)
    expect(Effect.runSync(harness.client.requestBrewing({ _tag: 'drink', slot: 0 }))).toBe(true)
  })

  it.each<[string, BrewingAction]>([
    ['bottle index 3', { _tag: 'collect', bottleIndex: 3 }],
    ['bottle index -1', { _tag: 'insert-bottle', slot: 0, bottleIndex: -1 }],
    ['a fractional bottle index', { _tag: 'collect', bottleIndex: 0.5 }],
    ['an inventory slot past the inventory', { _tag: 'drink', slot: INVENTORY_SLOT_COUNT }],
  ])('refuses %s before it reaches the outbound queue', async (_what, action) => {
    const harness = await makeMultiplayerClientHarness()
    const enqueueOutbound = vi.spyOn(runtimeOf(harness).host, 'enqueueOutbound')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    openStand(harness)

    expect(Effect.runSync(harness.client.requestBrewing(action))).toBe(false)

    expect(enqueueOutbound).not.toHaveBeenCalled()
    expect(reported).toHaveBeenCalledOnce()
    expect(harness.context.state.brewingStatus).toBe('Cannot send brewing command: invalid-command')
    expect(Effect.runSync(harness.client.requestBrewing({ _tag: 'collect', bottleIndex: 2 }))).toBe(true)
  })

  it('sends nothing while no stand is open', async () => {
    const harness = await makeMultiplayerClientHarness()
    const enqueueOutbound = vi.spyOn(runtimeOf(harness).host, 'enqueueOutbound')
    harness.context.state.activeBrewingStandAt = OPEN_STAND

    expect(Effect.runSync(harness.client.requestBrewing({ _tag: 'open' }))).toBe(false)
    harness.context.state.brewingOpen = true
    harness.context.state.activeBrewingStandAt = undefined
    expect(Effect.runSync(harness.client.requestBrewing({ _tag: 'open' }))).toBe(false)

    expect(enqueueOutbound).not.toHaveBeenCalled()
  })

  it('keeps the furnace station and the total burn time from the wire', async () => {
    const harness = await makeMultiplayerClientHarness()
    const furnaceId = JSON.stringify(['overworld', 1, 64, 2])

    harness.deliver({
      _tag: 'FurnaceDelta',
      revision: 1,
      world: OVERWORLD,
      state: {
        furnaceId,
        station: 'blast_furnace',
        input: { item: 'iron_ore', count: 1 },
        fuel: { item: 'coal', count: 3 },
        output: null,
        burnTicksRemaining: 800,
        burnTicksTotal: 1_600,
        cookTicks: 40,
      },
    })

    expect(harness.context.state.multiplayerRejection).toBe('')
    expect(harness.context.state.furnaceStates.get(furnaceId)?.state).toMatchObject({
      station: 'blast_furnace',
      fuelTimeRemainingSecs: 40,
      fuelTimeTotalSecs: 80,
      cookProgressSecs: 2,
    })
  })
})
