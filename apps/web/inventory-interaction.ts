import { Effect, Result } from 'effect'
import { RecipeGridDimension, splitItemStack, TransferQuantity } from '@nerima-games/mc-kernel'
import type {
  CraftGrid,
  CraftResult,
  InventoryCarriedSlot,
  InventoryClickResult,
  InventoryServiceApi,
  ItemStack,
  ItemStackFailure,
  PlayerStorageFailure,
  RecipeMatch,
  Slot,
} from '@nerima-games/mc-sim'

export type InventoryInteractionError = ItemStackFailure | PlayerStorageFailure

/** The part of mc-sim's `InventoryServiceApi` the interaction controller calls. */
export type InventoryInteractionInventory = Pick<
  InventoryServiceApi,
  'click' | 'snapshot' | 'previewCraft' | 'craft'
>

export type InventoryInteractionState = {
  /** Canonical inventory stack held by the pointer. Kept separate from crafting drafts. */
  readonly inventoryCarried: InventoryCarriedSlot
  readonly carried: Slot
  readonly grid: CraftGrid
  readonly preview: RecipeMatch | undefined
  readonly status: CraftResult | undefined
}

export type InventoryInteractionController = {
  readonly state: () => InventoryInteractionState
  readonly configureGrid: (
    width: RecipeGridDimension,
    height: RecipeGridDimension,
  ) => InventoryInteractionState
  readonly pickupInventoryItem: (
    inventoryIndex: number,
  ) => Effect.Effect<InventoryInteractionState, ItemStackFailure>
  readonly clickInventoryItem: (
    inventoryIndex: number,
    button: 'left' | 'right',
  ) => Effect.Effect<InventoryInteractionState, InventoryInteractionError>
  readonly interactCraftingCell: (
    cellIndex: number,
  ) => InventoryInteractionState
  readonly interactCraftingCellFromInventory: (
    cellIndex: number,
  ) => Effect.Effect<InventoryInteractionState, InventoryInteractionError>
  readonly preview: () => Effect.Effect<InventoryInteractionState>
  readonly craftOnce: () => Effect.Effect<InventoryInteractionState, InventoryInteractionError>
  readonly confirmCraftOnce: () => Effect.Effect<InventoryInteractionState, ItemStackFailure>
  readonly reset: () => InventoryInteractionState
  readonly close: () => Effect.Effect<InventoryInteractionState, InventoryInteractionError>
}

export type InventoryInteractionTransition = {
  readonly slotIndex: number
  readonly slotBefore: Slot
  readonly carriedBefore: InventoryCarriedSlot
  readonly result: InventoryClickResult
}

export type InventoryInteractionOptions = {
  readonly canInventoryClick?: (
    transition: Omit<InventoryInteractionTransition, 'result'>,
  ) => boolean
  readonly consumeCraftingGrid?: boolean
  readonly onCrafted?: () => void
  readonly onInventoryChanged?: () => void
  readonly onInventoryReset?: () => void
  readonly onInventoryTransition?: (
    transition: InventoryInteractionTransition,
  ) => void
}

const PLAYER_GRID_SIDE = RecipeGridDimension(2)
const ONE_ITEM = TransferQuantity(1)

const emptyGrid = (
  width = PLAYER_GRID_SIDE,
  height = PLAYER_GRID_SIDE,
): CraftGrid => ({
  width,
  height,
  cells: Array.from({ length: width * height }, () => undefined),
})

const oneItem = (stack: ItemStack): Result.Result<ItemStack, ItemStackFailure> =>
  Result.map(splitItemStack(stack, ONE_ITEM), ({ taken }) => taken)

const consumeOneFromEachCell = (grid: CraftGrid): Result.Result<CraftGrid, ItemStackFailure> =>
  Result.map(
    Result.all(grid.cells.map((cell): Result.Result<Slot, ItemStackFailure> =>
      cell === undefined
        ? Result.succeed(undefined)
        : Result.map(splitItemStack(cell, ONE_ITEM), ({ remainder }) => remainder))),
    (cells) => ({ ...grid, cells }),
  )

const cloneState = (current: InventoryInteractionState): InventoryInteractionState => ({
  ...current,
  grid: { ...current.grid, cells: [...current.grid.cells] },
})

export const createInventoryInteraction = (
  service: InventoryInteractionInventory,
  options: InventoryInteractionOptions = {},
): InventoryInteractionController => {
  let crafting = false
  let current: InventoryInteractionState = {
    inventoryCarried: undefined,
    carried: undefined,
    grid: emptyGrid(),
    preview: undefined,
    status: undefined,
  }

  const state = (): InventoryInteractionState => cloneState(current)

  const craftedGrid = (grid: CraftGrid): Result.Result<CraftGrid, ItemStackFailure> =>
    options.consumeCraftingGrid === true ? consumeOneFromEachCell(grid) : Result.succeed(grid)

  const configureGrid = (
    width: RecipeGridDimension,
    height: RecipeGridDimension,
  ): InventoryInteractionState => {
    if (crafting) return state()
    current = {
      inventoryCarried: current.inventoryCarried,
      carried: undefined,
      grid: emptyGrid(width, height),
      preview: undefined,
      status: undefined,
    }
    return state()
  }

  const replaceDraft = (
    patch: Pick<InventoryInteractionState, 'carried' | 'grid'>,
  ): InventoryInteractionState => {
    current = {
      inventoryCarried: current.inventoryCarried,
      ...patch,
      preview: undefined,
      status: undefined,
    }
    return state()
  }

  const reset = (): InventoryInteractionState => {
    if (crafting) return state()
    current = {
      inventoryCarried: undefined,
      carried: undefined,
      grid: emptyGrid(),
      preview: undefined,
      status: undefined,
    }
    options.onInventoryReset?.()
    return state()
  }

  const applyInventoryClickResult = (
    slotIndex: number,
    slotBefore: Slot,
    carriedBefore: InventoryCarriedSlot,
    result: InventoryClickResult,
  ): void => {
    if (
      result._tag !== 'PickedUp' &&
      result._tag !== 'Placed' &&
      result._tag !== 'Merged' &&
      result._tag !== 'Swapped'
    ) return

    current = {
      ...current,
      inventoryCarried: result.carried,
      preview: undefined,
      status: undefined,
    }
    options.onInventoryTransition?.({ slotIndex, slotBefore, carriedBefore, result })
    options.onInventoryChanged?.()
  }

  const returnInventoryCarried = (): Effect.Effect<void, InventoryInteractionError> => {
    const carriedBefore = current.inventoryCarried
    if (carriedBefore === undefined) return Effect.void

    return Effect.flatMap(service.snapshot, (inventory) => {
      const matchingSlots: number[] = []
      const emptySlots: number[] = []
      for (let slotIndex = 0; slotIndex < inventory.slots.length; slotIndex += 1) {
        const slot = inventory.slots[slotIndex]
        if (slot === undefined) emptySlots.push(slotIndex)
        else if (slot.item === carriedBefore.item) matchingSlots.push(slotIndex)
      }

      const candidates = [...matchingSlots, ...emptySlots]
      const tryCandidate = (candidateIndex: number): Effect.Effect<void, InventoryInteractionError> => {
        if (candidateIndex >= candidates.length) return Effect.void

        const slotIndex = candidates[candidateIndex]!
        const slotBefore = inventory.slots[slotIndex]
        if (options.canInventoryClick?.({ slotIndex, slotBefore, carriedBefore }) === false) {
          return tryCandidate(candidateIndex + 1)
        }

        return Effect.flatMap(service.click({
          _tag: 'LeftClick',
          slotIndex,
          carried: carriedBefore,
        }), (result) => {
          if (result._tag !== 'Placed' && result._tag !== 'Merged') {
            return tryCandidate(candidateIndex + 1)
          }
          applyInventoryClickResult(slotIndex, slotBefore, carriedBefore, result)
          return returnInventoryCarried()
        })
      }

      return tryCandidate(0)
    })
  }

  const pickupInventoryItem = (
    inventoryIndex: number,
  ): Effect.Effect<InventoryInteractionState, ItemStackFailure> =>
    Effect.flatMap(service.snapshot, (inventory) => {
      if (crafting) return Effect.succeed(state())
      const selected = inventory.slots[inventoryIndex]
      if (selected === undefined) return Effect.succeed(state())
      return Effect.map(
        Effect.fromResult(oneItem(selected)),
        (carried) => replaceDraft({ carried, grid: current.grid }),
      )
    })

  const clickInventoryItem = (
    inventoryIndex: number,
    button: 'left' | 'right',
  ): Effect.Effect<InventoryInteractionState, InventoryInteractionError> =>
    Effect.suspend(() => {
      if (crafting) return Effect.succeed(state())
      return Effect.flatMap(service.snapshot, (inventory) => {
        if (crafting) return Effect.succeed(state())
        const carriedBefore = current.inventoryCarried
        const slotBefore = inventory.slots[inventoryIndex]
        if (options.canInventoryClick?.({
          slotIndex: inventoryIndex,
          slotBefore,
          carriedBefore,
        }) === false) return Effect.succeed(state())
        return Effect.map(
          service.click({
            _tag: button === 'left' ? 'LeftClick' : 'RightClick',
            slotIndex: inventoryIndex,
            carried: carriedBefore,
          }),
          (result) => {
            if (crafting) return state()
            applyInventoryClickResult(inventoryIndex, slotBefore, carriedBefore, result)
            return state()
          },
        )
      })
    })

  const interactCraftingCell = (
    cellIndex: number,
  ): InventoryInteractionState => {
    if (crafting) return state()
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= current.grid.cells.length) {
      return state()
    }

    const cells = [...current.grid.cells]
    const occupied = cells[cellIndex]
    cells[cellIndex] = current.carried
    return replaceDraft({
      carried: occupied,
      grid: { ...current.grid, cells },
    })
  }

  const interactCraftingCellFromInventory = (
    cellIndex: number,
  ): Effect.Effect<InventoryInteractionState, InventoryInteractionError> => Effect.suspend(() => {
    if (crafting) return Effect.succeed(state())
    const inventoryCarried = current.inventoryCarried
    if (inventoryCarried === undefined) {
      return Effect.succeed(interactCraftingCell(cellIndex))
    }
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= current.grid.cells.length) {
      return Effect.succeed(state())
    }

    return Effect.flatMap(returnInventoryCarried(), () => {
      if (crafting || current.inventoryCarried !== undefined) return Effect.succeed(state())
      return Effect.map(Effect.fromResult(oneItem(inventoryCarried)), (carried) => {
        current = { ...current, carried }
        options.onInventoryChanged?.()
        return interactCraftingCell(cellIndex)
      })
    })
  })

  const preview = (): Effect.Effect<InventoryInteractionState> => Effect.suspend(() => {
    if (crafting) return Effect.succeed(state())
    const grid = current.grid
    return Effect.map(service.previewCraft(grid), (match) => {
      if (crafting) return state()
      current = { ...current, preview: match, status: undefined }
      return state()
    })
  })

  const craftOnce = (): Effect.Effect<InventoryInteractionState, InventoryInteractionError> =>
    Effect.suspend(() => {
      if (crafting) return Effect.succeed(state())

      crafting = true
      const grid = current.grid
      return Effect.ensuring(
        Effect.flatMap(service.craft(grid), (result) => {
          if (result._tag !== 'Crafted') {
            current = { ...current, preview: undefined, status: result }
            return Effect.succeed(state())
          }

          return Effect.flatMap(Effect.fromResult(craftedGrid(grid)), (nextGrid) => {
            current = {
              inventoryCarried: current.inventoryCarried,
              carried: undefined,
              grid: nextGrid,
              preview: undefined,
              status: result,
            }
            options.onCrafted?.()

            return Effect.matchCauseEffect(service.previewCraft(current.grid), {
              onFailure: () => Effect.succeed(state()),
              onSuccess: (match) => {
                current = { ...current, preview: match }
                return Effect.succeed(state())
              },
            })
          })
        }),
        Effect.sync(() => {
          crafting = false
        }),
      )
    })

  const confirmCraftOnce = (): Effect.Effect<InventoryInteractionState, ItemStackFailure> =>
    Effect.suspend(() => {
      if (crafting) return Effect.succeed(state())
      const nextGrid = craftedGrid(current.grid)
      if (Result.isFailure(nextGrid)) return Effect.fail(nextGrid.failure)
      crafting = true
      current = {
        inventoryCarried: current.inventoryCarried,
        carried: undefined,
        grid: nextGrid.success,
        preview: undefined,
        status: undefined,
      }
      options.onCrafted?.()
      return Effect.ensuring(
        Effect.matchCauseEffect(service.previewCraft(current.grid), {
          onFailure: () => Effect.succeed(state()),
          onSuccess: (match) => Effect.sync(() => {
            current = { ...current, preview: match }
            return state()
          }),
        }),
        Effect.sync(() => { crafting = false }),
      )
    })

  const close = (): Effect.Effect<InventoryInteractionState, InventoryInteractionError> => Effect.suspend(() => {
    if (crafting) return Effect.succeed(state())
    const inventoryCarried = current.inventoryCarried
    if (inventoryCarried === undefined) {
      return Effect.succeed(configureGrid(current.grid.width, current.grid.height))
    }
    return Effect.map(returnInventoryCarried(), () => {
      if (crafting) return state()
      current = {
        ...current,
        carried: undefined,
        grid: emptyGrid(current.grid.width, current.grid.height),
        preview: undefined,
        status: undefined,
      }
      return state()
    })
  })

  return {
    state,
    configureGrid,
    pickupInventoryItem,
    clickInventoryItem,
    interactCraftingCell,
    interactCraftingCellFromInventory,
    preview,
    craftOnce,
    confirmCraftOnce,
    reset,
    close,
  }
}
