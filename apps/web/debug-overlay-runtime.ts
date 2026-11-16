import {
  blockPositionOfPosition,
  chunkCoordOfBlock,
  DeltaTimeSecs,
  type CoordinateConversionFailure,
} from '@nerima-games/mc-kernel'
import {
  createDebugOverlayView,
  debugOverlayModel,
  FaultCountSchema,
  FramesPerSecondSchema,
  GpuTimeMillisecondsSchema,
  LoadedChunkCountSchema,
  type DebugOverlaySnapshot,
  type DomElement,
  type DomElementFactory,
  type DomNode,
} from '@nerima-games/mx-ui'
import { type Brand, Effect, Schema } from 'effect'

export type DebugOverlayRuntime<Error, Requirements> = Readonly<{
  root: DomElement
  setVisible: (visible: boolean) => void
  toggle: () => boolean
  update: (rawDeltaSecs: number | undefined) => Effect.Effect<
    void,
    Error | CoordinateConversionFailure | Brand.BrandError | Schema.SchemaError,
    Requirements
  >
  dispose: () => void
}>

export type DebugOverlayRuntimeState = Omit<
  DebugOverlaySnapshot,
  'frame' | 'chunk' | 'loadedChunkCount' | 'faultCount'
> & Readonly<{
  loadedChunkCount: number | undefined
  faultCount: number | undefined
}>

export const createDebugOverlayRuntime = <Error, Requirements>(
  factory: DomElementFactory,
  parent: DomElement & { removeChild(child: DomNode): unknown },
  readState: Effect.Effect<DebugOverlayRuntimeState, Error, Requirements>,
): DebugOverlayRuntime<Error, Requirements> => {
  const view = createDebugOverlayView(factory, parent)
  let visible = false

  const setVisible = (next: boolean): void => {
    visible = next
    if (visible) view.root.removeAttribute('hidden')
    else view.root.setAttribute('hidden', '')
  }

  const update = (rawDeltaSecs: number | undefined) => Effect.gen(function* () {
    if (!visible) return
    const state = yield* readState
    const camera = state.cameraPose
    const chunk = camera === undefined
      ? undefined
      : chunkCoordOfBlock(yield* Effect.fromResult(blockPositionOfPosition(camera.position)))
    const loadedChunkCount = state.loadedChunkCount === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(LoadedChunkCountSchema)(state.loadedChunkCount)
    const faultCount = state.faultCount === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(FaultCountSchema)(state.faultCount)
    const latestGpuTimeMs = state.latestGpuTimeMs === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(GpuTimeMillisecondsSchema)(state.latestGpuTimeMs)
    const snapshot: DebugOverlaySnapshot = {
      ...state,
      loadedChunkCount,
      faultCount,
      latestGpuTimeMs,
      frame: undefined,
      chunk: chunk === undefined ? undefined : { chunkX: chunk.cx, chunkZ: chunk.cz },
    }
    const model = debugOverlayModel(snapshot)
    const deltaSecs = rawDeltaSecs === undefined
      ? null
      : yield* Effect.fromResult(DeltaTimeSecs.result(rawDeltaSecs))
    const fps = deltaSecs === null || deltaSecs === 0
      ? null
      : yield* Schema.decodeUnknownEffect(FramesPerSecondSchema)(1 / deltaSecs)

    // Frame timing remains readable when the player owner has no camera pose.
    view.render({
      ...model,
      coordinates: camera === undefined ? null : {
        worldX: camera.position.x,
        worldY: camera.position.y,
        worldZ: camera.position.z,
      },
      frameDeltaSecs: deltaSecs,
      fps,
    })
  })

  return {
    root: view.root,
    setVisible,
    toggle: (): boolean => {
      setVisible(!visible)
      return visible
    },
    update,
    dispose: (): void => {
      setVisible(false)
      parent.removeChild(view.root)
    },
  }
}
