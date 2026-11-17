import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  emptyInventory,
  itemStack,
  makeInventoryService,
  type CraftGrid,
  type CraftResult,
  type Inventory,
  type InventoryClick,
  type InventoryClickResult,
  type RecipeMatch,
} from '@nerima-games/mc-sim'
import {
  itemComponentPatch,
  RecipeGridDimension,
  RecipeId,
  shapelessRecipe,
  type ItemType,
} from '@nerima-games/mc-kernel'

import {
  createInventoryInteraction,
  type InventoryInteractionController,
} from '../apps/web/inventory-interaction'

// Fixture literals are in-range stack counts. Expected stacks are full mc-kernel
// `ItemStack` values (`item`, `count`, `components`): the carried stack is
// `InventoryCarriedStack = Inv.ItemStack & { durability? }`
// (@nerima-games/mc-sim@0.11.1 dist/application/inventory-interaction.d.ts) and
// crafting draft cells come from `splitItemStack`, whose `ItemStack` carries
// `components` (@nerima-games/mc-kernel@0.17.0 dist/domain/item/item-stack.d.ts).
const stackOf = (item: ItemType, count: number) => Result.getOrThrow(itemStack(item, count))

// A stack whose components differ from the item defaults, so preservation is observable.
const repairedLogs = Result.getOrThrow(itemStack('oak_log', 2, {
  componentPatch: Result.getOrThrow(itemComponentPatch({ 'minecraft:repair_cost': 3 })),
}))

const planksRecipe = Result.getOrThrow(
  shapelessRecipe(RecipeId('oak_planks'), ['oak_log'], stackOf('oak_planks', 4)),
)

const logs: Inventory = {
  slots: [stackOf('oak_log', 4), undefined],
}

const noMatch: RecipeMatch = { _tag: 'NoMatch' }

const makeService = (options: {
  readonly inventory?: Inventory
  readonly preview?: RecipeMatch
  readonly previews?: ReadonlyArray<RecipeMatch>
  readonly craft?: CraftResult
  readonly crafts?: ReadonlyArray<CraftResult>
  readonly clickResult?: InventoryClickResult
  readonly addLeftover?: number
} = {}) => {
  const inventory = options.inventory ?? logs
  const addCalls: Array<{ readonly item: ItemType; readonly count: number }> = []
  const previewCalls: Array<CraftGrid> = []
  const craftCalls: Array<CraftGrid> = []
  let previewIndex = 0
  let craftIndex = 0
  return {
    inventory,
    addCalls,
    previewCalls,
    craftCalls,
    service: {
      add: (item: ItemType, count: number) => Effect.sync(() => {
        addCalls.push({ item, count })
        return options.addLeftover ?? 0
      }),
      click: (click: InventoryClick) =>
        Effect.succeed<InventoryClickResult>(
          options.clickResult ?? { _tag: 'NoChange', carried: click.carried },
        ),
      snapshot: Effect.succeed(inventory),
      previewCraft: (grid: CraftGrid) =>
        Effect.sync((): RecipeMatch => {
          previewCalls.push(grid)
          return options.previews?.[previewIndex++] ?? options.preview ?? noMatch
        }),
      craft: (grid: CraftGrid) =>
        Effect.sync((): CraftResult => {
          craftCalls.push(grid)
          return options.crafts?.[craftIndex++] ?? options.craft ?? { _tag: 'NoMatch' }
        }),
    },
  }
}

const placeLog = (
  interaction: InventoryInteractionController,
  cell: number,
): void => {
  Effect.runSync(interaction.pickupInventoryItem(0))
  interaction.interactCraftingCell(cell)
}

describe('inventory interaction', () => {
  it('drafts four logs and previews a match without mutating canonical inventory', () => {
    const match: RecipeMatch = {
      _tag: 'Match',
      recipe: planksRecipe,
      output: stackOf('oak_planks', 4),
    }
    const fixture = makeService({ preview: match })
    const interaction = createInventoryInteraction(fixture.service)

    for (let cell = 0; cell < 4; cell += 1) placeLog(interaction, cell)
    const previewed = Effect.runSync(interaction.preview())

    expect(previewed.grid.cells).toEqual(
      Array.from({ length: 4 }, () => stackOf('oak_log', 1)),
    )
    expect(previewed.preview).toEqual(match)
    expect(fixture.previewCalls).toHaveLength(1)
    expect(fixture.inventory).toEqual(logs)
  })

  it('retains the draft and marks dirty once after a successful craft', () => {
    let dirtyCount = 0
    const crafted: CraftResult = {
      _tag: 'Crafted',
      recipeId: planksRecipe.id,
      output: stackOf('oak_planks', 4),
    }
    const fixture = makeService({ craft: crafted, preview: noMatch })
    const interaction = createInventoryInteraction(fixture.service, {
      onCrafted: () => { dirtyCount += 1 },
    })
    placeLog(interaction, 0)

    const result = Effect.runSync(interaction.craftOnce())

    expect(fixture.craftCalls).toHaveLength(1)
    expect(fixture.previewCalls).toHaveLength(1)
    expect(result.grid.cells).toEqual([
      stackOf('oak_log', 1),
      undefined,
      undefined,
      undefined,
    ])
    expect(result.carried).toBeUndefined()
    expect(result.preview).toEqual(noMatch)
    expect(result.status).toEqual(crafted)
    expect(dirtyCount).toBe(1)
  })

  it('confirms an authoritative craft without invoking the local inventory service', () => {
    let dirtyCount = 0
    const fixture = makeService({ preview: noMatch })
    const interaction = createInventoryInteraction(fixture.service, {
      consumeCraftingGrid: true,
      onCrafted: () => { dirtyCount += 1 },
    })
    placeLog(interaction, 0)

    const result = Effect.runSync(interaction.confirmCraftOnce())

    expect(fixture.craftCalls).toHaveLength(0)
    expect(fixture.previewCalls).toHaveLength(1)
    expect(result.grid.cells).toEqual([undefined, undefined, undefined, undefined])
    expect(result.preview).toEqual(noMatch)
    expect(dirtyCount).toBe(1)
  })

  it('crafts the same output twice while ingredients remain', () => {
    const crafted: CraftResult = {
      _tag: 'Crafted',
      recipeId: planksRecipe.id,
      output: stackOf('oak_planks', 4),
    }
    const match: RecipeMatch = {
      _tag: 'Match',
      recipe: planksRecipe,
      output: crafted.output,
    }
    let dirtyCount = 0
    const fixture = makeService({ crafts: [crafted, crafted], previews: [match, noMatch] })
    const interaction = createInventoryInteraction(fixture.service, {
      onCrafted: () => { dirtyCount += 1 },
    })
    placeLog(interaction, 0)

    const first = Effect.runSync(interaction.craftOnce())
    const second = Effect.runSync(interaction.craftOnce())

    expect(first.preview).toEqual(match)
    expect(second.preview).toEqual(noMatch)
    expect(second.status).toEqual(crafted)
    expect(fixture.craftCalls).toHaveLength(2)
    expect(fixture.previewCalls).toHaveLength(2)
    expect(fixture.craftCalls[1]).toEqual(fixture.craftCalls[0])
    expect(dirtyCount).toBe(2)
  })

  it('rejects concurrent craft attempts and notifies once', async () => {
    const crafted: CraftResult = {
      _tag: 'Crafted',
      recipeId: planksRecipe.id,
      output: stackOf('oak_planks', 4),
    }
    let resolveCraft!: (result: CraftResult) => void
    const pendingCraft = new Promise<CraftResult>((resolve) => {
      resolveCraft = resolve
    })
    let dirtyCount = 0
    const fixture = makeService()
    const interaction = createInventoryInteraction({
      ...fixture.service,
      craft: (grid) => {
        fixture.craftCalls.push(grid)
        return Effect.promise(() => pendingCraft)
      },
    }, {
      onCrafted: () => { dirtyCount += 1 },
    })

    const firstCraft = Effect.runPromise(interaction.craftOnce())
    await Promise.resolve()
    const rejected = await Effect.runPromise(interaction.craftOnce())

    expect(fixture.craftCalls).toHaveLength(1)
    expect(rejected.status).toBeUndefined()
    expect(dirtyCount).toBe(0)

    resolveCraft(crafted)
    const completed = await firstCraft

    expect(completed.status).toEqual(crafted)
    expect(fixture.craftCalls).toHaveLength(1)
    expect(dirtyCount).toBe(1)
  })

  it('rejects crafting cell changes while a craft is pending', async () => {
    const crafted: CraftResult = {
      _tag: 'Crafted',
      recipeId: planksRecipe.id,
      output: stackOf('oak_planks', 4),
    }
    let resolveCraft!: (result: CraftResult) => void
    const pendingCraft = new Promise<CraftResult>((resolve) => {
      resolveCraft = resolve
    })
    const fixture = makeService()
    const interaction = createInventoryInteraction({
      ...fixture.service,
      craft: (grid) => {
        fixture.craftCalls.push(grid)
        return Effect.promise(() => pendingCraft)
      },
    })
    placeLog(interaction, 0)
    Effect.runSync(interaction.pickupInventoryItem(0))
    const beforeCraft = interaction.state()

    const crafting = Effect.runPromise(interaction.craftOnce())
    await Promise.resolve()
    const rejected = interaction.interactCraftingCell(1)

    expect(rejected).toEqual(beforeCraft)
    resolveCraft(crafted)
    const completed = await crafting

    expect(completed.grid).toEqual(beforeCraft.grid)
    expect(completed.carried).toBeUndefined()
  })

  it('keeps a successful craft when the follow-up preview defects', () => {
    const crafted: CraftResult = {
      _tag: 'Crafted',
      recipeId: planksRecipe.id,
      output: stackOf('oak_planks', 4),
    }
    let dirtyCount = 0
    const fixture = makeService({ crafts: [crafted] })
    const interaction = createInventoryInteraction({
      ...fixture.service,
      previewCraft: () => Effect.die(new Error('preview defect')),
    }, {
      onCrafted: () => { dirtyCount += 1 },
    })
    placeLog(interaction, 0)

    const result = Effect.runSync(interaction.craftOnce())

    expect(result.status).toEqual(crafted)
    expect(result.preview).toBeUndefined()
    expect(result.grid.cells[0]).toEqual(stackOf('oak_log', 1))
    expect(dirtyCount).toBe(1)
  })

  it('clears a stale match preview after an unsuccessful craft', () => {
    const match: RecipeMatch = {
      _tag: 'Match',
      recipe: planksRecipe,
      output: stackOf('oak_planks', 4),
    }
    const fixture = makeService({ previews: [match], crafts: [noMatch] })
    const interaction = createInventoryInteraction(fixture.service)
    placeLog(interaction, 0)
    expect(Effect.runSync(interaction.preview()).preview).toEqual(match)

    const result = Effect.runSync(interaction.craftOnce())

    expect(result.status).toEqual(noMatch)
    expect(result.preview).toBeUndefined()
  })

  it('configures a 3x3 grid without changing canonical carried inventory or dirty state', () => {
    let dirtyCount = 0
    const fixture = makeService({
      clickResult: { _tag: 'PickedUp', carried: stackOf('stone', 2) },
    })
    const interaction = createInventoryInteraction(fixture.service, {
      onInventoryChanged: () => { dirtyCount += 1 },
    })
    Effect.runSync(interaction.clickInventoryItem(0, 'left'))
    placeLog(interaction, 0)
    Effect.runSync(interaction.preview())
    const dirtyBeforeConfigure = dirtyCount

    const configured = interaction.configureGrid(RecipeGridDimension(3), RecipeGridDimension(3))

    expect(configured).toEqual({
      inventoryCarried: stackOf('stone', 2),
      carried: undefined,
      grid: {
        width: 3,
        height: 3,
        cells: Array.from({ length: 9 }, () => undefined),
      },
      preview: undefined,
      status: undefined,
    })
    expect(dirtyCount).toBe(dirtyBeforeConfigure)
    expect(fixture.addCalls).toHaveLength(0)
  })

  it('uses the configured cell count for interaction boundaries and craft previews', () => {
    const fixture = makeService()
    const interaction = createInventoryInteraction(fixture.service)
    interaction.configureGrid(RecipeGridDimension(3), RecipeGridDimension(3))
    Effect.runSync(interaction.pickupInventoryItem(0))

    const placed = interaction.interactCraftingCell(8)
    const unchanged = interaction.interactCraftingCell(9)
    Effect.runSync(interaction.preview())

    expect(placed.grid.cells[8]).toEqual(stackOf('oak_log', 1))
    expect(unchanged).toEqual(placed)
    expect(fixture.previewCalls[0]).toMatchObject({ width: 3, height: 3 })
    expect(fixture.previewCalls[0]?.cells).toHaveLength(9)
  })

  it('preserves configured grid dimensions after a successful craft', () => {
    const crafted: CraftResult = {
      _tag: 'Crafted',
      recipeId: planksRecipe.id,
      output: stackOf('oak_planks', 4),
    }
    const fixture = makeService({ craft: crafted, preview: noMatch })
    const interaction = createInventoryInteraction(fixture.service)
    interaction.configureGrid(RecipeGridDimension(3), RecipeGridDimension(3))
    placeLog(interaction, 8)

    const result = Effect.runSync(interaction.craftOnce())

    expect(result.grid).toEqual({
      width: 3,
      height: 3,
      cells: [...Array.from({ length: 8 }, () => undefined), stackOf('oak_log', 1)],
    })
    expect(fixture.craftCalls[0]).toMatchObject({ width: 3, height: 3 })
    expect(fixture.previewCalls[0]).toMatchObject({ width: 3, height: 3 })
    expect(fixture.previewCalls[0]?.cells).toHaveLength(9)
  })

  it.each<CraftResult>([
    { _tag: 'NoMatch' },
    { _tag: 'MissingIngredients', missing: [{ item: 'oak_log', short: 1 }] },
    { _tag: 'NoRoom' },
  ])('retains the draft after $_tag', (failure) => {
    const fixture = makeService({ craft: failure })
    const interaction = createInventoryInteraction(fixture.service)
    placeLog(interaction, 0)
    Effect.runSync(interaction.pickupInventoryItem(0))
    const before = interaction.state()

    const result = Effect.runSync(interaction.craftOnce())

    expect(fixture.craftCalls).toHaveLength(1)
    expect(result.grid).toEqual(before.grid)
    expect(result.carried).toEqual(before.carried)
    expect(result.status).toEqual(failure)
  })

  it('resets all transient state on close', () => {
    const fixture = makeService({ preview: noMatch })
    const interaction = createInventoryInteraction(fixture.service)
    placeLog(interaction, 0)
    Effect.runSync(interaction.pickupInventoryItem(0))
    Effect.runSync(interaction.preview())

    const closed = Effect.runSync(interaction.close())

    expect(closed).toEqual({
      inventoryCarried: undefined,
      carried: undefined,
      grid: {
        width: 2,
        height: 2,
        cells: [undefined, undefined, undefined, undefined],
      },
      preview: undefined,
      status: undefined,
    })
  })

  it('uses canonical left-click pickup, placement, merging, and swapping', () => {
    const initial: Inventory = {
      slots: [
        stackOf('stone', 60),
        stackOf('stone', 10),
        stackOf('dirt', 7),
        ...emptyInventory().slots.slice(3),
      ],
    }
    const service = Effect.runSync(makeInventoryService(initial))
    const interaction = createInventoryInteraction(service)

    expect(Effect.runSync(interaction.clickInventoryItem(1, 'left')).inventoryCarried)
      .toEqual(stackOf('stone', 10))
    expect(Effect.runSync(interaction.clickInventoryItem(0, 'left')).inventoryCarried)
      .toEqual(stackOf('stone', 6))
    expect(Effect.runSync(service.snapshot).slots[0]).toEqual(stackOf('stone', 64))

    expect(Effect.runSync(interaction.clickInventoryItem(2, 'left')).inventoryCarried)
      .toEqual(stackOf('dirt', 7))
    expect(Effect.runSync(service.snapshot).slots[2]).toEqual(stackOf('stone', 6))

    expect(Effect.runSync(interaction.clickInventoryItem(3, 'left')).inventoryCarried)
      .toBeUndefined()
    expect(Effect.runSync(service.snapshot).slots[3]).toEqual(stackOf('dirt', 7))
  })

  it('uses canonical right-click half pickup and one-item placement', () => {
    const initial: Inventory = {
      slots: [stackOf('stone', 5), ...emptyInventory().slots.slice(1)],
    }
    const service = Effect.runSync(makeInventoryService(initial))
    const interaction = createInventoryInteraction(service)

    expect(Effect.runSync(interaction.clickInventoryItem(0, 'right')).inventoryCarried)
      .toEqual(stackOf('stone', 3))
    expect(Effect.runSync(service.snapshot).slots[0]).toEqual(stackOf('stone', 2))

    expect(Effect.runSync(interaction.clickInventoryItem(1, 'right')).inventoryCarried)
      .toEqual(stackOf('stone', 2))
    expect(Effect.runSync(service.snapshot).slots[1]).toEqual(stackOf('stone', 1))
  })

  it('notifies the complete inventory transition after a successful click', () => {
    const result: InventoryClickResult = { _tag: 'PickedUp', carried: stackOf('stone', 2) }
    const fixture = makeService({ clickResult: result })
    const transitions: Array<unknown> = []
    const interaction = createInventoryInteraction(fixture.service, {
      onInventoryTransition: (transition) => { transitions.push(transition) },
    })

    Effect.runSync(interaction.clickInventoryItem(0, 'left'))

    expect(transitions).toEqual([{
      slotIndex: 0,
      slotBefore: stackOf('oak_log', 4),
      carriedBefore: undefined,
      result,
    }])
  })

  it.each(['NoChange', 'InvalidSlot', 'InvalidCount'] as const)(
    'does not notify an inventory transition after %s',
    (failureTag) => {
      const fixture = makeService({
        clickResult: { _tag: failureTag, carried: undefined },
      })
      const transitions: Array<unknown> = []
      const interaction = createInventoryInteraction(fixture.service, {
        onInventoryTransition: (transition) => { transitions.push(transition) },
      })

      Effect.runSync(interaction.clickInventoryItem(0, 'left'))

      expect(transitions).toEqual([])
    },
  )

  it('keeps the current carried stack when an inventory click fails', () => {
    const fixture = makeService()
    let clickCount = 0
    const interaction = createInventoryInteraction({
      ...fixture.service,
      click: () => Effect.sync(() => {
        clickCount += 1
        return clickCount === 1
          ? { _tag: 'PickedUp' as const, carried: stackOf('stone', 2) }
          : { _tag: 'NoChange' as const, carried: undefined }
      }),
    })
    Effect.runSync(interaction.clickInventoryItem(0, 'left'))
    const beforeFailure = interaction.state()

    const afterFailure = Effect.runSync(interaction.clickInventoryItem(0, 'left'))

    expect(afterFailure.inventoryCarried).toEqual(beforeFailure.inventoryCarried)
    expect(afterFailure).toEqual(beforeFailure)
  })

  it('rejects an inventory click in preflight without calling the service', () => {
    const fixture = makeService()
    let clickCount = 0
    const preflights: Array<unknown> = []
    const interaction = createInventoryInteraction({
      ...fixture.service,
      click: () => Effect.sync(() => {
        clickCount += 1
        return { _tag: 'PickedUp' as const, carried: stackOf('stone', 2) }
      }),
    }, {
      canInventoryClick: (transition) => {
        preflights.push(transition)
        return false
      },
    })
    const before = interaction.state()

    const rejected = Effect.runSync(interaction.clickInventoryItem(0, 'left'))

    expect(preflights).toEqual([{
      slotIndex: 0,
      slotBefore: stackOf('oak_log', 4),
      carriedBefore: undefined,
    }])
    expect(clickCount).toBe(0)
    expect(rejected).toEqual(before)
  })

  it('restores carried inventory through a successful close transition', () => {
    const initial: Inventory = {
      slots: [stackOf('stone', 3), ...emptyInventory().slots.slice(1)],
    }
    const service = Effect.runSync(makeInventoryService(initial))
    const transitions: Array<unknown> = []
    const interaction = createInventoryInteraction(service, {
      onInventoryTransition: (transition) => { transitions.push(transition) },
    })
    Effect.runSync(interaction.clickInventoryItem(0, 'left'))

    const closed = Effect.runSync(interaction.close())

    expect(closed.inventoryCarried).toBeUndefined()
    expect(Effect.runSync(service.snapshot).slots[0]).toEqual(stackOf('stone', 3))
    expect(transitions.at(-1)).toEqual({
      slotIndex: 0,
      slotBefore: undefined,
      carriedBefore: stackOf('stone', 3),
      result: { _tag: 'Placed', carried: undefined },
    })
  })

  it('returns a real carried stack before creating a one-item crafting draft', () => {
    const initial: Inventory = {
      slots: [stackOf('oak_log', 4), ...emptyInventory().slots.slice(1)],
    }
    const service = Effect.runSync(makeInventoryService(initial))
    const interaction = createInventoryInteraction(service)

    Effect.runSync(interaction.clickInventoryItem(0, 'left'))
    const drafted = Effect.runSync(interaction.interactCraftingCellFromInventory(0))

    expect(drafted.inventoryCarried).toBeUndefined()
    expect(drafted.grid.cells[0]).toEqual(stackOf('oak_log', 1))
    expect(Effect.runSync(service.snapshot).slots[0]).toEqual(stackOf('oak_log', 4))
  })

  it('returns carried metadata to the actual accepted slot before crafting', () => {
    const initial: Inventory = {
      slots: [
        stackOf('stone', 60),
        stackOf('stone', 3),
        ...emptyInventory().slots.slice(2),
      ],
    }
    const service = Effect.runSync(makeInventoryService(initial))
    const slotNames = new Map<number, string>([[0, 'first'], [1, 'second']])
    let carriedName: string | undefined
    const interaction = createInventoryInteraction(service, {
      canInventoryClick: ({ slotIndex, slotBefore, carriedBefore }) =>
        carriedBefore === undefined || slotBefore === undefined ||
        slotBefore.item !== carriedBefore.item || slotNames.get(slotIndex) === carriedName,
      onInventoryTransition: ({ slotIndex, slotBefore, result }) => {
        const slotName = slotNames.get(slotIndex)
        if (result._tag === 'PickedUp') {
          carriedName = slotName
          if (result.carried?.count === slotBefore?.count) slotNames.delete(slotIndex)
        } else if (result._tag === 'Placed' || result._tag === 'Merged') {
          if (carriedName === undefined) slotNames.delete(slotIndex)
          else slotNames.set(slotIndex, carriedName)
          if (result.carried === undefined) carriedName = undefined
        }
      },
    })

    Effect.runSync(interaction.clickInventoryItem(1, 'left'))
    const drafted = Effect.runSync(interaction.interactCraftingCellFromInventory(0))

    expect(Effect.runSync(service.snapshot).slots[0]).toEqual(stackOf('stone', 60))
    expect(Effect.runSync(service.snapshot).slots[1]).toEqual(stackOf('stone', 3))
    expect(slotNames.get(0)).toBe('first')
    expect(slotNames.get(1)).toBe('second')
    expect(carriedName).toBeUndefined()
    expect(drafted.inventoryCarried).toBeUndefined()
    expect(drafted.grid.cells[0]).toEqual(stackOf('stone', 1))
  })

  it('returns a real carried stack to canonical inventory on close', () => {
    const initial: Inventory = {
      slots: [stackOf('stone', 3), ...emptyInventory().slots.slice(1)],
    }
    const service = Effect.runSync(makeInventoryService(initial))
    const interaction = createInventoryInteraction(service)

    Effect.runSync(interaction.clickInventoryItem(0, 'left'))
    const closed = Effect.runSync(interaction.close())

    expect(closed.inventoryCarried).toBeUndefined()
    expect(Effect.runSync(service.snapshot).slots[0]).toEqual(stackOf('stone', 3))
  })

  it('returns canonical carried inventory exactly once across consecutive closes', () => {
    let dirtyCount = 0
    const initial: Inventory = {
      slots: [stackOf('stone', 2), ...emptyInventory().slots.slice(1)],
    }
    const service = Effect.runSync(makeInventoryService(initial))
    const interaction = createInventoryInteraction(service, {
      onInventoryChanged: () => { dirtyCount += 1 },
    })
    Effect.runSync(interaction.clickInventoryItem(0, 'left'))

    const closed = Effect.runSync(interaction.close())
    const closedAgain = Effect.runSync(interaction.close())

    expect(Effect.runSync(service.snapshot).slots[0]).toEqual(stackOf('stone', 2))
    expect(closed.inventoryCarried).toBeUndefined()
    expect(closed.carried).toBeUndefined()
    expect(closed.grid.cells.every((cell) => cell === undefined)).toBe(true)
    expect(closedAgain.inventoryCarried).toBeUndefined()
    expect(dirtyCount).toBe(2)
  })

  it('preserves carried inventory when every return destination is rejected', () => {
    const initial: Inventory = {
      slots: [stackOf('stone', 2), ...emptyInventory().slots.slice(1)],
    }
    const service = Effect.runSync(makeInventoryService(initial))
    const interaction = createInventoryInteraction(service, {
      canInventoryClick: ({ carriedBefore }) => carriedBefore === undefined,
    })
    Effect.runSync(interaction.clickInventoryItem(0, 'left'))

    const closed = Effect.runSync(interaction.close())
    const configured = interaction.configureGrid(RecipeGridDimension(3), RecipeGridDimension(3))

    expect(Effect.runSync(service.snapshot).slots[0]).toBeUndefined()
    // mc-sim's `InventoryServiceApi.click` returns `InventoryClickResult.carried` as an
    // `InventoryCarriedStack`, which includes mc-kernel `ItemStack.components`
    // (@nerima-games/mc-sim@0.11.1 dist/application/inventory-interaction.d.ts).
    expect(closed.inventoryCarried).toEqual(stackOf('stone', 2))
    expect(configured.inventoryCarried).toEqual(stackOf('stone', 2))
    expect(configured.grid).toEqual({
      width: 3,
      height: 3,
      cells: Array.from({ length: 9 }, () => undefined),
    })
  })

  it('picks up an occupied cell and swaps it with a carried item', () => {
    const fixture = makeService({
      inventory: {
        slots: [
          stackOf('oak_log', 4),
          stackOf('stone', 2),
        ],
      },
    })
    const interaction = createInventoryInteraction(fixture.service)
    placeLog(interaction, 0)

    const pickedUp = interaction.interactCraftingCell(0)
    expect(pickedUp.carried).toEqual(stackOf('oak_log', 1))
    expect(pickedUp.grid.cells[0]).toBeUndefined()

    interaction.interactCraftingCell(0)
    Effect.runSync(interaction.pickupInventoryItem(1))
    const swapped = interaction.interactCraftingCell(0)
    expect(swapped.grid.cells[0]).toEqual(stackOf('stone', 1))
    expect(swapped.carried).toEqual(stackOf('oak_log', 1))
  })
  it('drafts one durable tool carried from the real inventory and keeps its components', () => {
    const pickaxe = stackOf('wooden_pickaxe', 1)
    const service = Effect.runSync(makeInventoryService({
      slots: [pickaxe, repairedLogs, ...emptyInventory().slots.slice(2)],
    }))
    const interaction = createInventoryInteraction(service)

    // mc-sim adds `durability` to a damageable carried stack on pickup
    // (@nerima-games/mc-sim@0.11.1 dist/application/inventory-service.js `click`).
    expect(Effect.runSync(interaction.clickInventoryItem(0, 'left')).inventoryCarried)
      .toHaveProperty('durability')
    const toolDrafted = Effect.runSync(interaction.interactCraftingCellFromInventory(0))

    expect(toolDrafted.inventoryCarried).toBeUndefined()
    expect(toolDrafted.grid.cells[0]).toEqual(pickaxe)
    expect(toolDrafted.grid.cells[0]?.components).toEqual(pickaxe.components)
    expect(Effect.runSync(service.snapshot).slots[0]).toEqual(pickaxe)

    Effect.runSync(interaction.clickInventoryItem(1, 'left'))
    const logDrafted = Effect.runSync(interaction.interactCraftingCellFromInventory(1))

    expect(logDrafted.grid.cells[1]).toEqual({ ...repairedLogs, count: 1 })
    expect(logDrafted.grid.cells[1]?.components).toEqual(repairedLogs.components)
    expect(logDrafted.grid.cells[1]?.components.repairCost).toBe(3)
    expect(Effect.runSync(service.snapshot).slots[1]).toEqual(repairedLogs)
  })

  it('consumes one item from each cell per craft and passes the cell components to craft', () => {
    const pickaxe = stackOf('wooden_pickaxe', 1)
    const service = Effect.runSync(makeInventoryService({
      slots: [pickaxe, repairedLogs, ...emptyInventory().slots.slice(2)],
    }))
    const crafted: CraftResult = {
      _tag: 'Crafted',
      recipeId: planksRecipe.id,
      output: stackOf('oak_planks', 4),
    }
    const craftCalls: Array<CraftGrid> = []
    let dirtyCount = 0
    const interaction = createInventoryInteraction({
      ...service,
      craft: (grid) => Effect.sync((): CraftResult => {
        craftCalls.push(grid)
        return crafted
      }),
    }, {
      consumeCraftingGrid: true,
      onCrafted: () => { dirtyCount += 1 },
    })
    Effect.runSync(interaction.clickInventoryItem(0, 'left'))
    Effect.runSync(interaction.interactCraftingCellFromInventory(0))
    Effect.runSync(interaction.clickInventoryItem(1, 'left'))
    Effect.runSync(interaction.interactCraftingCellFromInventory(1))

    const result = Effect.runSync(interaction.craftOnce())

    expect(craftCalls).toHaveLength(1)
    expect(craftCalls[0]?.cells[0]?.components).toEqual(pickaxe.components)
    expect(craftCalls[0]?.cells[1]?.components).toEqual(repairedLogs.components)
    expect(result.status).toEqual(crafted)
    expect(result.grid.cells).toEqual([undefined, undefined, undefined, undefined])
    expect(dirtyCount).toBe(1)
  })
})
