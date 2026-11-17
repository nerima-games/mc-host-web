import { Brand, Effect, Layer, Result, Schema } from 'effect'
import { InputAction, KeyCode } from '@nerima-games/mc-kernel'
import {
  defineFormat,
  makeInMemoryStorage,
  SaveKey,
  saveTo,
  StorageError,
  StoragePort,
} from '@nerima-games/mc-save'
import type { DomNode } from '@nerima-games/mx-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bootTitleMenu,
  installPlayerOnboarding,
  playerControlHints,
  type TitleMenuContext,
} from '../apps/web/title-menu'
import {
  DEFAULT_PLAYER_SETTINGS,
  loadPlayerSettings,
  PLAYER_SETTINGS_FORMAT_NAME,
  PLAYER_SETTINGS_KEY,
  type PlayerSettingsV1,
} from '../apps/web/settings'
import { SessionIncompatibleError, type UnavailableSession } from '../apps/web/session-persistence'
import {
  SESSION_FUTURE_VERSION_MESSAGE,
  SESSION_STORAGE_FAILURE_MESSAGE,
} from '../apps/web/session-restoration'

const mocks = vi.hoisted(() => ({
  sessions: [{ sessionId: 'saved-world', metadata: { name: 'Saved World' } }],
  unavailable: [] as Array<UnavailableSession>,
  listFailure: { error: undefined as StorageError | undefined },
  storage: { layer: undefined as Layer.Layer<StoragePort> | undefined },
  createMainMenuView: vi.fn(() => ({ render: vi.fn() })),
  createSettingsView: vi.fn((
    _document: Document,
    _root: HTMLElement,
    _callbacks: Parameters<typeof import('../apps/web/settings-view')['createSettingsView']>[2],
  ) => ({
    open: vi.fn(),
    replaceSettings: vi.fn(),
    clearPersistenceError: vi.fn(),
    reportPersistenceError: vi.fn(),
    reportPersistenceSaving: vi.fn(),
    reportPersistenceSaved: vi.fn(),
    reportLoadFailure: vi.fn(),
    reportStoredRecordReplaced: vi.fn(),
    dispose: vi.fn(),
  })),
}))

vi.mock('@nerima-games/mc-save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nerima-games/mc-save')>()
  return {
    ...actual,
    indexedDbStorageLayer: () => mocks.storage.layer ?? actual.InMemoryStorageLayer,
  }
})

vi.mock('@nerima-games/mx-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nerima-games/mx-ui')>()
  return { ...actual, createMainMenuView: mocks.createMainMenuView }
})

vi.mock('../apps/web/session-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../apps/web/session-persistence')>()
  const { Effect } = await import('effect')
  return {
    ...actual,
    listSessionEntries: () => mocks.listFailure.error === undefined
      ? Effect.succeed({ sessions: mocks.sessions, unavailable: mocks.unavailable })
      : Effect.fail(mocks.listFailure.error),
  }
})

vi.mock('../apps/web/settings-view', () => ({
  createSettingsView: mocks.createSettingsView,
}))

class FakeElement {
  focusCount = 0
  readonly nodeType = 1
  readonly style = { setProperty: vi.fn(), removeProperty: vi.fn() }
  hidden = false
  inert = false
  disabled = false
  value = ''
  textContent = ''
  readonly attributes = new Map<string, string>()
  readonly children: Array<FakeElement> = []
  readonly listeners = new Map<string, EventListenerOrEventListenerObject>()

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  querySelectorAll<T extends Element>(): NodeListOf<T> {
    return this.children as unknown as NodeListOf<T>
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener)
  }

  appendChild(child: DomNode): void {
    if (!(child instanceof FakeElement)) throw new Error('expected fake element')
    this.children.push(child)
  }

  focus(): void { this.focusCount += 1 }

  find(attribute: string, value: string): FakeElement | undefined {
    if (this.attributes.get(attribute) === value) return this
    for (const child of this.children) {
      const found = child.find(attribute, value)
      if (found !== undefined) return found
    }
    return undefined
  }

  click(): void {
    const listener = this.listeners.get('click')
    if (typeof listener === 'function') listener.call(this, new Event('click'))
    else listener?.handleEvent(new Event('click'))
  }

  replaceChildren(...children: Array<FakeElement>): void {
    this.children.splice(0, this.children.length, ...children)
  }
}

class FakeFormElement extends FakeElement {
  valid = true

  reportValidity(): boolean {
    return this.valid
  }

  submit(): void {
    const listener = this.listeners.get('submit')
    if (typeof listener === 'function') listener.call(this, new Event('submit'))
    else listener?.handleEvent(new Event('submit'))
  }
}

class FakeSelectElement extends FakeElement {}
class FakeInputElement extends FakeElement {}
class FakeButtonElement extends FakeElement {}

const makeTitleMenuContext = () => {
  const body = new FakeElement()
  const titleScreen = new FakeElement()
  const menuParent = new FakeElement()
  const titleStatus = new FakeElement()
  const settingsRoot = new FakeElement()
  const multiplayerJoin = new FakeFormElement()
  const multiplayerWorld = new FakeSelectElement()
  const multiplayerName = new FakeInputElement()
  const multiplayerPlayer = new FakeInputElement()
  const multiplayerUrl = new FakeInputElement()
  const multiplayerRegistrationToken = new FakeInputElement()
  const multiplayerJoinButton = new FakeButtonElement()
  const elements = new Map<string, FakeElement>([
    ['title-screen', titleScreen],
    ['main-menu-root', menuParent],
    ['title-status', titleStatus],
    ['settings-root', settingsRoot],
    ['multiplayer-join', multiplayerJoin],
    ['multiplayer-world', multiplayerWorld],
    ['multiplayer-name', multiplayerName],
    ['multiplayer-player', multiplayerPlayer],
    ['multiplayer-url', multiplayerUrl],
    ['multiplayer-registration-token', multiplayerRegistrationToken],
    ['multiplayer-join-button', multiplayerJoinButton],
  ])
  const document = {
    body,
    activeElement: null,
    createElement: vi.fn(() => new FakeElement()),
  }
  const location = {
    search: '?loadError=missing-session',
    href: 'https://game.example/',
    origin: 'https://game.example',
    assign: vi.fn(),
  }
  const sessionStorage = {
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }
  const window = {
    location,
    sessionStorage,
    localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    HTMLFormElement: FakeFormElement,
    HTMLSelectElement: FakeSelectElement,
    HTMLInputElement: FakeInputElement,
    HTMLButtonElement: FakeButtonElement,
    HTMLElement: FakeElement,
  }
  const dispose = vi.fn()
  return {
    context: {
      document: document as unknown as Document,
      window: window as unknown as Window & typeof globalThis,
      indexedDB: {} as IDBFactory,
      crypto: { randomUUID: (): ReturnType<Crypto['randomUUID']> => '12345678-abcd-1234-abcd-12345678abcd' },
      requireElement: (id: string) => {
        const element = elements.get(id)
        if (element === undefined) throw new Error(`missing fake element: ${id}`)
        return element as unknown as HTMLElement
      },
      enqueueSettingsWrite: vi.fn<TitleMenuContext['enqueueSettingsWrite']>(),
      drainSettingsWrites: vi.fn(async () => {}),
      multiplayerRegistrationTokenKey: vi.fn(() => 'registration-key'),
      hot: { dispose },
    },
    body,
    titleScreen,
    menuParent,
    titleStatus,
    multiplayerJoin,
    multiplayerWorld,
    multiplayerName,
    multiplayerPlayer,
    multiplayerUrl,
    multiplayerRegistrationToken,
    multiplayerJoinButton,
    location,
    sessionStorage,
    dispose,
    window,
  }
}

describe('title menu boot', () => {
  afterEach(() => {
    mocks.sessions.splice(1)
    mocks.unavailable.splice(0)
    mocks.listFailure.error = undefined
    mocks.storage.layer = undefined
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('populates saved worlds and joins one through the title form', async () => {
    const state = makeTitleMenuContext()

    await bootTitleMenu(state.context)

    expect(state.titleScreen.hidden).toBe(false)
    expect(state.body.attributes.get('data-mc-compose-route')).toBe('title')
    expect(state.body.attributes.get('data-mc-compose-boot')).toBe('running')
    expect(state.titleStatus.textContent).toBe('The requested saved world could not be found.')
    expect(state.multiplayerWorld.children).toHaveLength(1)
    expect(state.multiplayerWorld.children[0]).toMatchObject({
      value: 'saved-world',
      textContent: 'Saved World',
    })
    expect(state.multiplayerJoinButton.disabled).toBe(false)
    expect(state.multiplayerPlayer.value).toBe('player-12345678')

    state.multiplayerWorld.value = 'saved-world'
    state.multiplayerPlayer.value = 'alice'
    state.multiplayerName.value = 'Alice'
    state.multiplayerUrl.value = 'wss://game.example/socket'
    state.multiplayerRegistrationToken.value = 'test-token'
    state.multiplayerJoin.submit()

    await vi.waitFor(() => expect(state.location.assign).toHaveBeenCalledOnce())

    expect(state.sessionStorage.setItem).toHaveBeenCalledWith('registration-key', 'test-token')
    expect(state.location.assign).toHaveBeenCalledWith(
      '/?session=saved-world&multiplayer=wss%3A%2F%2Fgame.example%2Fsocket&player=alice&multiplayerName=Alice',
    )
    expect(state.menuParent.attributes.get('aria-busy')).toBe('true')
    expect(state.dispose).toHaveBeenCalledOnce()
  })

  it('leaves a stored session with a blank id out of the saved worlds and reports it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.sessions.push({ sessionId: '   ', metadata: { name: 'Blank Id World' } })
    const state = makeTitleMenuContext()

    await bootTitleMenu(state.context)

    expect(state.multiplayerWorld.children).toHaveLength(1)
    expect(state.multiplayerWorld.children[0]).toMatchObject({
      value: 'saved-world',
      textContent: 'Saved World',
    })
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      '[mc-compose] saved session has an invalid world id',
      expect.any(Brand.BrandError),
    )
  })

  const futureVersionWorld = (): UnavailableSession => ({
    sessionId: 'future-world',
    failure: new SessionIncompatibleError({
      reason: 'future-version',
      key: SaveKey('mc-compose/session/future-world/head'),
      storedVersion: 19,
      currentVersion: 18,
    }),
  })

  it('shows the message for the failure class a game redirect names', async () => {
    const state = makeTitleMenuContext()
    state.location.search = '?loadError=future-version-session'

    await bootTitleMenu(state.context)

    expect(state.titleStatus.textContent).toBe(SESSION_FUTURE_VERSION_MESSAGE)
  })

  it('shows nothing for a loadError value no redirect produces', async () => {
    const state = makeTitleMenuContext()
    state.location.search = '?loadError=toString'

    await bootTitleMenu(state.context)

    expect(state.titleStatus.textContent).toBe('')
  })

  it('says why a stored world that cannot be opened is missing from the list', async () => {
    mocks.unavailable.push(futureVersionWorld())
    const state = makeTitleMenuContext()
    state.location.search = ''

    await bootTitleMenu(state.context)

    expect(state.titleStatus.textContent).toBe(SESSION_FUTURE_VERSION_MESSAGE)
    expect(state.multiplayerWorld.children.map(({ value }) => value)).toEqual(['saved-world'])
  })

  it('keeps a redirect message over the unavailable-world message', async () => {
    mocks.unavailable.push(futureVersionWorld())
    const state = makeTitleMenuContext()

    await bootTitleMenu(state.context)

    expect(state.titleStatus.textContent).toBe('The requested saved world could not be found.')
  })

  it('reports a storage failure while listing worlds and still finishes the title boot', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new StorageError({ operation: 'get', key: 'mc-compose/session/saved-world/head' })
    mocks.listFailure.error = error
    const state = makeTitleMenuContext()
    state.location.search = ''

    await bootTitleMenu(state.context)

    expect(state.titleStatus.textContent).toBe(SESSION_STORAGE_FAILURE_MESSAGE)
    expect(state.multiplayerWorld.children).toEqual([])
    expect(state.multiplayerJoinButton.disabled).toBe(true)
    expect(state.body.attributes.get('data-mc-compose-boot')).toBe('running')
    expect(consoleError).toHaveBeenCalledWith('[mc-compose] saved worlds could not be listed', error)
  })

  it('shows current bindings on the first visit and hides them after dismissal', async () => {
    const state = makeTitleMenuContext()
    await bootTitleMenu(state.context)
    const root = state.titleScreen.find('data-mx-ui', 'onboarding')
    expect(root?.attributes.has('hidden')).toBe(false)
    expect(root?.find('data-onboarding-control-action', 'moveForward')).toBeDefined()
    expect(root?.find('data-onboarding-control-action', 'escape')).toBeDefined()
    const dismiss = root?.find('data-onboarding-action', 'PersistQuickControlsDismissal')
    expect(dismiss).toBeDefined()
    dismiss?.click()
    expect(state.window.localStorage.setItem).toHaveBeenCalledExactlyOnceWith('mc-host-web/quick-controls-dismissed', 'true')
    expect(root?.attributes.has('hidden')).toBe(true)
  })

  it('reports inaccessible browser storage instead of treating it as a first visit', async () => {
    const state = makeTitleMenuContext()
    const cause = new Error('storage denied')
    state.window.localStorage.getItem.mockImplementation(() => { throw cause })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await bootTitleMenu(state.context)
    expect(state.titleStatus.textContent).toBe('Controls preferences could not be loaded.')
    expect(error).toHaveBeenCalledExactlyOnceWith('[mc-compose] controls persistence failed', {
      _tag: 'OnboardingPersistenceFailure', operation: 'read', cause,
    })
    expect(state.titleScreen.find('data-mx-ui', 'onboarding')).toBeUndefined()
  })

  it('reopens dismissed controls from the title Controls button', async () => {
    const state = makeTitleMenuContext()
    await bootTitleMenu(state.context)
    const root = state.titleScreen.find('data-mx-ui', 'onboarding')
    root?.find('data-onboarding-action', 'PersistQuickControlsDismissal')?.click()
    expect(root?.attributes.has('hidden')).toBe(true)
    const controls = state.titleScreen.find('data-title-action', 'show-controls')
    expect(controls).toBeDefined()
    controls?.click()
    expect(root?.attributes.has('hidden')).toBe(false)
  })

  it('updates the displayed controls after rebinding a key in title settings', async () => {
    const state = makeTitleMenuContext()
    await bootTitleMenu(state.context)
    const jump = state.titleScreen.find('data-onboarding-control-action', 'jump')
    expect(jump?.children[1]?.textContent).toBe('Space')
    const callbacks = mocks.createSettingsView.mock.calls.at(-1)?.[2]
    expect(callbacks).toBeDefined()
    callbacks?.onChange({
      ...DEFAULT_PLAYER_SETTINGS,
      bindings: { ...DEFAULT_PLAYER_SETTINGS.bindings, jump: 'KeyJ' },
    })
    expect(jump?.children[1]?.textContent).toBe('J')
  })
})

describe('title menu player settings persistence', () => {
  afterEach(() => {
    mocks.storage.layer = undefined
    vi.clearAllMocks()
  })

  const settingsWithJump = (jump: string): PlayerSettingsV1 => ({
    ...DEFAULT_PLAYER_SETTINGS,
    bindings: { ...DEFAULT_PLAYER_SETTINGS.bindings, jump },
  })

  it('warns in the settings dialog when the stored settings cannot be read, and leaves the record alone', async () => {
    const storage = Effect.runSync(makeInMemoryStorage)
    const unreadable = Result.getOrThrow(defineFormat({ name: PLAYER_SETTINGS_FORMAT_NAME, version: 2, schema: Schema.Unknown }))
    await Effect.runPromise(saveTo(unreadable, PLAYER_SETTINGS_KEY, { sensitivity: 99 }).pipe(
      Effect.provideService(StoragePort, storage),
    ))
    mocks.storage.layer = Layer.succeed(StoragePort, storage)
    const state = makeTitleMenuContext()

    await bootTitleMenu(state.context)

    const view = mocks.createSettingsView.mock.results.at(-1)?.value
    expect(view?.reportLoadFailure).toHaveBeenCalledOnce()
    const stored = await Effect.runPromise(Effect.flip(loadPlayerSettings()).pipe(
      Effect.provideService(StoragePort, storage),
    ))
    expect(stored._tag).toBe('SaveDecodeError')
    expect(state.context.enqueueSettingsWrite).not.toHaveBeenCalled()
  })

  it('restores the last saved settings when the latest write fails, never after an older failure', async () => {
    const state = makeTitleMenuContext()
    const settled: Array<{ readonly succeed: () => void; readonly fail: () => void }> = []
    state.context.enqueueSettingsWrite.mockImplementation((_queue, _write, onSuccess, onFailure) => {
      settled.push({ succeed: onSuccess, fail: () => onFailure(new Error('write failed')) })
    })
    await bootTitleMenu(state.context)
    const view = mocks.createSettingsView.mock.results.at(-1)?.value
    const callbacks = mocks.createSettingsView.mock.calls.at(-1)?.[2]
    const jump = state.titleScreen.find('data-onboarding-control-action', 'jump')
    const first = settingsWithJump('KeyJ')
    const second = settingsWithJump('KeyK')
    const third = settingsWithJump('KeyL')

    callbacks?.onChange(first)
    callbacks?.onChange(second)
    expect(view?.reportPersistenceSaving).toHaveBeenCalledTimes(2)
    settled[0]?.fail()
    expect(view?.replaceSettings).not.toHaveBeenCalled()
    expect(jump?.children[1]?.textContent).toBe('K')
    settled[1]?.succeed()
    expect(view?.reportStoredRecordReplaced).toHaveBeenCalledOnce()
    expect(view?.reportPersistenceSaved).toHaveBeenCalledOnce()
    expect(state.body.attributes.get('data-player-settings-persistence')).toBe('saved')

    callbacks?.onChange(third)
    expect(jump?.children[1]?.textContent).toBe('L')
    settled[2]?.fail()
    expect(view?.replaceSettings).toHaveBeenCalledExactlyOnceWith(second)
    expect(view?.reportPersistenceError).toHaveBeenLastCalledWith('Settings could not be saved.')
    expect(view?.reportPersistenceSaved).toHaveBeenCalledOnce()
    expect(state.body.attributes.get('data-player-settings-persistence')).toBe('error')
    expect(jump?.children[1]?.textContent).toBe('K')
  })

  it('drops the load warning once any write succeeds, even when a newer write then fails', async () => {
    const state = makeTitleMenuContext()
    const settled: Array<{ readonly succeed: () => void; readonly fail: () => void }> = []
    state.context.enqueueSettingsWrite.mockImplementation((_queue, _write, onSuccess, onFailure) => {
      settled.push({ succeed: onSuccess, fail: () => onFailure(new Error('write failed')) })
    })
    await bootTitleMenu(state.context)
    const view = mocks.createSettingsView.mock.results.at(-1)?.value
    const callbacks = mocks.createSettingsView.mock.calls.at(-1)?.[2]

    callbacks?.onChange(settingsWithJump('KeyJ'))
    callbacks?.onChange(settingsWithJump('KeyK'))
    settled[0]?.succeed()
    expect(view?.reportStoredRecordReplaced).toHaveBeenCalledOnce()
    expect(view?.reportPersistenceSaved).not.toHaveBeenCalled()
    settled[1]?.fail()
    expect(view?.reportStoredRecordReplaced).toHaveBeenCalledOnce()
    expect(view?.reportPersistenceError).toHaveBeenLastCalledWith('Settings could not be saved.')
  })
})

describe('player onboarding', () => {
  it('builds quick and complete controls in a fixed action order regardless of binding insertion order', () => {
    const bindings = Object.fromEntries(Object.entries(DEFAULT_PLAYER_SETTINGS.bindings).reverse())
    const hints = playerControlHints(bindings)
    expect(hints.quickControls.map(({ action }) => action)).toEqual([
      'moveForward', 'moveBackward', 'moveLeft', 'moveRight', 'jump', 'openInventory', 'attack', 'use', 'escape',
    ])
    expect(hints.allControls.map(({ action }) => action)).toEqual([
      'moveForward', 'moveBackward', 'moveLeft', 'moveRight', 'jump', 'sneak', 'sprint',
      'openInventory', 'openChat', 'attack', 'use', 'pickBlock',
      'hotbarSlot1', 'hotbarSlot2', 'hotbarSlot3', 'hotbarSlot4', 'hotbarSlot5',
      'hotbarSlot6', 'hotbarSlot7', 'hotbarSlot8', 'hotbarSlot9', 'escape',
    ])
    expect(hints.quickControls.at(-1)).toEqual({ action: 'escape', keys: 'Escape' })
    expect(hints.allControls.at(-1)).toBe(hints.quickControls.at(-1))
  })

  it('keeps an unbound action absent without substituting a default key', () => {
    const hints = playerControlHints({ jump: 'KeyJ' })
    expect(hints.quickControls).toEqual([{ action: 'jump', keys: 'KeyJ' }, { action: 'escape', keys: 'Escape' }])
    expect(hints.allControls).toEqual(hints.quickControls)
  })

  const quickControls = [{ action: InputAction('jump'), keys: KeyCode('KeyJ') }]
  const allControls = [...quickControls, { action: InputAction('openInventory'), keys: KeyCode('KeyI') }]
  const makeOnboarding = (storage: Pick<Storage, 'getItem' | 'setItem'>) => {
    const parent = new FakeElement()
    const onFailure = vi.fn()
    const installed = installPlayerOnboarding({
      document: { createElement: () => new FakeElement() },
      parent, getStorage: () => storage,
      getQuickControls: () => quickControls, getAllControls: () => allControls, onFailure,
    })
    return { parent, onFailure, installed }
  }

  it('remembers dismissal across mounts and can explicitly reopen the controls', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.has(key) ? values.get(key)! : null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const first = makeOnboarding(storage)
    expect(Result.isSuccess(first.installed)).toBe(true)
    first.parent.find('data-onboarding-action', 'PersistQuickControlsDismissal')?.click()
    expect(values.get('mc-host-web/quick-controls-dismissed')).toBe('true')
    const second = makeOnboarding(storage)
    const root = second.parent.find('data-mx-ui', 'onboarding')
    expect(root?.attributes.has('hidden')).toBe(true)
    Result.getOrThrow(second.installed).showControls()
    expect(root?.attributes.has('hidden')).toBe(false)
  })

  it('expands how-to-play to all current controls without dismissing or persisting', () => {
    const storage = { getItem: () => null, setItem: vi.fn() }
    const state = makeOnboarding(storage)
    expect(state.parent.find('data-onboarding-control-action', 'openInventory')).toBeUndefined()
    state.parent.find('data-onboarding-action', 'OpenHowToPlay')?.click()
    expect(state.parent.find('data-onboarding-control-action', 'openInventory')).toBeDefined()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('retains the controls after a failed dismissal write and persists a retry', () => {
    const cause = new Error('quota exceeded')
    const storage = { getItem: () => null, setItem: vi.fn().mockImplementationOnce(() => { throw cause }) }
    const state = makeOnboarding(storage)
    const dismiss = state.parent.find('data-onboarding-action', 'PersistQuickControlsDismissal')
    expect(dismiss).toBeDefined()
    dismiss?.click()
    expect(state.onFailure).toHaveBeenCalledExactlyOnceWith({ _tag: 'OnboardingPersistenceFailure', operation: 'write', cause })
    expect(state.parent.find('data-mx-ui', 'onboarding')?.attributes.has('hidden')).toBe(false)
    dismiss?.click()
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(state.parent.find('data-mx-ui', 'onboarding')?.attributes.has('hidden')).toBe(true)
  })

  it('returns malformed stored dismissal as a typed read failure', () => {
    const state = makeOnboarding({ getItem: () => 'false', setItem: vi.fn() })
    expect(state.installed).toEqual(Result.fail({ _tag: 'OnboardingPersistenceFailure', operation: 'read', cause: 'false' }))
    expect(state.parent.children).toHaveLength(0)
  })
})
