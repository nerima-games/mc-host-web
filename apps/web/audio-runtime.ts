import {
  makeAudioRuntime as makeEffectAudioRuntime,
  type AudioBackend,
  type AudioRuntimeSettings,
  type AudioRuntimeSnapshot,
  type CaptionEvent,
  type CuePlayOptions,
  type SoundCueId,
  type WebAudioBackend,
  type GameAudioHost,
} from '@nerima-games/mc-audio'
import { type ClockPort, type MonotonicTimeSecs, type Position } from '@nerima-games/mc-kernel'
import { Effect, type Layer } from 'effect'

export {
  captionRenderSignature,
  horizontalListenerForward,
  pruneExpiredCaptionEvents,
  type AudioRuntimeSettings,
  type AudioRuntimeSnapshot,
} from '@nerima-games/mc-audio'
export {
  announceConfirmedPlacements,
  announceInventoryTransition,
  makePlacementAudioLatch,
  type PlacementAudioLatch,
} from '@nerima-games/mx-gameplay'

type RuntimeBackend = AudioBackend & Pick<WebAudioBackend, 'unlock' | 'dispose' | 'preloadSamples'>

export type AudioRuntime = {
  readonly game: GameAudioHost
  readonly play: (cueId: SoundCueId, options?: CuePlayOptions) => void
  readonly unlock: () => void
  readonly visible: (nowSecs: MonotonicTimeSecs) => ReadonlyArray<CaptionEvent>
  readonly snapshot: (nowSecs: MonotonicTimeSecs) => AudioRuntimeSnapshot
  readonly configure: (settings: AudioRuntimeSettings) => void
  readonly close: () => void
}

// Browser callers drive audio from synchronous DOM and frame callbacks, so this
// adapter runs mc-audio's Effect runtime at that boundary. Backend defects stay
// contained as before: a cue request is still recorded when playback dies, and
// unlock/dispose rejections do not escape into the caller.
export const makeAudioRuntime = (input: {
  readonly backend: RuntimeBackend
  readonly clockLayer: Layer.Layer<ClockPort>
  readonly listener: () => Position
  readonly listenerForward?: () => Position
  readonly settings?: AudioRuntimeSettings
}): Effect.Effect<AudioRuntime> =>
  Effect.map(makeEffectAudioRuntime(input), (runtime) => ({
    game: runtime.game,
    play: (cueId, options) => {
      Effect.runSyncExit(runtime.play(cueId, options))
    },
    unlock: () => {
      void Effect.runPromise(runtime.unlock()).catch(() => undefined)
    },
    visible: (nowSecs) => Effect.runSync(runtime.visible(nowSecs)),
    snapshot: (nowSecs) => Effect.runSync(runtime.snapshot(nowSecs)),
    configure: (settings) => {
      Effect.runSyncExit(runtime.configure(settings))
    },
    close: () => {
      void Effect.runPromise(runtime.close()).catch(() => undefined)
    },
  }))
