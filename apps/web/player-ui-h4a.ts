import { Result } from 'effect'
import { type BlockRegistryResolutionFailure, type MonotonicTimeSecs } from '@nerima-games/mc-kernel'
import { addExperience as addVitalsExperience, EQUIPMENT_SLOTS, ExperienceDelta } from '@nerima-games/mc-sim'
import {
  crosshairViewModel,
  createPauseMenuView,
  hudViewModel,
  pauseMenuViewModel,
  type DomElement,
  type DomInputElement,
  type DomInteractiveElement,
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
import { sessionSaveFailureMessage } from './session-save-coordinator'
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

const SAVE_AND_QUIT_SETTINGS_FAILURE_MESSAGE = 'Save failed. Your world is still open; please try again.'

export type PointerLockPauseFailure = {
  readonly _tag: 'PointerLockPauseFailure'
  readonly cause: unknown
}

export type PauseSaveQuitFailure = {
  readonly _tag: 'PauseSaveQuitFailure'
  // One rejection reason per failed write, the world save first.
  readonly cause: ReadonlyArray<unknown>
}

type PauseButton = DomInteractiveElement & Pick<HTMLElement, 'getAttribute' | 'hasAttribute'>

export type PlayerPauseContext<Button extends PauseButton> = {
  /** Runs `work` at the next frame boundary; the pause and close paths read and write the world. */
  readonly deferToFrameBoundary: (work: () => void) => void
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
  readonly document: {
    createElement(tag: 'button'): Button
    createElement(tag: 'input'): DomInputElement
    createElement(tag: string): DomElement
    readonly body: Pick<HTMLElement, 'setAttribute'>
    readonly activeElement: unknown
    readonly pointerLockElement: unknown
    addEventListener(type: string, listener: EventListener): void
    removeEventListener(type: string, listener: EventListener): void
    exitPointerLock(): void
  }
  readonly window: { readonly location: Pick<Location, 'assign'> }
  readonly parent: DomElement & Pick<HTMLElement, 'inert' | 'hidden'>
  readonly canvas: DomElement & { focus(): void; requestPointerLock(): void | Promise<void> }
  readonly gameShell: Pick<HTMLElement, 'inert'>
  readonly settingsView: {
    readonly isOpen: () => boolean
    readonly open: (settings: PlayerSettingsV1, returnFocusTo: Button) => void
    readonly close: () => void
  }
  readonly canPause: () => boolean
  readonly clearGameplayInput: () => void
  readonly onFailure: (failure: PointerLockPauseFailure | PauseSaveQuitFailure) => void
}

export const installPlayerPauseMenu = <Button extends PauseButton>(context: PlayerPauseContext<Button>): {
  readonly handleEscape: () => void
  readonly closeSettings: () => void
  readonly reportError: (message: string) => void
  readonly clearError: () => void
  readonly destroy: () => void
} => {
  let disposed = false
  let pointerLockUsed = context.document.pointerLockElement === context.canvas
  let resumePending = false
  let settingsOpen = false
  const createdButtons: Array<Button> = []
  function createElement(tag: 'button'): Button
  function createElement(tag: 'input'): DomInputElement
  function createElement(tag: string): DomElement
  function createElement(tag: string): DomElement {
    if (tag === 'button') {
      const button = context.document.createElement('button')
      createdButtons.push(button)
      return button
    }
    return context.document.createElement(tag)
  }
  const render = (): void => {
    context.parent.hidden = !context.getPaused()
    view.render(pauseMenuViewModel(context.getPaused() ? settingsOpen ? ['pause', 'settings'] : ['pause'] : []))
  }
  const hasGameplayModal = (): boolean => context.isBrewingOpen() || context.isTradeOpen() || context.isInventoryOpen()
  const closeGameplayModal = (): void => {
    if (context.isBrewingOpen()) context.closeBrewing()
    else if (context.isTradeOpen()) context.closeTrade()
    else if (context.isInventoryOpen()) context.closeInventory()
  }
  const applyPaused = (next: boolean): void => {
    context.clearGameplayInput()
    context.resetPrimaryAttackGesture()
    if (next) context.resetBowUse()
    context.setPaused(next)
    context.gameShell.inert = next
    context.parent.hidden = !next
    context.document.body.setAttribute('data-session-paused', String(next))
    context.renderCrosshair()
    context.syncTouchControls()
    if (!next) {
      clearError()
      context.canvas.focus()
    }
  }
  const pause = (fromLockLoss: boolean): void => {
    if (disposed) return
    if (context.getPaused() || !context.canPause() || context.settingsView.isOpen() || hasGameplayModal()) {
      if (!fromLockLoss && !context.getPaused()) closeGameplayModal()
      render()
      return
    }
    resumePending = false
    settingsOpen = false
    applyPaused(true)
    if (fromLockLoss) {
      // The view owns the entry transition and Resume focus for both entry paths.
      view.render(pauseMenuViewModel([]))
      view.handleEscape()
    } else {
      render()
    }
    if (context.document.pointerLockElement === context.canvas) context.document.exitPointerLock()
  }
  const finishResume = (): void => {
    if (disposed || !resumePending || !context.getPaused() || settingsOpen || context.settingsView.isOpen()) return
    if (pointerLockUsed && context.document.pointerLockElement !== context.canvas) return
    resumePending = false
    settingsOpen = false
    applyPaused(false)
    render()
  }
  const failResume = (cause: unknown): void => {
    if (disposed || !resumePending) return
    resumePending = false
    render()
    reportError('Could not capture the pointer. Select Back to Game to try again.')
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
  const saveAndQuit = (): void => {
    if (disposed || !context.getPaused() || settingsOpen || saveQuitButton.getAttribute('aria-busy') === 'true') return
    saveQuitButton.setAttribute('aria-busy', 'true')
    saveQuitButton.setAttribute('disabled', '')
    clearError()
    // allSettled keeps one result per write, so the message names each failed
    // write and the button stays busy until both have settled.
    void Promise.allSettled([context.requestFlush(), context.drainSettingsWrites()])
      .then(([session, settings]) => {
        if (disposed) return
        if (session.status === 'fulfilled' && settings.status === 'fulfilled') {
          context.window.location.assign('/')
          return
        }
        reportError([
          ...(session.status === 'rejected' ? [sessionSaveFailureMessage(session.reason)] : []),
          ...(settings.status === 'rejected' ? [SAVE_AND_QUIT_SETTINGS_FAILURE_MESSAGE] : []),
        ].join(' '))
        context.onFailure({
          _tag: 'PauseSaveQuitFailure',
          cause: [session, settings].flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
        })
      })
      .finally(() => {
        saveQuitButton.removeAttribute('aria-busy')
        saveQuitButton.removeAttribute('disabled')
      })
  }
  const view = createPauseMenuView({ createElement }, context.parent, {
    onModalStackChange: (stack) => {
      if (stack.length === 0) {
        resume()
      } else if (stack.includes('settings')) {
        resumePending = false
        settingsOpen = true
        context.parent.inert = true
        context.deferToFrameBoundary(() => {
          if (!disposed && settingsOpen && context.getPaused()) {
            context.settingsView.open(context.getPlayerSettings(), settingsButton)
          }
        })
      } else if (settingsOpen) {
        settingsOpen = false
        context.parent.inert = false
      } else if (!context.getPaused()) {
        context.deferToFrameBoundary(() => pause(false))
      }
    },
    onHostIntent: saveAndQuit,
  })
  // mx-ui 0.11 creates these native controls with stable data-pause-action values.
  const actionButton = (action: string): Button => Result.getOrThrow(Result.fromNullishOr(
    createdButtons.find((button) => button.getAttribute('data-pause-action') === action),
    () => new Error(`mx-ui pause action is missing: ${action}`),
  ))
  const resumeButton = actionButton('resume')
  const settingsButton = actionButton('settings')
  const saveQuitButton = actionButton('save-and-quit')
  const pauseError = context.document.createElement('p')
  pauseError.setAttribute('role', 'alert')
  pauseError.setAttribute('data-pause-error', '')
  view.root.appendChild(pauseError)
  const reportError = (message: string): void => { pauseError.textContent = message }
  const clearError = (): void => reportError('')
  const pointerLockChanged: EventListener = () => {
    if (context.document.pointerLockElement === context.canvas) {
      pointerLockUsed = true
      if (context.getPaused() && !resumePending) {
        context.document.exitPointerLock()
        return
      }
      if (resumePending) context.deferToFrameBoundary(finishResume)
    } else if (pointerLockUsed && context.canPause() && !context.settingsView.isOpen() && !hasGameplayModal()) {
      resumePending = false
      context.deferToFrameBoundary(() => {
        if (context.document.pointerLockElement !== context.canvas) pause(true)
      })
    }
  }
  const pointerLockFailed: EventListener = (event) => failResume(event)
  const handleTab: EventListener = (event) => {
    if (disposed || !context.getPaused() || context.settingsView.isOpen() || settingsOpen
      || !('code' in event) || event.code !== 'Tab') return
    const actions = [resumeButton, settingsButton, saveQuitButton].filter((button) => !button.hasAttribute('disabled'))
    const first = actions[0]
    const last = actions.at(-1)
    if (first === undefined || last === undefined) return
    const active = context.document.activeElement
    const backwards = 'shiftKey' in event && event.shiftKey === true
    const isAction = actions.some((button) => button === active)
    if (isAction && (backwards ? active !== first : active !== last)) return
    event.preventDefault()
    event.stopPropagation()
    ;(backwards ? last : first).focus()
  }
  context.document.addEventListener('pointerlockchange', pointerLockChanged)
  context.document.addEventListener('pointerlockerror', pointerLockFailed)
  context.document.addEventListener('keydown', handleTab)
  render()
  return {
    handleEscape: () => {
      if (disposed) return
      // Keyboard Escape never gets here while settings is open: the dialog's
      // capture listener stops it before the input service's window listener.
      // A gamepad Escape does, and closes the dialog; its onClose calls
      // closeSettings, so the dialog and the pause view change together.
      if (context.settingsView.isOpen()) {
        context.settingsView.close()
        return
      }
      // Escape has no browser user activation. Desktop resume belongs to the native Resume click.
      if (context.getPaused() && pointerLockUsed && !settingsOpen) return
      if (!context.getPaused() && hasGameplayModal()) {
        context.deferToFrameBoundary(() => {
          if (!disposed) { closeGameplayModal(); render() }
        })
        return
      }
      if (!context.getPaused() && !context.canPause()) { render(); return }
      context.parent.hidden = false
      view.handleEscape()
    },
    closeSettings: () => {
      context.parent.inert = false
      if (settingsOpen) view.handleEscape()
      else render()
    },
    reportError,
    clearError,
    destroy: () => {
      disposed = true
      context.document.removeEventListener('pointerlockchange', pointerLockChanged)
      context.document.removeEventListener('pointerlockerror', pointerLockFailed)
      context.document.removeEventListener('keydown', handleTab)
      view.destroy()
    },
  }
}
