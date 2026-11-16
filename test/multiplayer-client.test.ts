import { Effect, Result } from 'effect'
import { furnaceState, INVENTORY_SLOT_COUNT } from '@nerima-games/mc-sim'
import { CommandId, PlayerId, WorldId, type NetworkMessage } from '@nerima-games/mx-multiplayer'
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

const OVERWORLD = WorldId.make('overworld')
const NETHER = WorldId.make('nether')
const UNKNOWN_ITEM = 'not_a_real_item'

const inventoryWith = (first: InventoryState['slots'][number]): InventoryState => ({
  selectedSlot: 0,
  slots: [first, ...Array.from({ length: INVENTORY_SLOT_COUNT - 1 }, () => null)],
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
    ['vitals', (player: PlayerId): NetworkMessage => ({
      _tag: 'PlayerVitalsDelta',
      revision: 2,
      world: OVERWORLD,
      player,
      state: { health: 5, hunger: 25, experience: 7 },
    })],
    ['furnace', (): NetworkMessage => ({
      _tag: 'FurnaceDelta',
      revision: 2,
      world: OVERWORLD,
      state: {
        furnaceId: JSON.stringify(['overworld', 1, 64, 2]),
        input: { item: UNKNOWN_ITEM, count: 1 },
        fuel: null,
        output: null,
        burnTicksRemaining: 0,
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
    const vitalsBefore = Effect.runSync(harness.world.vitals.snapshot)

    harness.deliver(message(harness.localPlayer))

    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('0')
    expect(harness.context.state.multiplayerRejection).toBe(`invalid ${what}`)
    expect(harness.context.state.furnaceStates.size).toBe(0)
    expect(Effect.runSync(harness.world.vitals.snapshot)).toEqual(vitalsBefore)
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
        burnTicksRemaining: 0,
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

  it('applies a valid authoritative snapshot', async () => {
    const harness = await makeMultiplayerClientHarness()

    harness.deliver(authoritativeSnapshot(harness.localPlayer, [{
      furnaceId: JSON.stringify(['overworld', 4, 70, 4]),
      input: { item: 'stone', count: 1 },
      fuel: null,
      output: null,
      burnTicksRemaining: 0,
      cookTicks: 0,
    }]))

    expect(harness.canvasAttributes.get('data-multiplayer-revision')).toBe('3')
    expect(harness.context.state.multiplayerRejection).toBe('')
    expect(Effect.runSync(harness.world.vitals.snapshot)).toMatchObject({ healthPoints: 5, hungerPoints: 3, totalExperience: 7 })
    expect(Effect.runSync(harness.weather.snapshot).weather).toBe('thunder')
    expect([...harness.context.state.furnaceStates.keys()]).toEqual([JSON.stringify(['overworld', 4, 70, 4])])
  })
})
