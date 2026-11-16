import { Array as Arr, Effect, Layer, Result, Scope } from 'effect'
import { InputAction, KeyCode, WorldId } from '@nerima-games/mc-kernel'
import { IndexedDbDatabaseName, indexedDbStorageLayer } from '@nerima-games/mc-save'
import {
  createMainMenuView,
  createOnboardingView,
  decodeWorldNameText,
  initialMainMenuState,
  mainMenuViewModel,
  onboardingViewModel,
  type CreateWorldRequest,
  type MainMenuState,
  type SavedWorld,
  type DomElement,
  type DomElementFactory,
  type QuickControlHint,
} from '@nerima-games/mx-ui'

import { validateMultiplayerUrl } from './multiplayer-url'
import {
  PLAYER_BINDING_ACTIONS,
  initialPlayerSettingsWrites,
  loadPlayerSettingsForSession,
  playerSettingsWriteFailed,
  playerSettingsWriteSucceeded,
  queuePlayerSettingsWrite,
  savePlayerSettings,
  type PlayerSettingsV1,
} from './settings'
import { createSettingsView } from './settings-view'
import { listSessions } from './session-persistence'
import { createSessionHref, createUniqueSessionId, sessionHref } from './session-navigation'
import {
  DATABASE_NAME,
  MISSING_SESSION_ERROR,
  makeSettingsWriteQueue,
  type SettingsWriteQueue,
} from './platform-adapters'

const QUICK_CONTROLS_DISMISSED_KEY = 'mc-host-web/quick-controls-dismissed'
const QUICK_CONTROL_ACTIONS = new Set(['moveForward', 'moveBackward', 'moveLeft', 'moveRight', 'jump', 'openInventory', 'attack', 'use', 'escape'])

export const playerControlHints = (bindings: PlayerSettingsV1['bindings']): {
  readonly quickControls: ReadonlyArray<QuickControlHint>
  readonly allControls: ReadonlyArray<QuickControlHint>
} => {
  // The action list is fixed; bound input codes have already passed settings validation.
  const allControls = PLAYER_BINDING_ACTIONS.flatMap((action): Array<QuickControlHint> => {
    const keys = bindings[action]
    return keys === undefined ? [] : [{ action: InputAction(action), keys: KeyCode(keys) }]
  }).concat({ action: InputAction('escape'), keys: KeyCode('Escape') })
  return { quickControls: allControls.filter(({ action }) => QUICK_CONTROL_ACTIONS.has(action)), allControls }
}

export type OnboardingPersistenceFailure = {
  readonly _tag: 'OnboardingPersistenceFailure'
  readonly operation: 'read' | 'write'
  readonly cause: unknown
}

export const onboardingFailureMessage = (failure: OnboardingPersistenceFailure): string =>
  failure.operation === 'read'
    ? 'Controls preferences could not be loaded.'
    : 'Controls could not be saved. Please try again.'

export const installPlayerOnboarding = (context: {
  readonly document: DomElementFactory
  readonly parent: DomElement
  readonly getStorage: () => Pick<Storage, 'getItem' | 'setItem'>
  readonly getQuickControls: () => ReadonlyArray<QuickControlHint>
  readonly getAllControls: () => ReadonlyArray<QuickControlHint>
  readonly onFailure: (failure: OnboardingPersistenceFailure) => void
}): Result.Result<{ readonly showControls: () => void; readonly render: () => void }, OnboardingPersistenceFailure> => {
  const loaded = Result.try({
    try: () => {
      const storage = context.getStorage()
      return { storage, stored: storage.getItem(QUICK_CONTROLS_DISMISSED_KEY) }
    },
    catch: (cause): OnboardingPersistenceFailure => ({ _tag: 'OnboardingPersistenceFailure', operation: 'read', cause }),
  })
  if (Result.isFailure(loaded)) return Result.fail(loaded.failure)
  const { storage, stored } = loaded.success
  if (stored !== null && stored !== 'true') {
    return Result.fail({ _tag: 'OnboardingPersistenceFailure', operation: 'read', cause: stored })
  }
  let dismissed = stored === 'true'
  let expanded = false
  const render = (): void => view.render(onboardingViewModel({
    firstRun: true,
    quickControlsDismissed: dismissed,
    quickControls: expanded ? context.getAllControls() : context.getQuickControls(),
  }))
  const view = createOnboardingView(context.document, context.parent, {
    onIntent: (intent) => {
      if (intent._tag === 'OpenHowToPlay') {
        expanded = true
        render()
        return
      }
      const saved = Result.try({
        try: () => storage.setItem(QUICK_CONTROLS_DISMISSED_KEY, 'true'),
        catch: (cause): OnboardingPersistenceFailure => ({ _tag: 'OnboardingPersistenceFailure', operation: 'write', cause }),
      })
      if (Result.isFailure(saved)) {
        context.onFailure(saved.failure)
        return
      }
      dismissed = true
      render()
    },
  })
  render()
  return Result.succeed({ showControls: () => { dismissed = false; render() }, render })
}

export type TitleMenuContext = {
  readonly document: Document
  readonly window: Window & typeof globalThis
  readonly indexedDB: IDBFactory
  readonly crypto: Pick<Crypto, 'randomUUID'>
  readonly requireElement: (id: string) => HTMLElement
  readonly enqueueSettingsWrite: (
    queue: SettingsWriteQueue,
    write: () => Promise<void>,
    onSuccess: () => void,
    onFailure: (error: unknown) => void,
  ) => void
  readonly drainSettingsWrites: (queue: SettingsWriteQueue) => Promise<void>
  readonly multiplayerRegistrationTokenKey: (
    url: string,
    worldId: string,
    player: string,
  ) => string
  readonly hot: { readonly dispose: (handler: () => void) => void } | undefined
}

export const bootTitleMenu = async (context: TitleMenuContext): Promise<void> => {
  const {
    document,
    window,
    indexedDB,
    crypto,
    requireElement,
    enqueueSettingsWrite,
    drainSettingsWrites,
    multiplayerRegistrationTokenKey,
    hot,
  } = context
  const titleScreen = requireElement('title-screen')
  const menuParent = requireElement('main-menu-root')
  const titleStatus = requireElement('title-status')
  const settingsRoot = requireElement('settings-root')
  const multiplayerJoin = requireElement('multiplayer-join')
  const multiplayerWorld = requireElement('multiplayer-world')
  const multiplayerName = requireElement('multiplayer-name')
  const multiplayerPlayer = requireElement('multiplayer-player')
  const multiplayerUrl = requireElement('multiplayer-url')
  const multiplayerRegistrationToken = requireElement('multiplayer-registration-token')
  const multiplayerJoinButton = requireElement('multiplayer-join-button')
  if (!(multiplayerJoin instanceof window.HTMLFormElement)
    || !(multiplayerWorld instanceof window.HTMLSelectElement)
    || !(multiplayerName instanceof window.HTMLInputElement)
    || !(multiplayerPlayer instanceof window.HTMLInputElement)
    || !(multiplayerUrl instanceof window.HTMLInputElement)
    || !(multiplayerRegistrationToken instanceof window.HTMLInputElement)
    || !(multiplayerJoinButton instanceof window.HTMLButtonElement)) {
    throw new Error('index.html has invalid multiplayer join controls')
  }
  titleScreen.hidden = false
  document.body.setAttribute('data-mc-compose-route', 'title')
  if (new URLSearchParams(window.location.search).get('loadError') === 'missing-session') {
    titleStatus.textContent = MISSING_SESSION_ERROR
  }

  // DATABASE_NAME is a non-empty literal, the only IndexedDbDatabaseName requirement.
  const databaseName = IndexedDbDatabaseName(DATABASE_NAME)
  const scope = Effect.runSync(Scope.make())
  const storageContext = await Effect.runPromise(
    Effect.provideService(
      Layer.build(indexedDbStorageLayer({ factory: indexedDB, databaseName })),
      Scope.Scope,
      scope,
    ),
  )
  const sessions = await Effect.runPromise(Effect.provide(listSessions(), storageContext))
  const playerSettingsLoad = await Effect.runPromise(
    Effect.provide(loadPlayerSettingsForSession(), storageContext),
  )
  let playerSettingsWrites = initialPlayerSettingsWrites(playerSettingsLoad.settings)
  const settingsWrites = makeSettingsWriteQueue()
  let settingsView: ReturnType<typeof createSettingsView>
  const persistPlayerSettings = (next: PlayerSettingsV1): void => {
    playerSettingsWrites = queuePlayerSettingsWrite(playerSettingsWrites, next)
    document.body.setAttribute('data-player-settings-persistence', 'dirty')
    settingsView.clearPersistenceError()
    settingsView.reportPersistenceSaving()
    enqueueSettingsWrite(
      settingsWrites,
      () => Effect.runPromise(Effect.provide(savePlayerSettings(next), storageContext)),
      () => {
        const settled = playerSettingsWriteSucceeded(playerSettingsWrites, next)
        playerSettingsWrites = settled.writes
        if (settled.latest) {
          document.body.setAttribute('data-player-settings-persistence', 'saved')
          settingsView.reportPersistenceSaved()
        }
      },
      (error) => {
        const settled = playerSettingsWriteFailed(playerSettingsWrites, next)
        playerSettingsWrites = settled.writes
        if (settled.latest) {
          settingsView.replaceSettings(settled.writes.applied)
          if (Result.isSuccess(onboarding)) onboarding.success.render()
        }
        document.body.setAttribute('data-player-settings-persistence', 'error')
        const message = 'Settings could not be saved.'
        titleStatus.textContent = message
        settingsView.reportPersistenceError(message)
        console.error('[mc-compose] player settings persistence failed', error)
      },
    )
  }
  // Stored heads only guarantee a non-empty session id, while WorldId also rejects
  // blank ids. Such a session cannot be opened through sessionHref either, so it is
  // left out of the list and reported rather than shown under a substituted id.
  const [savedWorlds, invalidSessionIds] = Arr.partition(sessions, ({ sessionId, metadata }) =>
    Result.map(WorldId.result(sessionId), (worldId): SavedWorld => ({
      sessionId: worldId,
      // WorldNameTextSchema is an unchecked string brand, so decoding a string cannot fail.
      name: Result.getOrThrow(decodeWorldNameText(metadata.name)),
    })))
  for (const failure of invalidSessionIds) {
    console.error('[mc-compose] saved session has an invalid world id', failure)
  }
  multiplayerWorld.replaceChildren(...savedWorlds.map(({ sessionId, name }) => {
    const option = document.createElement('option')
    option.value = sessionId
    option.textContent = name
    return option
  }))
  multiplayerPlayer.value = `player-${crypto.randomUUID().slice(0, 8)}`
  multiplayerJoinButton.disabled = savedWorlds.length === 0
  const existingIds = savedWorlds.map(({ sessionId }) => sessionId)
  let menuState: MainMenuState = initialMainMenuState
  let menuView: ReturnType<typeof createMainMenuView>
  const onboardingParent = document.createElement('div')
  titleScreen.appendChild(onboardingParent)
  const reportOnboardingFailure = (failure: OnboardingPersistenceFailure): void => {
    titleStatus.textContent = onboardingFailureMessage(failure)
    console.error('[mc-compose] controls persistence failed', failure)
  }
  const onboarding = installPlayerOnboarding({
    document,
    parent: onboardingParent,
    getStorage: () => window.localStorage,
    getQuickControls: () => playerControlHints(playerSettingsWrites.applied.bindings).quickControls,
    getAllControls: () => playerControlHints(playerSettingsWrites.applied.bindings).allControls,
    onFailure: reportOnboardingFailure,
  })
  if (Result.isFailure(onboarding)) {
    reportOnboardingFailure(onboarding.failure)
  } else {
    const controlsButton = document.createElement('button')
    controlsButton.setAttribute('type', 'button')
    controlsButton.setAttribute('data-title-action', 'show-controls')
    controlsButton.textContent = 'Controls'
    controlsButton.addEventListener('click', () => onboarding.success.showControls())
    titleScreen.appendChild(controlsButton)
  }
  settingsView = createSettingsView(document, settingsRoot, {
    onChange: (next) => {
      persistPlayerSettings(next)
      if (Result.isSuccess(onboarding)) onboarding.success.render()
    },
    onClose: () => {
      titleScreen.inert = false
    },
  })
  if (playerSettingsLoad.failure !== undefined) {
    settingsView.reportLoadFailure()
    console.error('[mc-compose] player settings could not be read', playerSettingsLoad.failure)
  }

  let titleNavigationPending = false
  const setTitleNavigationPending = (pending: boolean): void => {
    titleNavigationPending = pending
    if (pending) menuParent.setAttribute('aria-busy', 'true')
    else menuParent.removeAttribute('aria-busy')
    for (const control of menuParent.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) {
      control.disabled = pending
    }
  }

  const navigateAfterSettingsSaved = async (href: string): Promise<void> => {
    if (titleNavigationPending) return
    setTitleNavigationPending(true)
    try {
      await drainSettingsWrites(settingsWrites)
      window.location.assign(href)
    } catch (error: unknown) {
      setTitleNavigationPending(false)
      titleStatus.textContent = 'Could not finish saving settings. Please try again.'
      console.error('[mc-compose] navigation blocked by settings persistence failure', error)
    }
  }
  const openSession = async (sessionId: string): Promise<void> => {
    await navigateAfterSettingsSaved(sessionHref(sessionId))
  }
  multiplayerJoin.addEventListener('submit', (event) => {
    event.preventDefault()
    if (titleNavigationPending || !multiplayerJoin.reportValidity()) return
    const player = multiplayerPlayer.value.trim()
    const name = multiplayerName.value.trim()
    if (player.length === 0 || name.length === 0) {
      titleStatus.textContent = 'Player name and ID cannot be blank.'
      return
    }
    const validation = validateMultiplayerUrl(multiplayerUrl.value, window.location.href)
    if (!validation.ok) {
      titleStatus.textContent = validation.message
      return
    }
    const href = new URL(sessionHref(multiplayerWorld.value), window.location.origin)
    href.searchParams.set('multiplayer', validation.url.href)
    href.searchParams.set('player', player)
    href.searchParams.set('multiplayerName', name)
    const registrationToken = multiplayerRegistrationToken.value
    try {
      const registrationTokenKey = multiplayerRegistrationTokenKey(
        validation.url.href,
        multiplayerWorld.value,
        player,
      )
      if (registrationToken.length > 0) {
        window.sessionStorage.setItem(
          registrationTokenKey,
          registrationToken,
        )
      } else {
        window.sessionStorage.removeItem(registrationTokenKey)
      }
    } catch (error: unknown) {
      titleStatus.textContent = 'Legacy registration token could not be stored for navigation.'
      console.error('[mc-compose] multiplayer registration token storage failed', error)
      return
    }
    void navigateAfterSettingsSaved(`${href.pathname}${href.search}`)
  })
  const createWorld = async ({ name, mode }: CreateWorldRequest): Promise<void> => {
    titleStatus.textContent = ''
    const sessionId = createUniqueSessionId(name, existingIds)
    await navigateAfterSettingsSaved(createSessionHref(sessionId, { name, mode }))
  }

  menuView = createMainMenuView(document, menuParent, {
    onStateChange: (state) => {
      menuState = state
      menuView.render(mainMenuViewModel(menuState, savedWorlds))
    },
    onCreateWorld: (request) => {
      void createWorld(request)
    },
    onLoadWorld: ({ sessionId }) => {
      void openSession(sessionId)
    },
    onOpenSettings: () => {
      const returnFocus = document.activeElement instanceof window.HTMLElement
        ? document.activeElement
        : menuParent
      titleStatus.textContent = ''
      titleScreen.inert = true
      settingsView.open(playerSettingsWrites.applied, returnFocus)
    },
  })
  menuView.render(mainMenuViewModel(menuState, savedWorlds))
  const handleTitlePageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) settingsView.dispose()
  }
  window.addEventListener('pagehide', handleTitlePageHide)
  hot?.dispose(() => {
    window.removeEventListener('pagehide', handleTitlePageHide)
    settingsView.dispose()
  })
  document.body.setAttribute('data-mc-compose-boot', 'running')
}
