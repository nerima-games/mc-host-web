import { afterEach, describe, expect, it, vi } from 'vitest'
import { Option, Result, Schema } from 'effect'
import { blockIdOf, WorldWriteConflict } from '@nerima-games/mc-kernel'
import { emptyFurnaceState, itemStack } from '@nerima-games/mc-sim'
import {
  createPlayerUiRuntimeHarness,
} from './helpers/player-ui-runtime-harness'

afterEach(() => vi.unstubAllGlobals())

describe('H4b player UI runtime input paths', () => {
  it('opens and closes the player inventory through the main-owned state callbacks', () => {
    const harness = createPlayerUiRuntimeHarness()

    harness.runtime.setInventoryOpen(true, 'player')

    expect(harness.state.inventoryOpen).toBe(true)
    expect(harness.state.inventoryMode).toBe('player')
    expect(harness.elements.inventoryParent.hidden).toBe(false)
    expect(harness.elements.inventoryParent.getAttribute('aria-hidden')).toBe('false')
    expect(harness.elements.inventoryParent.getAttribute('aria-label')).toBe('Player inventory')
    expect(harness.elements.body.getAttribute('data-inventory-open')).toBe('true')

    harness.runtime.setInventoryOpen(false)

    expect(harness.state.inventoryOpen).toBe(false)
    expect(harness.elements.inventoryParent.hidden).toBe(true)
    expect(harness.elements.inventoryParent.getAttribute('aria-hidden')).toBe('true')
    expect(harness.elements.body.getAttribute('data-inventory-open')).toBe('false')
    expect(harness.views.inventoryView.render).toHaveBeenCalledTimes(2)
  })

  it('moves a fixed stack between slots from click input and emits the inventory command', () => {
    const harness = createPlayerUiRuntimeHarness()
    harness.addPlayerStack(0, 'iron_ingot', 2)
    harness.runtime.installInventoryListeners()
    harness.runtime.setInventoryOpen(true, 'player')
    const source = harness.makeSlot('hotbar', 0)
    const destination = harness.makeSlot('main', 0)

    harness.elements.inventoryParent.dispatch('click', source)

    expect(harness.state.multiplayerInventorySelection).toEqual({ source: 0, remaining: 2, mode: 'all' })
    expect(harness.elements.body.getAttribute('data-equipment-action')).toBe('selecting')
    expect(harness.calls.sendInventoryCommand).not.toHaveBeenCalled()

    harness.elements.inventoryParent.dispatch('click', destination)

    expect(harness.calls.sendInventoryCommand).toHaveBeenCalledExactlyOnceWith({
      _tag: 'move-item',
      source: 0,
      destination: 9,
      count: 2,
    })
    expect(harness.state.multiplayerInventorySelection).toBeNull()
    expect(harness.elements.body.getAttribute('data-equipment-action')).toBe('pending')
  })

  it('routes a shift-click on an armour stack to an equip command', () => {
    const harness = createPlayerUiRuntimeHarness()
    harness.addPlayerStack(0, 'iron_helmet', 1)
    harness.runtime.installInventoryListeners()
    harness.runtime.setInventoryOpen(true, 'player')
    const helmet = harness.makeSlot('hotbar', 0)

    harness.elements.inventoryParent.dispatch('click', helmet, { shiftKey: true })

    expect(harness.calls.sendInventoryCommand).toHaveBeenCalledExactlyOnceWith({
      _tag: 'equip-item',
      source: 0,
      equipmentSlot: 'head',
    })
    expect(harness.elements.body.getAttribute('data-equipment-action')).toBe('pending')
  })

  it('moves a selected chest stack to the player inventory through the facility command', () => {
    const harness = createPlayerUiRuntimeHarness()
    harness.state.activeChestContainer = { slots: [Result.getOrThrow(itemStack('diamond', 2))] }
    harness.runtime.installInventoryListeners()
    harness.runtime.setInventoryOpen(true, 'chest')
    const chestSlot = harness.makeChestSlot('chest', 0)
    const playerSlot = harness.makeChestSlot('player', 0)

    harness.elements.inventoryParent.dispatch('click', chestSlot)

    expect(harness.state.selectedChest).toEqual({ region: 'chest', slot: 0 })
    expect(harness.state.chestStatus).toBe('Selected diamond')

    harness.elements.inventoryParent.dispatch('click', playerSlot)

    expect(harness.calls.sendFacilityCommand).toHaveBeenCalledExactlyOnceWith({
      _tag: 'ContainerCommand',
      containerId: 'chest-42',
      action: {
        _tag: 'move-item',
        source: { _tag: 'container-slot', slot: 0 },
        destination: { _tag: 'player-slot', slot: 0 },
        count: 2,
      },
    })
    expect(harness.state.selectedChest).toBeUndefined()
    expect(harness.state.chestStatus).toBe('Move pending server approval')
    expect(harness.elements.body.getAttribute('data-inventory-open')).toBe('true')
  })

  it('closes a chest through the facility command and clears its main-owned state', () => {
    const harness = createPlayerUiRuntimeHarness()
    harness.runtime.installInventoryListeners()
    harness.runtime.setInventoryOpen(true, 'chest')

    harness.runtime.setInventoryOpen(false)

    expect(harness.calls.sendFacilityCommand).toHaveBeenCalledExactlyOnceWith({
      _tag: 'ContainerCommand',
      containerId: 'chest-42',
      action: { _tag: 'close' },
    })
    expect(harness.state.inventoryOpen).toBe(false)
    expect(harness.state.activeChestId).toBeUndefined()
    expect(harness.elements.inventoryParent.hidden).toBe(true)
    expect(harness.elements.body.getAttribute('data-inventory-open')).toBe('false')
  })

  it('sends furnace input, fuel, and output transfers from their corresponding slots', () => {
    const harness = createPlayerUiRuntimeHarness()
    harness.state.activeFurnaceKey = 'furnace-42'
    harness.state.furnaceState = {
      ...Result.getOrThrow(emptyFurnaceState()),
      output: Result.getOrThrow(itemStack('iron_ingot', 2)),
    }
    harness.addPlayerStack(0, 'raw_iron', 2)
    harness.runtime.installInventoryListeners()
    harness.runtime.setInventoryOpen(true, 'furnace')

    harness.elements.inventoryParent.dispatch('click', harness.makeFurnaceSlot('input'))
    harness.addPlayerStack(0, 'coal', 2)
    harness.elements.inventoryParent.dispatch('click', harness.makeFurnaceSlot('fuel'))
    harness.elements.inventoryParent.dispatch('click', harness.makeFurnaceSlot('output'))

    expect(harness.calls.sendFacilityCommand.mock.calls).toEqual([
      [{
        _tag: 'FurnaceCommand',
        furnaceId: 'furnace-42',
        action: {
          _tag: 'move-item',
          source: { _tag: 'player-slot', slot: 0 },
          destination: { _tag: 'furnace-slot', slot: 'input' },
          count: 1,
        },
      }],
      [{
        _tag: 'FurnaceCommand',
        furnaceId: 'furnace-42',
        action: {
          _tag: 'move-item',
          source: { _tag: 'player-slot', slot: 0 },
          destination: { _tag: 'furnace-slot', slot: 'fuel' },
          count: 1,
        },
      }],
      [{
        _tag: 'FurnaceCommand',
        furnaceId: 'furnace-42',
        action: {
          _tag: 'take-output',
          source: { _tag: 'furnace-slot', slot: 'output' },
          destination: { _tag: 'player-slot', slot: 0 },
          count: 2,
        },
      }],
    ])
    expect(harness.state.inventoryMode).toBe('furnace')
    expect(harness.elements.body.getAttribute('data-inventory-open')).toBe('true')
  })

  it('opens the crafting table and routes output activation to the crafting request', () => {
    const harness = createPlayerUiRuntimeHarness()
    harness.addPlayerStack(0, 'oak_planks', 4)
    harness.runtime.installInventoryListeners()
    harness.runtime.setInventoryOpen(true, 'craftingTable')
    const output = harness.makeCraftingOutput()

    harness.elements.inventoryParent.dispatch('click', output)

    expect(harness.state.inventoryOpen).toBe(true)
    expect(harness.state.inventoryMode).toBe('craftingTable')
    expect(harness.elements.inventoryParent.getAttribute('aria-label')).toBe('Crafting')
    expect(harness.elements.body.getAttribute('data-inventory-open')).toBe('true')
    expect(harness.calls.requestCrafting).toHaveBeenCalledOnce()
  })

  it('clears a rejected right-click status on the next successful right-click', () => {
    const harness = createPlayerUiRuntimeHarness()
    harness.state.multiplayer = false
    // itemStack rejects a zero count, which yields a real ItemStackFailure for the click.
    const failure = Result.getOrThrow(Result.flip(itemStack('diamond', 0)))
    harness.state.inventoryClickFailure = failure
    harness.runtime.installInventoryListeners()
    harness.runtime.setInventoryOpen(true, 'player')
    const slot = harness.makeSlot('hotbar', 0)

    // A right-click reaches activateInventoryTarget directly, without the status reset
    // that dispatchInventoryAction applies to left clicks.
    harness.elements.inventoryParent.dispatch('contextmenu', slot)

    expect(harness.state.equipmentActionStatus).toBe(failure._tag)
    expect(harness.views.inventoryView.render).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ status: failure._tag }),
    )

    harness.state.inventoryClickFailure = undefined
    harness.elements.inventoryParent.dispatch('contextmenu', slot)

    expect(harness.state.equipmentActionStatus).toBe('')
    expect(harness.views.inventoryView.render).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ status: '' }),
    )
    expect(harness.elements.body.getAttribute('data-equipment-action')).toBeNull()
  })
})

// The kernel block registry always contains these vocabulary blocks.
const AIR = Option.getOrThrow(blockIdOf('air'))
const STONE = Option.getOrThrow(blockIdOf('stone'))
const EXPLOSION_CENTER = { x: 100.5, y: 64.5, z: 100.5 }
const cellKey = (cell: { readonly x: number; readonly y: number; readonly z: number }): string =>
  `${String(cell.x)},${String(cell.y)},${String(cell.z)}`

const fillStoneAroundExplosion = (blocks: Map<string, number>): void => {
  for (let x = 98; x <= 102; x += 1) {
    for (let y = 62; y <= 66; y += 1) {
      for (let z = 98; z <= 102; z += 1) blocks.set(cellKey({ x, y, z }), STONE)
    }
  }
}

describe('player UI runtime world writes', () => {
  it('submits the cells an explosion destroys as one batch of unique air edits', () => {
    const harness = createPlayerUiRuntimeHarness()
    fillStoneAroundExplosion(harness.state.blocks)

    const result = harness.runtime.applyWorldExplosion(EXPLOSION_CENTER, 2, 1, true)

    expect(Result.isSuccess(result)).toBe(true)
    expect(harness.calls.writeBlocks).toHaveBeenCalledOnce()
    const edits = harness.calls.writeBlocks.mock.calls.flatMap(([, batch]) => batch)
    expect(harness.calls.writeBlocks).toHaveBeenCalledWith('overworld', edits)
    expect(edits.length).toBeGreaterThan(0)
    expect(new Set(edits.map(({ position }) => cellKey(position))).size).toBe(edits.length)
    expect(edits.every(({ position, block }) =>
      block === AIR && harness.state.blocks.get(cellKey(position)) === STONE)).toBe(true)
    expect(harness.context.resolveExplosionEffects).toHaveBeenCalledOnce()
  })

  it('submits no batch when an explosion destroys no block', () => {
    const harness = createPlayerUiRuntimeHarness()

    const result = harness.runtime.applyWorldExplosion(EXPLOSION_CENTER, 2, 1, true)

    expect(Result.isSuccess(result)).toBe(true)
    expect(harness.calls.writeBlocks).not.toHaveBeenCalled()
  })

  it('returns the WorldWritePort failure and leaves the explosion effects unapplied', () => {
    const harness = createPlayerUiRuntimeHarness()
    fillStoneAroundExplosion(harness.state.blocks)
    // The literal satisfies the kernel codec; a decode failure would be a broken fixture.
    const conflict = Result.getOrThrow(Schema.decodeUnknownResult(WorldWriteConflict)({
      _tag: 'WorldWriteConflict',
      expectedWorldRevision: 0,
      currentWorldRevision: 1,
      expectedDimensionRevision: 0,
      currentDimensionRevision: 0,
    }))
    harness.state.worldWriteFailure = conflict

    const result = harness.runtime.applyWorldExplosion(EXPLOSION_CENTER, 2, 1, true)

    expect(Result.isFailure(result) ? result.failure : undefined).toBe(conflict)
    expect(harness.context.resolveExplosionEffects).not.toHaveBeenCalled()
    expect(harness.context.markSessionDirty).not.toHaveBeenCalled()
  })
})
