import { Effect, Result, Schema } from 'effect'
import {
  PositionAxis,
  position as worldPosition,
  type CoordinateConversionFailure,
  type Position,
  type MonotonicTimeSecs,
} from '@nerima-games/mc-kernel'
import type { Vehicle } from '@nerima-games/mc-sim'
import type { Dimension } from '@nerima-games/mc-worldgen'
import { EntityRenderIdentifierSchema, type RenderEntity } from '@nerima-games/mc-render'
import type { AuthoritativeEntityState } from '@nerima-games/mx-multiplayer'
import type { RemotePlayer } from './multiplayer-client'
import type { PersistedVillager, SessionPosition } from './session-persistence'
import { makeQaSurface } from './qa-surface'
import type { TouchLookResetReason } from './touch-input'

// Projected entities originate from the session's registered entities and require stable, non-empty IDs.
const renderEntityId = Schema.decodeUnknownSync(EntityRenderIdentifierSchema)

type LocalEntityProjection = Readonly<{
  id: string
  kind: string
  feetPosition: Position
}>

// Runtime projectile and wither descriptors carry plain string ids; the projection
// decodes each one into the renderer's identifier like every other entity.
type RenderEntityDescriptor = Omit<RenderEntity, 'id'> & Readonly<{ id: string }>

export type PlayerSessionRuntimeContext = {
  readonly getCurrentDimension: () => Dimension
  readonly getLocalEntities: () => ReadonlyArray<LocalEntityProjection>
  readonly getAuthoritativeEntities: () => ReadonlyArray<readonly [string, AuthoritativeEntityState]>
  readonly getProjectileEntities: () => ReadonlyArray<RenderEntityDescriptor>
  readonly getEyeOfEnderEntities: () => ReadonlyArray<RenderEntityDescriptor>
  readonly getWitherEntities: () => ReadonlyArray<RenderEntityDescriptor>
  readonly getRemotePlayers: () => ReadonlyArray<readonly [string, RemotePlayer]>
  readonly getVillagerResidents: () => ReadonlyArray<PersistedVillager>
  readonly isCurrentChunkLoaded: (position: Position) => Result.Result<boolean, CoordinateConversionFailure>
  readonly getEndDragonPhase: () => string
  readonly getEndDragonPosition: () => RenderEntity['feetPosition']
  readonly getVehicles: () => ReadonlyArray<Vehicle>
  readonly syncEntities: (entities: ReadonlyArray<RenderEntity>) => Effect.Effect<void, Schema.SchemaError>
}

export type PlayerLifecycleContext = {
  readonly document: Pick<Document, 'addEventListener' | 'visibilityState'>
  readonly window: Pick<Window, 'setInterval' | 'addEventListener'>
  readonly autosaveIntervalMs: number
  readonly requestBackgroundFlush: () => void
  readonly resetTouchInput: (reason: TouchLookResetReason) => void
  readonly getStopBrowserPreview: () => (() => Promise<void>) | undefined
  readonly hasMultiplayer: () => boolean
  readonly leaveMultiplayer: () => void
  readonly settingsView: { readonly dispose: () => void }
  readonly endAudio: { readonly dispose: () => void }
  readonly weatherAudio: { readonly dispose: () => void }
  readonly clearPendingThunder: () => void
  readonly removeNativeMouseDown: () => void
  readonly disposeQaSurface: () => void
  readonly disposeWorldRenderer: () => void
  readonly disposeAtlasTexture: () => void
  readonly closeAudio: () => void
  readonly registerHotDispose: (callback: () => void) => void
}

export type PlayerSessionRuntime = {
  readonly entityRenderProjection: () => Result.Result<ReadonlyArray<RenderEntity>, CoordinateConversionFailure>
  readonly syncRenderedEntities: () => Effect.Effect<void, CoordinateConversionFailure | Schema.SchemaError>
  readonly nearestVillagerForTrade: (
    position: SessionPosition,
    dimension: Dimension,
  ) => PersistedVillager | undefined
}

export type PlayerLifecycleRuntime = {
  readonly disposeMultiplayer: () => void
  readonly disposeRuntime: () => void
}

export const createPlayerSessionRuntime = (
  context: PlayerSessionRuntimeContext,
): PlayerSessionRuntime => {
  const entityRenderProjection = (): Result.Result<ReadonlyArray<RenderEntity>, CoordinateConversionFailure> =>
    Result.gen(function* () {
      const loadedVillagers: Array<PersistedVillager> = []
      for (const villager of context.getVillagerResidents()) {
        if (villager.dimension !== context.getCurrentDimension()) continue
        const loaded = yield* context.isCurrentChunkLoaded(worldPosition(
          PositionAxis(villager.feetPosition.x),
          PositionAxis(villager.feetPosition.y),
          PositionAxis(villager.feetPosition.z),
        ))
        if (loaded) loadedVillagers.push(villager)
      }
      return [
        ...context.getLocalEntities().map((entity) => ({
          id: renderEntityId(entity.id),
          kind: entity.kind,
          feetPosition: entity.feetPosition,
          category: entity.kind === 'dropped_item' ? 'item' : 'hostile',
        } satisfies RenderEntity)),
        ...context.getAuthoritativeEntities().map(([, entity]) => ({
          id: renderEntityId(`authoritative:${String(entity.entityId)}`),
          kind: entity._tag === 'living'
            ? entity.entityType
            : entity._tag === 'vehicle'
              ? entity.vehicleType
              : entity._tag === 'arrow'
                ? 'arrow'
                : entity._tag === 'primed-tnt'
                  ? 'primed_tnt'
                  : 'dropped_item',
          feetPosition: entity.at,
          category: entity._tag === 'item-drop' || entity._tag === 'arrow' ? 'item' as const : 'hostile' as const,
        } satisfies RenderEntity)),
        ...context.getProjectileEntities().map((entity) => ({ ...entity, id: renderEntityId(entity.id) } satisfies RenderEntity)),
        ...context.getEyeOfEnderEntities().map((entity) => ({ ...entity, id: renderEntityId(entity.id) } satisfies RenderEntity)),
        ...context.getWitherEntities().map((entity) => ({ ...entity, id: renderEntityId(entity.id) } satisfies RenderEntity)),
        ...context.getRemotePlayers()
          .filter(([, player]) => player.world === context.getCurrentDimension())
          .map(([playerId, player]) => ({
            id: renderEntityId(`multiplayer:${String(playerId)}`),
            kind: 'remote_player',
            feetPosition: player.at,
          } satisfies RenderEntity)),
        ...loadedVillagers.map((villager) => ({
          id: renderEntityId(villager.id),
          kind: 'villager',
          feetPosition: villager.feetPosition,
        } satisfies RenderEntity)),
        ...(context.getCurrentDimension() === 'end' && context.getEndDragonPhase() !== 'dead'
          ? [{
              id: renderEntityId('ender-dragon'),
              kind: 'ender_dragon',
              category: 'hostile' as const,
              feetPosition: context.getEndDragonPosition(),
            } satisfies RenderEntity]
          : []),
        ...context.getVehicles()
          .filter((vehicle) => vehicle.dimension === context.getCurrentDimension())
          .map((vehicle) => ({
            id: renderEntityId(String(vehicle.id)),
            kind: vehicle.type,
            feetPosition: vehicle.position,
            facingRadians: vehicle.yawRadians,
          } satisfies RenderEntity)),
      ]
    })
  const syncRenderedEntities = (): Effect.Effect<void, CoordinateConversionFailure | Schema.SchemaError> =>
    Effect.flatMap(Effect.fromResult(entityRenderProjection()), context.syncEntities)
  const nearestVillagerForTrade = (
    position: SessionPosition,
    dimension: Dimension,
  ): PersistedVillager | undefined => {
    let nearest: PersistedVillager | undefined
    let nearestDistanceSquared = 16
    for (const villager of context.getVillagerResidents()) {
      if (villager.dimension !== dimension) continue
      const dx = villager.feetPosition.x - position.x
      const dy = villager.feetPosition.y - position.y
      const dz = villager.feetPosition.z - position.z
      const distanceSquared = dx * dx + dy * dy + dz * dz
      if (
        distanceSquared < nearestDistanceSquared
        || (distanceSquared === nearestDistanceSquared && villager.id < (nearest?.id ?? ''))
      ) {
        nearest = villager
        nearestDistanceSquared = distanceSquared
      }
    }
    return nearest
  }
  return { entityRenderProjection, syncRenderedEntities, nearestVillagerForTrade }
}

export const installPlayerQaSurface = (
  context: Parameters<typeof makeQaSurface>[0],
  failBoot: (title: string, reason: string) => void,
): boolean => {
  const result = makeQaSurface(context)
  if (result._tag === 'Failure') {
    failBoot('QA composition rejected', JSON.stringify(result.failure))
    return false
  }
  result.success.install()
  return true
}

export const installPlayerLifecycle = (context: PlayerLifecycleContext): PlayerLifecycleRuntime => {
  context.window.setInterval(context.requestBackgroundFlush, context.autosaveIntervalMs)
  let multiplayerDisposeStarted = false
  const disposeMultiplayer = (): void => {
    if (!context.hasMultiplayer() || multiplayerDisposeStarted) return
    multiplayerDisposeStarted = true
    context.leaveMultiplayer()
  }
  let runtimeDisposed = false
  const disposeRuntime = (): void => {
    if (runtimeDisposed) return
    runtimeDisposed = true
    context.disposeQaSurface()
    context.settingsView.dispose()
    context.endAudio.dispose()
    context.weatherAudio.dispose()
    context.clearPendingThunder()
    context.removeNativeMouseDown()
    context.disposeWorldRenderer()
    context.disposeAtlasTexture()
    context.closeAudio()
  }
  context.document.addEventListener('visibilitychange', () => {
    if (context.document.visibilityState === 'hidden') {
      context.resetTouchInput('visibility-hidden')
      context.requestBackgroundFlush()
    }
  })
  context.window.addEventListener('blur', () => context.resetTouchInput('blur'))
  // IndexedDB cannot be made synchronous during pagehide; this is best-effort.
  // Periodic publication persists advancing time and weather without gameplay mutations.
  context.window.addEventListener('pagehide', (event) => {
    context.requestBackgroundFlush()
    void context.getStopBrowserPreview()?.()
    disposeMultiplayer()
    if (!event.persisted) disposeRuntime()
  })
  context.registerHotDispose(() => {
    void context.getStopBrowserPreview()?.()
    disposeMultiplayer()
    disposeRuntime()
  })
  return { disposeMultiplayer, disposeRuntime }
}

export type PlayerFramePreparationContext<Frame> = {
  readonly makeRunFrame: () => Frame
  readonly readNow: () => MonotonicTimeSecs
}

export const createPlayerFramePreparation = <Frame>(
  context: PlayerFramePreparationContext<Frame>,
): Readonly<{ readonly runFrame: Frame; readonly readNow: () => MonotonicTimeSecs }> => ({
  runFrame: context.makeRunFrame(),
  readNow: context.readNow,
})
