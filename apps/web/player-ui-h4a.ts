import { Result } from 'effect'
import { type BlockRegistryResolutionFailure, type MonotonicTimeSecs } from '@nerima-games/mc-kernel'
import { addExperience as addVitalsExperience, EQUIPMENT_SLOTS, ExperienceDelta } from '@nerima-games/mc-sim'
import {
  crosshairViewModel,
  createPauseMenuView,
  hudViewModel,
  pauseMenuViewModel,
  type DomElement,
  type DomElementFactory,
} from '@nerima-games/mx-ui'
import {
  miningProgressFraction,
  spawnDroppedItems as spawnDroppedItemsForWorld,
  type EnchantedItem,
  type MiningProgressState,
} from '@nerima-games/mx-gameplay'
import { deathDropsFromPlayerStorage } from './player-death'
import { type DroppedItemMetadata } from './dropped-item-metadata'
import { type PlayerSettingsV1 } from './settings'
import { type SessionState } from './session-persistence'
import { type BedRespawnLocation } from './sleep-runtime'

type CrosshairView = {
  readonly render: (viewModel: Result.Result.Success<ReturnType<typeof crosshairViewModel>>) => void
}

export type H4aCrosshairContext = {
  readonly crosshair: CrosshairView
  readonly getPaused: () => boolean
  readonly isInventoryOpen: () => boolean
  readonly isTradeOpen: () => boolean
  readonly isBrewingOpen: () => boolean
  readonly getMiningProgress: () => MiningProgressState | null
}

export const renderCrosshair = (
  context: H4aCrosshairContext,
  nowSecs: MonotonicTimeSecs,
): void => {
  const modals: Parameters<typeof crosshairViewModel>[0]['modals'] =
    context.getPaused() ? ['pause'] : context.isInventoryOpen() || context.isTradeOpen() || context.isBrewingOpen() ? ['inventory'] : []
  const miningProgress = context.getMiningProgress()
  // Every input crosshairViewModel can reject is constant or already validated: modals
  // are ScreenId literals, lastHitAtSecs is undefined, pulseSecs is the library default,
  // breakProgress is a MiningProgressFraction decoded as finite in [0, 1], and nowSecs is a
  // MonotonicTimeSecs (finite, non-negative).
  context.crosshair.render(Result.getOrThrow(crosshairViewModel({
    modals,
    lastHitAtSecs: undefined,
    breakProgress: miningProgress === null ? undefined : miningProgressFraction(miningProgress),
  }, nowSecs)))
}

type StatusEffectView = {
  readonly type: string
  readonly remainingSecs: number
}

export type H4aHudContext = {
  readonly render: (viewModel: ReturnType<typeof hudViewModel>) => void
  readonly getHudInput: () => Parameters<typeof hudViewModel>
  readonly getActiveEffects: () => ReadonlyArray<StatusEffectView>
  readonly statusEffectsHud: Pick<HTMLElement, 'hidden' | 'textContent'>
  readonly documentBody: Pick<HTMLElement, 'setAttribute'>
}

export const renderPlayerHud = (context: H4aHudContext): void => {
  context.render(hudViewModel(...context.getHudInput()))
  const activeEffects = context.getActiveEffects()
  context.statusEffectsHud.hidden = activeEffects.length === 0
  context.statusEffectsHud.textContent = activeEffects
    .map((effect) => `${effect.type}: ${Math.ceil(effect.remainingSecs)}s`)
    .join(' | ')
  context.documentBody.setAttribute('data-status-effects', activeEffects
    .map((effect) => `${effect.type}:${Math.ceil(effect.remainingSecs)}`)
    .join(','))
}

type SpawnDrop = Parameters<typeof spawnDroppedItemsForWorld>[1][number]
type EquipmentSlot = typeof EQUIPMENT_SLOTS[number]
type Vitals = Parameters<typeof addVitalsExperience>[0]
type Dimension = SessionState['dimension']

export type H4aDeathContext = {
  readonly getPlayerPosition: () => Parameters<typeof deathDropsFromPlayerStorage>[1]
  readonly getStorageSnapshot: () => Parameters<typeof deathDropsFromPlayerStorage>[0]
  readonly customNames: Map<string, string>
  readonly enchantedItems: Map<string, EnchantedItem>
  readonly getFramesTotal: () => number
  readonly spawnDroppedItems: (drops: ReadonlyArray<SpawnDrop>) => ReadonlyArray<{ readonly id: string }>
  readonly getPlayerDimension: () => Dimension
  readonly droppedItemMetadataKey: (dimension: Dimension, entityId: string) => string
  readonly droppedItemMetadata: Map<string, DroppedItemMetadata>
  readonly equipmentMetadataKey: (slot: EquipmentSlot) => string
  readonly restoreEmptyStorage: () => void
  readonly getVitalsSnapshot: () => Vitals
  readonly restoreVitals: (vitals: Vitals) => void
  readonly setDeathDropDimension: (dimension: Dimension) => void
  readonly markSessionDirty: () => void
}

export const handleLocalPlayerDeath = (context: H4aDeathContext): void => {
  const deathPosition = context.getPlayerPosition()
  const storage = context.getStorageSnapshot()
  const drops = deathDropsFromPlayerStorage(storage, deathPosition, {
    customNames: Object.fromEntries(context.customNames),
    enchantedItems: Object.fromEntries(context.enchantedItems),
  })
  if (drops.length > 0) {
    const dropped = context.spawnDroppedItems(drops.map(({ customName: _customName, enchantments: _enchantments, ...drop }) => ({
      ...drop,
      eligibleFromFrame: context.getFramesTotal() + 1,
    })))
    const dimension = context.getPlayerDimension()
    dropped.forEach((entity, index) => {
      const drop = drops[index]
      if (drop === undefined) return
      context.droppedItemMetadata.set(context.droppedItemMetadataKey(dimension, String(entity.id)), {
        ...(drop.customName === undefined ? {} : { customName: drop.customName }),
        ...(drop.enchantments === undefined
          ? {}
          : {
              enchantedItem: {
                item: drop.item,
                durability: drop.durability ?? null,
                enchantments: drop.enchantments,
              },
            }),
      })
    })
  }
  storage.inventory.slots.forEach((_stack, index) => {
    context.customNames.delete(String(index))
    context.enchantedItems.delete(String(index))
  })
  for (const slot of EQUIPMENT_SLOTS) {
    context.customNames.delete(context.equipmentMetadataKey(slot))
    context.enchantedItems.delete(context.equipmentMetadataKey(slot))
  }
  context.restoreEmptyStorage()
  const vitals = context.getVitalsSnapshot()
  // TotalExperience is branded finite, so its negation always satisfies ExperienceDelta.
  context.restoreVitals(addVitalsExperience(vitals, ExperienceDelta(-vitals.totalExperience)))
  context.setDeathDropDimension(context.getPlayerDimension())
  context.markSessionDirty()
}

export type H4aRespawnContext = {
  readonly resetPrimaryAttackGesture: () => void
  readonly resetBowUse: () => void
  readonly resetProjectileStates: () => void
  readonly unmountVehicle: () => void
  readonly cancelFishing: () => void
  readonly resetSwimming: () => void
  readonly respawnVitals: () => void
  readonly clearGameplayDeathState: () => void
  readonly validRespawnLocation: () => Result.Result<BedRespawnLocation | null, BlockRegistryResolutionFailure>
  readonly clearRespawnLocation: () => void
  readonly leaveSleep: () => void
  readonly restorePlayerForRespawn: (location: BedRespawnLocation | null) => void
  readonly clearDeathDropDimension: () => void
  readonly resetSimState: (physicsEnabled: boolean) => void
  readonly setInventoryOpen: (open: boolean) => void
  readonly syncTouchControls: () => void
  readonly renderPlayerUi: () => void
  readonly markSessionDirty: () => void
}

// The bed check only reads the world, so it runs before any reset: a failed
// read returns with the dead player's state untouched.
export const respawnPlayer = (context: H4aRespawnContext): Result.Result<void, BlockRegistryResolutionFailure> => {
  const checkedRespawn = context.validRespawnLocation()
  if (Result.isFailure(checkedRespawn)) return Result.fail(checkedRespawn.failure)
  const validRespawn = checkedRespawn.success
  context.resetPrimaryAttackGesture()
  context.resetBowUse()
  context.resetProjectileStates()
  context.unmountVehicle()
  context.cancelFishing()
  context.resetSwimming()
  context.respawnVitals()
  context.clearGameplayDeathState()
  if (validRespawn === null) context.clearRespawnLocation()
  context.leaveSleep()
  context.restorePlayerForRespawn(validRespawn)
  context.clearDeathDropDimension()
  context.resetSimState(true)
  context.setInventoryOpen(false)
  context.syncTouchControls()
  context.renderPlayerUi()
  context.markSessionDirty()
  return Result.void
}

type PauseSettingsView = {
  readonly isOpen: () => boolean
  readonly open: (settings: PlayerSettingsV1, returnFocusTo: HTMLElement) => void
}

export type H4aPauseContext = {
  /** Runs `work` at the next frame boundary; the pause and close paths read and write the world. */
  readonly deferToFrameBoundary: (work: () => void) => void
  readonly document: Document
  readonly window: Pick<Window, 'location'>
  readonly canvas: HTMLCanvasElement
  readonly gameShell: HTMLElement
  readonly pauseOverlay: HTMLElement
  readonly resumeButton: HTMLElement
  readonly settingsButton: HTMLElement
  readonly saveQuitButton: HTMLElement
  readonly pauseError: HTMLElement
  readonly settingsView: PauseSettingsView
  readonly getPlayerSettings: () => PlayerSettingsV1
  readonly getPaused: () => boolean
  readonly setPaused: (paused: boolean) => void
  readonly isBrewingOpen: () => boolean
  readonly closeBrewing: () => void
  readonly isTradeOpen: () => boolean
  readonly closeTrade: () => void
  readonly isInventoryOpen: () => boolean
  readonly closeInventory: () => void
  readonly resetPrimaryAttackGesture: () => void
  readonly resetBowUse: () => void
  readonly renderCrosshair: () => void
  readonly syncTouchControls: () => void
  readonly requestFlush: () => Promise<void>
  readonly drainSettingsWrites: () => Promise<void>
}

export const installPauseControls = (context: H4aPauseContext): (() => void) => {
  const setPaused = (next: boolean): void => {
    context.resetPrimaryAttackGesture()
    if (next) context.resetBowUse()
    context.setPaused(next)
    context.gameShell.inert = next
    context.pauseOverlay.hidden = !next
    context.document.body.setAttribute('data-session-paused', String(next))
    context.renderCrosshair()
    context.syncTouchControls()
    if (next) {
      if (context.document.pointerLockElement === context.canvas) context.document.exitPointerLock()
      context.resumeButton.focus()
      return
    }
    context.pauseError.textContent = ''
    context.canvas.focus()
  }

  const handlePauseRequest = (): void => {
    if (context.isBrewingOpen()) {
      context.closeBrewing()
      return
    }
    if (context.isTradeOpen()) {
      context.closeTrade()
      return
    }
    if (context.isInventoryOpen()) {
      context.closeInventory()
      return
    }
    setPaused(!context.getPaused())
  }

  context.document.addEventListener('keydown', (event) => {
    if (context.settingsView.isOpen()) return
    if (event.code === 'Escape' && !event.repeat) {
      event.preventDefault()
      event.stopPropagation()
      context.deferToFrameBoundary(handlePauseRequest)
      return
    }

    if (!context.getPaused() || event.code !== 'Tab') return
    const pauseActions = [context.resumeButton, context.settingsButton, context.saveQuitButton].filter(
      (button) => !button.hasAttribute('disabled'),
    )
    const firstAction = pauseActions[0]
    const lastAction = pauseActions.at(-1)
    if (firstAction === undefined || lastAction === undefined) return

    const activeElement = context.document.activeElement
    const activeIsPauseAction = pauseActions.some((button) => button === activeElement)
    const allowsNativeFocusMove = event.shiftKey
      ? activeElement !== firstAction && activeIsPauseAction
      : activeElement !== lastAction && activeIsPauseAction
    if (allowsNativeFocusMove) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    ;(event.shiftKey ? lastAction : firstAction).focus()
  })
  context.resumeButton.addEventListener('click', () => context.deferToFrameBoundary(() => setPaused(false)))
  context.settingsButton.addEventListener('click', () => {
    context.pauseOverlay.inert = true
    context.settingsView.open(context.getPlayerSettings(), context.settingsButton)
  })
  context.saveQuitButton.addEventListener('click', () => {
    if (context.saveQuitButton.getAttribute('aria-busy') === 'true') return
    context.saveQuitButton.setAttribute('aria-busy', 'true')
    context.saveQuitButton.setAttribute('disabled', '')
    context.pauseError.textContent = ''
    void Promise.all([context.requestFlush(), context.drainSettingsWrites()])
      .then(() => context.window.location.assign('/'))
      .catch((error: unknown) => {
        context.pauseError.textContent = 'Save failed. Your world is still open; please try again.'
        console.error('[mc-compose] Save & Quit failed', error)
      })
      .finally(() => {
        context.saveQuitButton.removeAttribute('aria-busy')
        context.saveQuitButton.removeAttribute('disabled')
      })
  })

  return handlePauseRequest
}

export type PointerLockPauseFailure = {
  readonly _tag: 'PointerLockPauseFailure'
  readonly cause: unknown
}

export const installPlayerPauseMenu = (context: {
  readonly document: DomElementFactory & {
    readonly pointerLockElement: unknown
    addEventListener(type: string, listener: EventListener): void
    removeEventListener(type: string, listener: EventListener): void
    exitPointerLock(): void
  }
  readonly parent: DomElement
  readonly canvas: DomElement & { focus(): void; requestPointerLock(): void | Promise<void> }
  readonly deferToFrameBoundary: (work: () => void) => void
  readonly getPaused: () => boolean
  readonly setPaused: (paused: boolean) => void
  readonly canPause: () => boolean
  readonly clearGameplayInput: () => void
  readonly onOpenSettings: () => void
  readonly onSaveQuit: () => void
  readonly onFailure: (failure: PointerLockPauseFailure) => void
}): { readonly handleEscape: () => void; readonly closeSettings: () => void; readonly destroy: () => void } => {
  let disposed = false
  let pointerLockUsed = context.document.pointerLockElement === context.canvas
  let resumePending = false
  let settingsOpen = false
  const render = (): void => view.render(pauseMenuViewModel(
    context.getPaused() ? settingsOpen ? ['pause', 'settings'] : ['pause'] : [],
  ))
  const pause = (): void => {
    if (disposed || context.getPaused() || !context.canPause()) return
    resumePending = false
    settingsOpen = false
    context.clearGameplayInput()
    context.setPaused(true)
    render()
    if (context.document.pointerLockElement === context.canvas) context.document.exitPointerLock()
  }
  const finishResume = (): void => {
    if (disposed || !resumePending || !context.getPaused() || settingsOpen) return
    if (pointerLockUsed && context.document.pointerLockElement !== context.canvas) return
    resumePending = false
    settingsOpen = false
    context.clearGameplayInput()
    context.setPaused(false)
    render()
    context.canvas.focus()
  }
  const failResume = (cause: unknown): void => {
    if (disposed || !resumePending) return
    resumePending = false
    render()
    context.onFailure({ _tag: 'PointerLockPauseFailure', cause })
  }
  const resume = (): void => {
    render()
    if (resumePending || !context.getPaused()) return
    resumePending = true
    if (!pointerLockUsed || context.document.pointerLockElement === context.canvas) {
      context.deferToFrameBoundary(finishResume)
      return
    }
    // The native request must stay in the button's user gesture, before the frame boundary.
    const requested = Result.try(() => context.canvas.requestPointerLock())
    if (Result.isFailure(requested)) failResume(requested.failure)
    else if (requested.success !== undefined) void requested.success.catch(failResume)
  }
  const view = createPauseMenuView(context.document, context.parent, {
    onModalStackChange: (stack) => {
      if (stack.length === 0) {
        resume()
      } else if (stack.includes('settings')) {
        resumePending = false
        settingsOpen = true
        context.deferToFrameBoundary(() => { if (!disposed) context.onOpenSettings() })
      } else if (settingsOpen) {
        settingsOpen = false
      } else {
        context.deferToFrameBoundary(pause)
      }
    },
    onHostIntent: () => context.onSaveQuit(),
  })
  const pointerLockChanged: EventListener = () => {
    if (context.document.pointerLockElement === context.canvas) {
      pointerLockUsed = true
      if (context.getPaused() && !resumePending) {
        context.document.exitPointerLock()
        return
      }
      if (resumePending) context.deferToFrameBoundary(finishResume)
    } else if (pointerLockUsed && context.canPause()) {
      resumePending = false
      context.deferToFrameBoundary(() => {
        if (context.document.pointerLockElement !== context.canvas) pause()
      })
    }
  }
  const pointerLockFailed: EventListener = (event) => failResume(event)
  context.document.addEventListener('pointerlockchange', pointerLockChanged)
  context.document.addEventListener('pointerlockerror', pointerLockFailed)
  render()
  return {
    handleEscape: () => {
      if (!disposed && (context.getPaused() || context.canPause())) view.handleEscape()
    },
    closeSettings: () => {
      settingsOpen = false
      render()
    },
    destroy: () => {
      disposed = true
      context.document.removeEventListener('pointerlockchange', pointerLockChanged)
      context.document.removeEventListener('pointerlockerror', pointerLockFailed)
      view.destroy()
    },
  }
}
