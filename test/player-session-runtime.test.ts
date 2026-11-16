import { describe, expect, it, vi } from 'vitest'
import { Effect, Result, Schema } from 'effect'
import { PositionAxis, position } from '@nerima-games/mc-kernel'
import { VehicleSchema } from '@nerima-games/mc-sim'
import { LivingEntityState, PlayerName, WorldId } from '@nerima-games/mx-multiplayer'
import {
  createPlayerSessionRuntime,
  installPlayerLifecycle,
  type PlayerLifecycleContext,
  type PlayerSessionRuntimeContext,
} from '../apps/web/player-session-runtime'

vi.mock('../apps/web/session-persistence', () => ({ SESSION_FORMAT_VERSION: 3 }))

const point = (x: number, y: number, z: number) => position(PositionAxis(x), PositionAxis(y), PositionAxis(z))

const sessionContext = (overrides: Partial<PlayerSessionRuntimeContext> = {}): PlayerSessionRuntimeContext => ({
  getCurrentDimension: () => 'overworld',
  getLocalEntities: () => [],
  getAuthoritativeEntities: () => [],
  getProjectileEntities: () => [],
  getEyeOfEnderEntities: () => [],
  getWitherEntities: () => [],
  getRemotePlayers: () => [],
  getVillagerResidents: () => [],
  isCurrentChunkLoaded: () => Result.succeed(true),
  getEndDragonPhase: () => 'dead',
  getEndDragonPosition: () => point(0, 64, 0),
  getVehicles: () => [],
  syncEntities: () => Effect.void,
  ...overrides,
})

const lifecycleContext = () => {
  const documentEvents = new EventTarget()
  const windowEvents = new EventTarget()
  let visibilityState: DocumentVisibilityState = 'visible'
  const hotDisposeCallbacks: Array<() => void> = []
  const disposalOrder: Array<string> = []
  const context: PlayerLifecycleContext = {
    document: {
      get visibilityState() { return visibilityState },
      addEventListener: vi.fn<Document['addEventListener']>((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => documentEvents.addEventListener(type, listener, options)),
    },
    window: {
      setInterval: vi.fn<Window['setInterval']>(() => 1),
      addEventListener: vi.fn<Window['addEventListener']>((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => windowEvents.addEventListener(type, listener, options)),
    },
    autosaveIntervalMs: 1000,
    requestBackgroundFlush: vi.fn(),
    resetTouchInput: vi.fn(),
    getStopBrowserPreview: () => undefined,
    hasMultiplayer: () => true,
    leaveMultiplayer: vi.fn(),
    pauseMenu: { destroy: vi.fn(() => disposalOrder.push('pause')) },
    settingsView: { dispose: vi.fn(() => disposalOrder.push('settings')) },
    endAudio: { dispose: vi.fn() },
    weatherAudio: { dispose: vi.fn() },
    clearPendingThunder: vi.fn(),
    removeNativeMouseDown: vi.fn(),
    disposeQaSurface: vi.fn(() => disposalOrder.push('qa')),
    disposeWorldRenderer: vi.fn(() => disposalOrder.push('renderer')),
    disposeAtlasTexture: vi.fn(),
    closeAudio: vi.fn(),
    registerHotDispose: (callback) => hotDisposeCallbacks.push(callback),
  }
  return {
    context,
    documentEvents,
    windowEvents,
    hotDisposeCallbacks,
    disposalOrder,
    hideDocument: () => { visibilityState = 'hidden' },
  }
}

describe('player session runtime', () => {
  it('preserves entity projections and filters residents, peers, and vehicles by dimension', () => {
    const localPosition = point(1, 65, 2)
    const loadedPositions: Array<unknown> = []
    const synced: Array<unknown> = []
    const context = sessionContext({
      getLocalEntities: () => [{ id: 'item:1', kind: 'dropped_item', feetPosition: localPosition }],
      getAuthoritativeEntities: () => [['mob:1', Schema.decodeUnknownSync(LivingEntityState)({
        _tag: 'living', entityId: 'mob:1', entityType: 'zombie', health: 20, maxHealth: 20,
        at: { x: 3, y: 65, z: 4 },
      })]],
      getRemotePlayers: () => ['overworld', 'nether'].map((world) => [world, {
        name: Schema.decodeUnknownSync(PlayerName)(world),
        world: Schema.decodeUnknownSync(WorldId)(world),
        at: { x: 5, y: 65, z: 6 },
        facing: { yawRadians: 0, pitchRadians: 0 },
      }]),
      getVillagerResidents: () => [
        { id: 'villager:loaded', profession: 'farmer', dimension: 'overworld', feetPosition: { x: 7, y: 65, z: 8 } },
        { id: 'villager:unloaded', profession: 'farmer', dimension: 'overworld', feetPosition: { x: 70, y: 65, z: 8 } },
        { id: 'villager:nether', profession: 'farmer', dimension: 'nether', feetPosition: { x: 7, y: 65, z: 8 } },
      ],
      isCurrentChunkLoaded: (value) => { loadedPositions.push(value); return Result.succeed(value.x < 10) },
      getVehicles: () => ['overworld', 'nether'].map((dimension) => Schema.decodeUnknownSync(VehicleSchema)({
        id: `boat:${dimension}`, type: 'boat', dimension,
        position: { x: 9, y: 65, z: 10 }, velocity: { x: 0, y: 0, z: 0 }, yawRadians: 0.5,
      })),
      syncEntities: (entities) => Effect.sync(() => { synced.push(entities) }),
    })
    const runtime = createPlayerSessionRuntime(context)
    const projection = runtime.entityRenderProjection()
    if (Result.isFailure(projection)) throw new Error('entity projection failed')
    const projected = projection.success
    expect(projected).toEqual([
      { id: 'item:1', kind: 'dropped_item', feetPosition: localPosition, category: 'item' },
      { id: 'authoritative:mob:1', kind: 'zombie', feetPosition: { x: 3, y: 65, z: 4 }, category: 'hostile' },
      { id: 'multiplayer:overworld', kind: 'remote_player', feetPosition: { x: 5, y: 65, z: 6 } },
      { id: 'villager:loaded', kind: 'villager', feetPosition: { x: 7, y: 65, z: 8 } },
      { id: 'boat:overworld', kind: 'boat', feetPosition: { x: 9, y: 65, z: 10 }, facingRadians: 0.5 },
    ])
    expect(loadedPositions).toEqual([{ x: 7, y: 65, z: 8 }, { x: 70, y: 65, z: 8 }])
    Effect.runSync(runtime.syncRenderedEntities())
    expect(synced).toEqual([projected])
  })

  it('decodes runtime projectile descriptor ids into render identifiers', () => {
    const runtime = createPlayerSessionRuntime(sessionContext({
      getProjectileEntities: () => [{
        id: 'projectile:arrow-1', kind: 'arrow', category: 'item', feetPosition: { x: 1, y: 65, z: 2 }, facingRadians: 0.25,
      }],
      getEyeOfEnderEntities: () => [{
        id: 'projectile:eye-1', kind: 'eye_of_ender', category: 'item', feetPosition: { x: 3, y: 66, z: 4 }, facingRadians: 0.5,
      }],
    }))

    expect(runtime.entityRenderProjection()).toEqual(Result.succeed([
      { id: 'projectile:arrow-1', kind: 'arrow', category: 'item', feetPosition: { x: 1, y: 65, z: 2 }, facingRadians: 0.25 },
      { id: 'projectile:eye-1', kind: 'eye_of_ender', category: 'item', feetPosition: { x: 3, y: 66, z: 4 }, facingRadians: 0.5 },
    ]))
  })

  it('returns a chunk lookup failure from the entity sync without syncing', () => {
    const failure = { _tag: 'CoordinateConversionFailure', reason: 'block-axis-out-of-range', axis: 'x', kind: 'RangeError' } as const
    const synced: Array<unknown> = []
    const runtime = createPlayerSessionRuntime(sessionContext({
      getVillagerResidents: () => [
        { id: 'villager:far', profession: 'farmer', dimension: 'overworld', feetPosition: { x: 7, y: 65, z: 8 } },
      ],
      isCurrentChunkLoaded: () => Result.fail(failure),
      syncEntities: (entities) => Effect.sync(() => { synced.push(entities) }),
    }))

    expect(Effect.runSync(Effect.result(runtime.syncRenderedEntities()))).toEqual(Result.fail(failure))
    expect(synced).toEqual([])
  })

  it('retains the live end dragon projection and nearest-villager tie breaking', () => {
    const villagers = [
      { id: 'z', profession: 'farmer' as const, dimension: 'end' as const, feetPosition: { x: 1, y: 64, z: 0 } },
      { id: 'a', profession: 'farmer' as const, dimension: 'end' as const, feetPosition: { x: -1, y: 64, z: 0 } },
    ]
    const runtime = createPlayerSessionRuntime(sessionContext({
      getCurrentDimension: () => 'end',
      getEndDragonPhase: () => 'flying',
      getEndDragonPosition: () => point(10, 70, 10),
      getVillagerResidents: () => villagers,
    }))
    const projection = runtime.entityRenderProjection()
    if (Result.isFailure(projection)) throw new Error('entity projection failed')
    expect(projection.success.at(-1)).toEqual({
      id: 'ender-dragon', kind: 'ender_dragon', category: 'hostile', feetPosition: { x: 10, y: 70, z: 10 },
    })
    expect(runtime.nearestVillagerForTrade({ x: 0, y: 64, z: 0 }, 'end')).toBe(villagers[1])
    expect(runtime.nearestVillagerForTrade({ x: 0, y: 64, z: 0 }, 'overworld')).toBeUndefined()
  })

  it('releases QA before session resources exactly once across dispose and HMR', () => {
    const harness = lifecycleContext()
    const runtime = installPlayerLifecycle(harness.context)
    runtime.disposeRuntime()
    runtime.disposeRuntime()
    for (const callback of harness.hotDisposeCallbacks) callback()
    expect(harness.context.disposeQaSurface).toHaveBeenCalledTimes(1)
    expect(harness.context.disposeWorldRenderer).toHaveBeenCalledTimes(1)
    expect(harness.disposalOrder).toEqual(['qa', 'pause', 'settings', 'renderer'])
    expect(harness.context.leaveMultiplayer).toHaveBeenCalledTimes(1)
  })

  it('retains QA for persisted pagehide and releases it for final pagehide', () => {
    const harness = lifecycleContext()
    installPlayerLifecycle(harness.context)
    const persistedPagehide = new Event('pagehide')
    Object.defineProperty(persistedPagehide, 'persisted', { value: true })
    harness.windowEvents.dispatchEvent(persistedPagehide)
    expect(harness.context.disposeQaSurface).not.toHaveBeenCalled()
    const finalPagehide = new Event('pagehide')
    Object.defineProperty(finalPagehide, 'persisted', { value: false })
    harness.windowEvents.dispatchEvent(finalPagehide)
    harness.windowEvents.dispatchEvent(finalPagehide)
    expect(harness.context.disposeQaSurface).toHaveBeenCalledTimes(1)
    expect(harness.context.leaveMultiplayer).toHaveBeenCalledTimes(1)
    expect(harness.context.requestBackgroundFlush).toHaveBeenCalledTimes(3)
    harness.hideDocument()
    harness.documentEvents.dispatchEvent(new Event('visibilitychange'))
    harness.windowEvents.dispatchEvent(new Event('blur'))
    expect(harness.context.resetTouchInput).toHaveBeenCalledWith('visibility-hidden')
    expect(harness.context.resetTouchInput).toHaveBeenCalledWith('blur')
  })
})
