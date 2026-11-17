import { afterEach, describe, expect, it, vi } from 'vitest'
import { hudViewModel, type DomNode } from '@nerima-games/mx-ui'
import { Result } from 'effect'
import { EnchantmentLevel, MonotonicTimeSecs, position, PositionAxis } from '@nerima-games/mc-kernel'
import {
  DamageCause,
  emptyPlayerStorage,
  EntityHealthPoints,
  ExhaustionAmount,
  FoodSaturation,
  FoodTimerSecs,
  HungerPoints,
  itemStack,
  TotalExperience,
  type PlayerStorage,
  type Vitals,
} from '@nerima-games/mc-sim'
import type { EnchantedItem } from '@nerima-games/mx-gameplay'
import type { DroppedItemMetadata } from '../apps/web/dropped-item-metadata'
import { StorageError } from '@nerima-games/mc-save'
import { DEFAULT_PLAYER_SETTINGS } from '../apps/web/settings'
import {
  SESSION_SAVE_FAILURE_MESSAGE,
  SESSION_SAVE_STORAGE_FAILURE_MESSAGE,
} from '../apps/web/session-save-coordinator'

const mocks = vi.hoisted(() => ({ hudViewModel: vi.fn() }))

vi.mock('@nerima-games/mx-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nerima-games/mx-ui')>()
  return { ...actual, hudViewModel: mocks.hudViewModel }
})

import {
  handleLocalPlayerDeath,
  installPlayerPauseMenu,
  renderCrosshair,
  renderPlayerHud,
  respawnPlayer,
  type H4aDeathContext,
} from '../apps/web/player-ui-h4a'

class FakeElement {
  value = ''
  readonly nodeType = 1
  readonly style = { setProperty: vi.fn(), removeProperty: vi.fn() }
  readonly children: Array<FakeElement> = []
  hidden = false
  inert = false
  textContent = ''
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, EventListenerOrEventListenerObject>()
  private readonly focusElement: (element: FakeElement) => void

  constructor(focusElement: (element: FakeElement) => void = () => {}) {
    this.focusElement = focusElement
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener)
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type)
  }

  appendChild(child: DomNode): void {
    if (!(child instanceof FakeElement)) throw new Error('expected fake element')
    this.children.push(child)
  }

  findAction(action: string): FakeElement {
    if (this.attributes.get('data-pause-action') === action) return this
    for (const child of this.children) {
      const found = child.findActionOrUndefined(action)
      if (found !== undefined) return found
    }
    throw new Error(`missing pause action ${action}`)
  }

  private findActionOrUndefined(action: string): FakeElement | undefined {
    if (this.attributes.get('data-pause-action') === action) return this
    for (const child of this.children) {
      const found = child.findActionOrUndefined(action)
      if (found !== undefined) return found
    }
    return undefined
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  focus(): void {
    this.focusElement(this)
  }
}

const emit = (target: FakeElement, type: string, event: Event): void => {
  const listener = target.listeners.get(type)
  if (typeof listener === 'function') listener.call(target, event)
  else listener?.handleEvent(event)
}

const makePauseMenu = (locked = true) => {
  let focused: FakeElement | null = null
  const focus = (element: FakeElement): void => { focused = element }
  const events = new FakeElement()
  const parent = new FakeElement()
  const body = new FakeElement()
  const gameShell = new FakeElement()
  const canvas = Object.assign(new FakeElement(focus), { requestPointerLock: vi.fn<() => void | Promise<void>>() })
  const document = {
    body,
    get activeElement() { return focused },
    createElement: () => new FakeElement(focus),
    pointerLockElement: locked ? canvas : null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    exitPointerLock: vi.fn(() => { document.pointerLockElement = null }),
  }
  let paused = false
  let canPause = true
  let brewingOpen = false
  let tradeOpen = false
  let inventoryOpen = false
  let settingsVisible = false
  let settingsReturnFocus: FakeElement | undefined
  const order: Array<string> = []
  const deferred: Array<() => void> = []
  const clearGameplayInput = vi.fn()
  const setPaused = vi.fn((next: boolean) => { paused = next; order.push(`paused:${String(next)}`) })
  const onFailure = vi.fn()
  const onOpenSettings = vi.fn((_settings: typeof DEFAULT_PLAYER_SETTINGS, returnFocusTo: FakeElement) => {
    settingsVisible = true
    settingsReturnFocus = returnFocusTo
  })
  const requestFlush = vi.fn<() => Promise<void>>().mockResolvedValue()
  const drainSettingsWrites = vi.fn<() => Promise<void>>().mockResolvedValue()
  const assign = vi.fn()
  // The real settings view's close() hides the dialog, calls its onClose, which
  // the host wires to closeSettings, and then restores focus.
  const closeSettings = (): void => {
    if (!settingsVisible) return
    settingsVisible = false
    menu.closeSettings()
    settingsReturnFocus?.focus()
  }
  const menu = installPlayerPauseMenu({
    document, parent, canvas, gameShell,
    window: { location: { assign } },
    deferToFrameBoundary: (work) => { deferred.push(work) },
    getPaused: () => paused,
    setPaused,
    canPause: () => canPause,
    clearGameplayInput,
    settingsView: { isOpen: () => settingsVisible, open: onOpenSettings, close: closeSettings },
    getPlayerSettings: () => DEFAULT_PLAYER_SETTINGS,
    isBrewingOpen: () => brewingOpen,
    closeBrewing: () => { brewingOpen = false; order.push('close:brewing') },
    isTradeOpen: () => tradeOpen,
    closeTrade: () => { tradeOpen = false; order.push('close:trade') },
    isInventoryOpen: () => inventoryOpen,
    closeInventory: () => { inventoryOpen = false; order.push('close:inventory') },
    resetPrimaryAttackGesture: () => order.push('reset-attack'),
    resetBowUse: () => order.push('reset-bow'),
    renderCrosshair: () => order.push('crosshair'),
    syncTouchControls: () => order.push('touch'),
    requestFlush,
    drainSettingsWrites,
    onFailure,
  })
  return {
    menu, document, parent, canvas, body, gameShell, order,
    clearGameplayInput, setPaused, onFailure, onOpenSettings, requestFlush, drainSettingsWrites, assign,
    getPaused: () => paused,
    getFocused: () => focused,
    setCanPause: (next: boolean) => { canPause = next },
    openModals: () => { brewingOpen = true; tradeOpen = true; inventoryOpen = true },
    // A keyboard Escape or the Close button: the dialog closes itself, and the
    // key never reaches the frame's Escape handling.
    closeSettings,
    frame: () => { for (const work of deferred.splice(0)) work() },
    lockChanged: () => emit(events, 'pointerlockchange', new Event('pointerlockchange')),
    lockFailed: () => emit(events, 'pointerlockerror', new Event('pointerlockerror')),
    click: (action: string) => emit(parent.findAction(action), 'click', new Event('click')),
    tab: (backwards = false) => {
      const event = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Tab', shiftKey: backwards })
      emit(events, 'keydown', event)
      return event
    },
    errorText: () => parent.children[0]?.children.at(-1)?.textContent,
    errorRole: () => parent.children[0]?.children.at(-1)?.getAttribute('role'),
  }
}

describe('pointer lock pause menu', () => {
  it('keeps a desktop session paused on Escape without requesting pointer lock or reporting failure', () => {
    const state = makePauseMenu()
    state.menu.handleEscape()
    state.frame()
    state.menu.handleEscape()
    state.frame()
    expect(state.getPaused()).toBe(true)
    expect(state.canvas.requestPointerLock).not.toHaveBeenCalled()
    expect(state.onFailure).not.toHaveBeenCalled()
  })

  it('focuses Resume through the published view when pointer lock is lost', () => {
    const state = makePauseMenu()
    state.document.pointerLockElement = null
    state.lockChanged()
    state.frame()
    expect(state.getFocused()).toBe(state.parent.findAction('resume'))
  })

  it('hides the optimistic pause view if pause is no longer allowed at the frame boundary', () => {
    const state = makePauseMenu(false)
    state.menu.handleEscape()
    state.setCanPause(false)
    state.frame()
    expect(state.getPaused()).toBe(false)
    expect(state.parent.children[0]?.children[0]?.attributes.has('hidden')).toBe(true)
  })
  it('pauses once on lock loss and clears gameplay input at the frame boundary', () => {
    const state = makePauseMenu()
    state.document.pointerLockElement = null
    state.lockChanged()
    state.lockChanged()
    expect(state.getPaused()).toBe(false)
    expect(state.clearGameplayInput).not.toHaveBeenCalled()
    state.frame()
    expect(state.getPaused()).toBe(true)
    expect(state.setPaused).toHaveBeenCalledExactlyOnceWith(true)
    expect(state.clearGameplayInput).toHaveBeenCalledOnce()
    expect(state.parent.findAction('resume').attributes.has('hidden')).toBe(false)
  })

  it('ignores initial unlocked state and intentional modal or death unlocks', () => {
    const initial = makePauseMenu(false)
    initial.lockChanged()
    initial.frame()
    expect(initial.setPaused).not.toHaveBeenCalled()
    const modal = makePauseMenu()
    modal.setCanPause(false)
    modal.document.pointerLockElement = null
    modal.lockChanged()
    modal.setCanPause(true)
    modal.frame()
    expect(modal.setPaused).not.toHaveBeenCalled()
  })

  it('requests lock from the resume gesture and resumes only after lock acquisition', () => {
    const state = makePauseMenu()
    state.menu.handleEscape()
    state.frame()
    expect(state.getPaused()).toBe(true)
    state.click('resume')
    expect(state.canvas.requestPointerLock).toHaveBeenCalledOnce()
    state.frame()
    expect(state.getPaused()).toBe(true)
    state.document.pointerLockElement = state.canvas
    state.lockChanged()
    expect(state.getPaused()).toBe(true)
    state.frame()
    expect(state.getPaused()).toBe(false)
    expect(state.clearGameplayInput).toHaveBeenCalledTimes(2)
  })

  it('keeps pause open after a rejected lock request and allows retry', async () => {
    const state = makePauseMenu()
    const cause = new Error('lock denied')
    state.canvas.requestPointerLock.mockRejectedValueOnce(cause)
    state.menu.handleEscape()
    state.frame()
    state.click('resume')
    await Promise.resolve()
    state.frame()
    expect(state.getPaused()).toBe(true)
    expect(state.onFailure).toHaveBeenCalledExactlyOnceWith({ _tag: 'PointerLockPauseFailure', cause })
    state.click('resume')
    expect(state.canvas.requestPointerLock).toHaveBeenCalledTimes(2)
    state.lockFailed()
    expect(state.getPaused()).toBe(true)
    expect(state.onFailure).toHaveBeenCalledTimes(2)
  })

  it('does not resume if the acquired lock is lost again before the frame boundary', () => {
    const state = makePauseMenu()
    state.menu.handleEscape()
    state.frame()
    state.click('resume')
    state.document.pointerLockElement = state.canvas
    state.lockChanged()
    state.document.pointerLockElement = null
    state.lockChanged()
    state.frame()
    expect(state.getPaused()).toBe(true)
    state.click('resume')
    expect(state.canvas.requestPointerLock).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending resume when settings is opened before lock acquisition', () => {
    const state = makePauseMenu()
    state.menu.handleEscape()
    state.frame()
    state.click('resume')
    state.click('settings')
    state.document.exitPointerLock.mockImplementation(() => {
      state.document.pointerLockElement = null
      state.lockChanged()
    })
    state.document.pointerLockElement = state.canvas
    state.lockChanged()
    state.frame()
    expect(state.onOpenSettings).toHaveBeenCalledOnce()
    expect(state.getPaused()).toBe(true)
    expect(state.setPaused).toHaveBeenCalledTimes(1)
    expect(state.document.exitPointerLock).toHaveBeenCalledTimes(2)
    expect(state.document.pointerLockElement).toBeNull()
    state.closeSettings()
    state.click('resume')
    state.document.pointerLockElement = state.canvas
    state.lockChanged()
    state.frame()
    expect(state.getPaused()).toBe(false)
  })

  it('closes settings before resume and forwards save-and-quit once', () => {
    const state = makePauseMenu(false)
    state.menu.handleEscape()
    state.frame()
    state.click('settings')
    state.frame()
    expect(state.onOpenSettings).toHaveBeenCalledOnce()
    state.closeSettings()
    state.click('save-and-quit')
    expect(state.requestFlush).toHaveBeenCalledOnce()
    state.menu.handleEscape()
    state.frame()
    expect(state.getPaused()).toBe(false)
    expect(state.canvas.requestPointerLock).not.toHaveBeenCalled()
  })

  it('traps Tab at the first and last pause actions and leaves interior navigation native', () => {
    const state = makePauseMenu(false)
    state.menu.handleEscape()
    state.frame()
    expect(state.tab().defaultPrevented).toBe(false)
    expect(state.tab(true).defaultPrevented).toBe(true)
    expect(state.getFocused()).toBe(state.parent.findAction('save-and-quit'))
    expect(state.tab().defaultPrevented).toBe(true)
    expect(state.getFocused()).toBe(state.parent.findAction('resume'))
  })

  it('defers host settings opening, restores Options focus on close, and leaves its Escape to settings', () => {
    const state = makePauseMenu(false)
    state.menu.handleEscape()
    state.frame()
    state.click('settings')
    expect(state.parent.inert).toBe(true)
    expect(state.onOpenSettings).not.toHaveBeenCalled()
    state.frame()
    expect(state.onOpenSettings).toHaveBeenCalledExactlyOnceWith(DEFAULT_PLAYER_SETTINGS, state.parent.findAction('settings'))
    state.closeSettings()
    state.frame()
    expect(state.getPaused()).toBe(true)
    expect(state.parent.inert).toBe(false)
    expect(state.getFocused()).toBe(state.parent.findAction('settings'))
    state.menu.reportError('Settings could not be saved.')
    expect(state.errorText()).toBe('Settings could not be saved.')
    state.menu.clearError()
    expect(state.errorText()).toBe('')
  })

  it.each([
    { name: 'unlocked', locked: false },
    { name: 'pointer-locked', locked: true },
  ])('closes only settings on one gamepad Escape in a $name session', ({ locked }) => {
    const state = makePauseMenu(locked)
    state.menu.handleEscape()
    state.frame()
    state.click('settings')
    state.frame()
    expect(state.onOpenSettings).toHaveBeenCalledOnce()
    state.menu.handleEscape()
    state.frame()
    expect(state.getPaused()).toBe(true)
    expect(state.parent.inert).toBe(false)
    expect(state.parent.hidden).toBe(false)
    expect(state.parent.findAction('resume').attributes.has('hidden')).toBe(false)
    expect(state.getFocused()).toBe(state.parent.findAction('settings'))
    expect(state.onOpenSettings).toHaveBeenCalledOnce()
    state.click('settings')
    state.frame()
    expect(state.onOpenSettings).toHaveBeenCalledTimes(2)
  })

  it('resumes an unlocked session on the Escape after the one that closed settings', () => {
    const state = makePauseMenu(false)
    state.menu.handleEscape()
    state.frame()
    state.click('settings')
    state.frame()
    state.menu.handleEscape()
    state.frame()
    expect(state.getPaused()).toBe(true)
    state.menu.handleEscape()
    state.frame()
    expect(state.getPaused()).toBe(false)
  })

  it('waits for both save queues, prevents duplicate quit, and skips the busy action in the focus trap', async () => {
    const state = makePauseMenu(false)
    const worldSave = Promise.withResolvers<void>()
    const settingsSave = Promise.withResolvers<void>()
    state.requestFlush.mockReturnValueOnce(worldSave.promise)
    state.drainSettingsWrites.mockReturnValueOnce(settingsSave.promise)
    state.menu.handleEscape()
    state.frame()
    state.click('save-and-quit')
    state.click('save-and-quit')
    expect(state.requestFlush).toHaveBeenCalledOnce()
    expect(state.drainSettingsWrites).toHaveBeenCalledOnce()
    const quit = state.parent.findAction('save-and-quit')
    expect(quit.getAttribute('aria-busy')).toBe('true')
    expect(quit.hasAttribute('disabled')).toBe(true)
    state.parent.findAction('resume').focus()
    state.tab(true)
    expect(state.getFocused()).toBe(state.parent.findAction('settings'))
    worldSave.resolve()
    await Promise.resolve()
    expect(state.assign).not.toHaveBeenCalled()
    settingsSave.resolve()
    await vi.waitFor(() => expect(state.assign).toHaveBeenCalledExactlyOnceWith('/'))
    expect(quit.hasAttribute('aria-busy')).toBe(false)
    expect(quit.hasAttribute('disabled')).toBe(false)
  })

  it('keeps the world paused after a failed save and allows a successful retry', async () => {
    const state = makePauseMenu(false)
    const cause = new StorageError({ operation: 'put', key: 'mc-compose/session/w/head' })
    state.requestFlush.mockRejectedValueOnce(cause)
    state.menu.handleEscape()
    state.frame()
    state.click('save-and-quit')
    await vi.waitFor(() => expect(state.onFailure).toHaveBeenCalledExactlyOnceWith({ _tag: 'PauseSaveQuitFailure', cause: [cause] }))
    expect(state.errorText()).toBe(SESSION_SAVE_STORAGE_FAILURE_MESSAGE)
    expect(state.errorRole()).toBe('alert')
    expect(state.getPaused()).toBe(true)
    expect(state.assign).not.toHaveBeenCalled()
    expect(state.parent.findAction('save-and-quit').hasAttribute('disabled')).toBe(false)
    state.click('save-and-quit')
    await vi.waitFor(() => expect(state.assign).toHaveBeenCalledExactlyOnceWith('/'))
    expect(state.errorText()).toBe('')
  })

  it('keeps the settings message when only the settings drain fails', async () => {
    const state = makePauseMenu(false)
    const cause = new Error('settings write failed')
    state.drainSettingsWrites.mockRejectedValueOnce(cause)
    state.menu.handleEscape()
    state.frame()
    state.click('save-and-quit')
    await vi.waitFor(() => expect(state.onFailure).toHaveBeenCalledExactlyOnceWith({ _tag: 'PauseSaveQuitFailure', cause: [cause] }))
    expect(state.errorText()).toBe('Save failed. Your world is still open; please try again.')
    expect(state.assign).not.toHaveBeenCalled()
  })

  it('names both failed writes, the world save first, and passes both reasons on', async () => {
    const state = makePauseMenu(false)
    const sessionCause = new Error('unclassified world save failure')
    const settingsCause = new Error('settings write failed')
    state.requestFlush.mockRejectedValueOnce(sessionCause)
    state.drainSettingsWrites.mockRejectedValueOnce(settingsCause)
    state.menu.handleEscape()
    state.frame()
    state.click('save-and-quit')
    await vi.waitFor(() => expect(state.onFailure).toHaveBeenCalledExactlyOnceWith({
      _tag: 'PauseSaveQuitFailure',
      cause: [sessionCause, settingsCause],
    }))
    expect(state.errorText()).toBe(`${SESSION_SAVE_FAILURE_MESSAGE} Save failed. Your world is still open; please try again.`)
    expect(state.assign).not.toHaveBeenCalled()
  })

  it('stays busy after a world save failure until the settings drain settles', async () => {
    const state = makePauseMenu(false)
    const worldSave = Promise.withResolvers<void>()
    const settingsSave = Promise.withResolvers<void>()
    state.requestFlush.mockReturnValueOnce(worldSave.promise)
    state.drainSettingsWrites.mockReturnValueOnce(settingsSave.promise)
    state.menu.handleEscape()
    state.frame()
    state.click('save-and-quit')
    const quit = state.parent.findAction('save-and-quit')
    worldSave.reject(new StorageError({ operation: 'put', key: 'mc-compose/session/w/head' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(quit.getAttribute('aria-busy')).toBe('true')
    expect(state.onFailure).not.toHaveBeenCalled()
    settingsSave.resolve()
    await vi.waitFor(() => expect(quit.hasAttribute('aria-busy')).toBe(false))
    expect(state.errorText()).toBe(SESSION_SAVE_STORAGE_FAILURE_MESSAGE)
  })

  it('removes listeners and cancels queued transitions on destroy', () => {
    const state = makePauseMenu()
    state.document.pointerLockElement = null
    state.lockChanged()
    state.menu.destroy()
    state.frame()
    state.lockChanged()
    state.menu.handleEscape()
    expect(state.setPaused).not.toHaveBeenCalled()
  })
})

describe('H4a player UI', () => {
  afterEach(() => vi.clearAllMocks())

  it('renders a fixed idle crosshair model with no modal open', () => {
    const rendered: Array<unknown> = []
    const getterOrder: Array<string> = []

    renderCrosshair({
      crosshair: { render: (viewModel) => rendered.push(viewModel) },
      getPaused: () => { getterOrder.push('paused'); return false },
      isInventoryOpen: () => { getterOrder.push('inventory'); return false },
      isTradeOpen: () => { getterOrder.push('trade'); return false },
      isBrewingOpen: () => { getterOrder.push('brewing'); return false },
      getMiningProgress: () => { getterOrder.push('mining'); return null },
    }, MonotonicTimeSecs(0))

    expect(getterOrder).toEqual(['paused', 'inventory', 'trade', 'brewing', 'mining'])
    expect(rendered).toEqual([{ breakProgress: undefined, hit: false }])
  })

  it('renders status effects into the HUD DOM with fixed labels and data', () => {
    const statusEffectsHud = new FakeElement()
    const attributes = new Map<string, string>()
    const documentBody = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    }
    const rendered: Array<unknown> = []
    const hudInput: Parameters<typeof hudViewModel> = [
      {
        healthPoints: EntityHealthPoints(17),
        maxHealthPoints: EntityHealthPoints(20),
        hungerPoints: HungerPoints(13),
        maxHungerPoints: HungerPoints(20),
        saturation: FoodSaturation(5),
        exhaustion: ExhaustionAmount(0),
        foodTimerSecs: FoodTimerSecs(0),
        // Level 2 at 0.375 progress: 16 total for level 2 plus 0.375 of its 11-point cost.
        totalExperience: TotalExperience(20.125),
        lastDamageCause: undefined,
      },
      [Result.getOrThrow(itemStack('stone', 4))],
      1,
    ]
    const hudModel: ReturnType<typeof hudViewModel> = {
      dead: false,
      experienceLevelLabel: '2',
      experiencePercent: 37,
      hearts: ['full', 'half'],
      hotbar: [],
      shanks: ['full', 'half'],
    }
    mocks.hudViewModel.mockReturnValue(hudModel)

    renderPlayerHud({
      render: (viewModel) => rendered.push(viewModel),
      getHudInput: () => hudInput,
      getActiveEffects: () => [
        { type: 'speed', remainingSecs: 3.01 },
        { type: 'regeneration', remainingSecs: 1 },
      ],
      statusEffectsHud: statusEffectsHud as unknown as HTMLElement,
      documentBody,
    })

    expect(mocks.hudViewModel).toHaveBeenCalledExactlyOnceWith(...hudInput)
    expect(rendered).toEqual([hudModel])
    expect(statusEffectsHud.hidden).toBe(false)
    expect(statusEffectsHud.textContent).toBe('speed: 4s | regeneration: 1s')
    expect(attributes.get('data-status-effects')).toBe('speed:4,regeneration:1')
  })

  it('spawns fixed death drops, transfers metadata, clears storage metadata, restores vitals, and dirties the session', () => {
    const empty = emptyPlayerStorage()
    const inventorySlots = [...empty.inventory.slots]
    inventorySlots[0] = Result.getOrThrow(itemStack('diamond_pickaxe', 1))
    inventorySlots[5] = Result.getOrThrow(itemStack('stone', 4))
    const storage: PlayerStorage = {
      ...empty,
      inventory: { slots: inventorySlots },
      inventoryDurability: empty.inventoryDurability.map((durability, index) =>
        index === 0 ? { current: 1500, max: 1561 } : durability,
      ),
    }
    const deathPosition = position(PositionAxis(4.5), PositionAxis(65), PositionAxis(-2.25))
    const vitals: Vitals = {
      healthPoints: EntityHealthPoints(6),
      maxHealthPoints: EntityHealthPoints(20),
      hungerPoints: HungerPoints(13),
      maxHungerPoints: HungerPoints(20),
      saturation: FoodSaturation(2),
      exhaustion: ExhaustionAmount(1),
      foodTimerSecs: FoodTimerSecs(3),
      totalExperience: TotalExperience(27),
      lastDamageCause: DamageCause('fall'),
    }
    const customNames = new Map<string, string>([
      ['0', 'Fortune Miner'],
      ['5', 'Stone stash'],
      ['equipment:head', 'Stale helmet name'],
      ['unrelated', 'Keep this'],
    ])
    const enchantedItems = new Map<string, EnchantedItem>([
      ['0', {
        item: 'diamond_pickaxe',
        durability: { current: 1500, max: 1561 },
        enchantments: [{ id: 'fortune', level: EnchantmentLevel(3) }],
      }],
      ['equipment:head', {
        item: 'iron_helmet',
        durability: null,
        enchantments: [{ id: 'protection', level: EnchantmentLevel(2) }],
      }],
      ['unrelated', { item: 'dirt', durability: null, enchantments: [] }],
    ])
    const droppedItemMetadata = new Map<string, DroppedItemMetadata>([
      ['nether:existing-drop', { customName: 'Keep existing drop' }],
    ])
    let spawnedDrops: Parameters<H4aDeathContext['spawnDroppedItems']>[0] = []
    let restoredVitals: Parameters<H4aDeathContext['restoreVitals']>[0] | undefined
    const restoreEmptyStorage = vi.fn()
    const restoreVitals = vi.fn((next: Parameters<H4aDeathContext['restoreVitals']>[0]) => {
      restoredVitals = next
    })
    const setDeathDropDimension = vi.fn()
    const markSessionDirty = vi.fn()

    handleLocalPlayerDeath({
      getPlayerPosition: () => deathPosition,
      getStorageSnapshot: () => storage,
      customNames,
      enchantedItems,
      getFramesTotal: () => 40,
      spawnDroppedItems: (drops) => {
        spawnedDrops = drops
        return [{ id: 'drop-1' }, { id: 'drop-2' }]
      },
      getPlayerDimension: () => 'overworld',
      droppedItemMetadataKey: (dimension, entityId) => `${dimension}:${entityId}`,
      droppedItemMetadata,
      equipmentMetadataKey: (slot) => `equipment:${slot}`,
      restoreEmptyStorage,
      getVitalsSnapshot: () => vitals,
      restoreVitals,
      setDeathDropDimension,
      markSessionDirty,
    })

    expect(spawnedDrops).toStrictEqual([
      {
        item: 'diamond_pickaxe',
        count: 1,
        at: { x: 4.5, y: 65, z: -2.25 },
        durability: { current: 1500, max: 1561 },
        eligibleFromFrame: 41,
      },
      {
        item: 'stone',
        count: 4,
        at: { x: 4.5, y: 65, z: -2.25 },
        durability: null,
        eligibleFromFrame: 41,
      },
    ])
    expect([...droppedItemMetadata.entries()]).toStrictEqual([
      ['nether:existing-drop', { customName: 'Keep existing drop' }],
      ['overworld:drop-1', {
        customName: 'Fortune Miner',
        enchantedItem: {
          item: 'diamond_pickaxe',
          durability: { current: 1500, max: 1561 },
          enchantments: [{ id: 'fortune', level: 3 }],
        },
      }],
      ['overworld:drop-2', { customName: 'Stone stash' }],
    ])
    expect([...customNames.entries()]).toStrictEqual([['unrelated', 'Keep this']])
    expect([...enchantedItems.entries()]).toStrictEqual([
      ['unrelated', { item: 'dirt', durability: null, enchantments: [] }],
    ])
    expect(restoreEmptyStorage).toHaveBeenCalledOnce()
    expect(restoreVitals).toHaveBeenCalledOnce()
    expect(restoredVitals).toStrictEqual({
      healthPoints: 6,
      maxHealthPoints: 20,
      hungerPoints: 13,
      maxHungerPoints: 20,
      saturation: 2,
      exhaustion: 1,
      foodTimerSecs: 3,
      totalExperience: 0,
      lastDamageCause: 'fall',
    })
    expect(setDeathDropDimension).toHaveBeenCalledExactlyOnceWith('overworld')
    expect(markSessionDirty).toHaveBeenCalledOnce()
  })

  it('closes open modals in priority order before toggling pause and restores focus on resume', () => {
    const state = makePauseMenu()
    state.openModals()
    state.menu.handleEscape()
    // Closing a screen touches the world, so it waits for the frame boundary.
    expect(state.order).toEqual([])
    state.frame()
    expect(state.order).toEqual(['close:brewing'])
    state.menu.handleEscape()
    state.frame()
    expect(state.order).toEqual(['close:brewing', 'close:trade'])
    state.menu.handleEscape()
    state.frame()
    expect(state.order).toEqual(['close:brewing', 'close:trade', 'close:inventory'])
    state.menu.handleEscape()
    expect(state.getPaused()).toBe(false)
    state.frame()
    expect(state.getPaused()).toBe(true)
    expect(state.gameShell.inert).toBe(true)
    expect(state.parent.hidden).toBe(false)
    expect(state.body.attributes.get('data-session-paused')).toBe('true')
    expect(state.document.exitPointerLock).toHaveBeenCalledOnce()
    expect(state.getFocused()).toBe(state.parent.findAction('resume'))
    expect(state.order.slice(-5)).toEqual([
      'reset-attack',
      'reset-bow',
      'paused:true',
      'crosshair',
      'touch',
    ])

    state.click('resume')
    expect(state.getPaused()).toBe(true)
    state.document.pointerLockElement = state.canvas
    state.lockChanged()
    state.frame()
    expect(state.getPaused()).toBe(false)
    expect(state.parent.hidden).toBe(true)
    expect(state.gameShell.inert).toBe(false)
    expect(state.body.attributes.get('data-session-paused')).toBe('false')
    expect(state.getFocused()).toBe(state.canvas)
  })

  it('checks the bed first, then preserves respawn action order and clears a missing bed before restoring the player', () => {
    const order: Array<string> = []
    const record = (name: string) => () => { order.push(name) }

    const result = respawnPlayer({
      resetPrimaryAttackGesture: record('attack'),
      resetBowUse: record('bow'),
      resetProjectileStates: record('projectiles'),
      unmountVehicle: record('vehicle'),
      cancelFishing: record('fishing'),
      resetSwimming: record('swimming'),
      respawnVitals: record('vitals'),
      clearGameplayDeathState: record('death-state'),
      validRespawnLocation: () => { order.push('validate-bed'); return Result.succeed(null) },
      clearRespawnLocation: record('clear-bed'),
      leaveSleep: record('leave-sleep'),
      restorePlayerForRespawn: (location) => order.push(`restore:${String(location)}`),
      clearDeathDropDimension: record('clear-death-dimension'),
      resetSimState: (physicsEnabled) => order.push(`physics:${String(physicsEnabled)}`),
      setInventoryOpen: (open) => order.push(`inventory:${String(open)}`),
      syncTouchControls: record('touch'),
      renderPlayerUi: record('render-ui'),
      markSessionDirty: record('dirty'),
    })

    expect(Result.isSuccess(result)).toBe(true)
    expect(order).toEqual([
      'validate-bed',
      'attack',
      'bow',
      'projectiles',
      'vehicle',
      'fishing',
      'swimming',
      'vitals',
      'death-state',
      'clear-bed',
      'leave-sleep',
      'restore:null',
      'clear-death-dimension',
      'physics:true',
      'inventory:false',
      'touch',
      'render-ui',
      'dirty',
    ])
  })

  it('returns a failed bed check before resetting or restoring anything', () => {
    const order: Array<string> = []
    const record = (name: string) => () => { order.push(name) }
    const failure = { _tag: 'BlockDefinitionFailure', reason: 'invalid-shape', message: 'fixture bed read failure' } as const

    const result = respawnPlayer({
      resetPrimaryAttackGesture: record('attack'),
      resetBowUse: record('bow'),
      resetProjectileStates: record('projectiles'),
      unmountVehicle: record('vehicle'),
      cancelFishing: record('fishing'),
      resetSwimming: record('swimming'),
      respawnVitals: record('vitals'),
      clearGameplayDeathState: record('death-state'),
      validRespawnLocation: () => Result.fail(failure),
      clearRespawnLocation: record('clear-bed'),
      leaveSleep: record('leave-sleep'),
      restorePlayerForRespawn: record('restore'),
      clearDeathDropDimension: record('clear-death-dimension'),
      resetSimState: record('physics'),
      setInventoryOpen: record('inventory'),
      syncTouchControls: record('touch'),
      renderPlayerUi: record('render-ui'),
      markSessionDirty: record('dirty'),
    })

    expect(result).toEqual(Result.fail(failure))
    expect(order).toEqual([])
  })
})
