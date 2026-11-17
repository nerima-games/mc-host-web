import {
  AudioTick,
  makeMinecraftAmbientSoundsPlayer,
  makeMinecraftMusicPlayer,
  musicScenePlaylistRegistry,
  resolveMusicEnvironment,
  type AudioBackendPort,
  type AudioVolume,
  type MinecraftAmbientSoundsDefinition,
  type MinecraftAmbientSoundsPlaybackError,
  type MinecraftMusicPlaybackError,
  type MinecraftMusicTickResult,
  type MinecraftSoundRegistry,
  type MinecraftSoundResourceId,
  type MusicScene,
  type MusicScenePlaylistManifest,
} from '@nerima-games/mc-audio'
import { type Dimension, type MonotonicTimeSecs, type Position } from '@nerima-games/mc-kernel'
import { isNight, type TimeState } from '@nerima-games/mc-sim'
import { type Brand, Effect, Result } from 'effect'

const GAME_TICKS_PER_SECOND = 20

// A hidden tab resumes after a long gap; replaying thousands of planner ticks
// would only fast-forward silence and delays, so at most this many run per update.
export const MAX_CATCH_UP_TICKS = 20

export type MusicSceneInput = {
  readonly title: boolean
  readonly dimension: Dimension
  readonly time: TimeState
  readonly playerPosition: Position
  readonly underwater: boolean
  readonly combat: boolean
  readonly creative: boolean
}

// mc-audio 0.6.0 has no scene-from-game-state function, so only the priority
// between scenes lives here; day/night/cave (including the underground Y
// threshold) is mc-audio's resolveMusicEnvironment and night is mc-sim's isNight.
export const resolveMusicScene = (input: MusicSceneInput): MusicScene => {
  if (input.title) return 'title'
  if (input.dimension === 'nether') return 'nether'
  if (input.dimension === 'end') return 'end'
  if (input.combat) return 'combat'
  if (input.underwater) return 'underwater'
  if (input.creative) return 'creative'
  return resolveMusicEnvironment({ playerPosition: input.playerPosition, isNight: isNight(input.time) })
}

export type MusicAmbientInput = {
  readonly definition: MinecraftAmbientSoundsDefinition
  readonly listener: Position
  readonly moodPosition?: Position
  readonly enabled: boolean
  readonly volume: AudioVolume
}

export type MusicFrameInput = {
  readonly nowSecs: MonotonicTimeSecs
  readonly scene: MusicSceneInput
  readonly musicEnabled: boolean
  readonly musicVolume: AudioVolume
  /** null: no ambient this frame, so the ambient player runs disabled. */
  readonly ambient: MusicAmbientInput | null
}

export type MusicFrameResult = {
  readonly scene: MusicScene
  readonly ticks: number
  readonly music: ReadonlyArray<MinecraftMusicTickResult>
  readonly ambientPlayed: ReadonlyArray<MinecraftSoundResourceId>
}

// MonotonicTimeSecs does not enforce monotonicity across calls, and a finite
// seconds value can still overflow the tick index; both are reported, not clamped.
export type MusicClockError =
  | {
    readonly _tag: 'MusicClockError'
    readonly reason: 'clock-regressed'
    readonly nowSecs: MonotonicTimeSecs
    readonly lastTickIndex: number
  }
  | {
    readonly _tag: 'MusicClockError'
    readonly reason: 'invalid-tick'
    readonly nowSecs: MonotonicTimeSecs
    readonly cause: Brand.BrandError
  }

export type MusicRuntimeError =
  | MinecraftMusicPlaybackError
  | MinecraftAmbientSoundsPlaybackError
  | MusicClockError

export type MusicRuntime = {
  readonly update: (frame: MusicFrameInput) => Effect.Effect<MusicFrameResult, MusicRuntimeError>
  readonly stop: Effect.Effect<void>
}

export const makeMusicRuntime = (input: {
  readonly scenePlaylists: MusicScenePlaylistManifest
  readonly ambientRegistry: MinecraftSoundRegistry
  readonly randomSource: () => unknown
}): Effect.Effect<MusicRuntime, never, AudioBackendPort> =>
  Effect.gen(function* () {
    const music = yield* makeMinecraftMusicPlayer(
      musicScenePlaylistRegistry(input.scenePlaylists),
      input.randomSource,
    )
    const ambient = yield* makeMinecraftAmbientSoundsPlayer(input.ambientRegistry, input.randomSource)
    let lastTickIndex: number | null = null

    const update = (frame: MusicFrameInput): Effect.Effect<MusicFrameResult, MusicRuntimeError> =>
      Effect.gen(function* () {
        const scene = resolveMusicScene(frame.scene)
        const index = Math.floor(frame.nowSecs * GAME_TICKS_PER_SECOND)
        if (lastTickIndex !== null && index < lastTickIndex) {
          return yield* Effect.fail<MusicClockError>({
            _tag: 'MusicClockError',
            reason: 'clock-regressed',
            nowSecs: frame.nowSecs,
            lastTickIndex,
          })
        }
        const ticks = lastTickIndex === null ? 1 : Math.min(index - lastTickIndex, MAX_CATCH_UP_TICKS)
        const musicResults: Array<MinecraftMusicTickResult> = []
        const ambientPlayed: Array<MinecraftSoundResourceId> = []
        for (let tickIndex = index - ticks + 1; tickIndex <= index; tickIndex += 1) {
          const tick = AudioTick.result(tickIndex)
          if (Result.isFailure(tick)) {
            return yield* Effect.fail<MusicClockError>({
              _tag: 'MusicClockError',
              reason: 'invalid-tick',
              nowSecs: frame.nowSecs,
              cause: tick.failure,
            })
          }
          // The index is consumed before playback so a failed tick is not
          // replayed by the next update.
          lastTickIndex = tickIndex
          musicResults.push(yield* music.tick({
            scene,
            scenePlaylists: input.scenePlaylists,
            context: { creative: frame.scene.creative, underwater: frame.scene.underwater },
            enabled: frame.musicEnabled,
            musicVolume: frame.musicVolume,
          }))
          const played = yield* frame.ambient === null
            ? ambient.tick({ tick: tick.success, enabled: false, listener: frame.scene.playerPosition })
            : ambient.tick({
              tick: tick.success,
              enabled: frame.ambient.enabled,
              definition: frame.ambient.definition,
              listener: frame.ambient.listener,
              ambientVolume: frame.ambient.volume,
              ...(frame.ambient.moodPosition === undefined ? {} : { moodPosition: frame.ambient.moodPosition }),
            })
          ambientPlayed.push(...played.playedSoundIds)
        }
        return { scene, ticks, music: musicResults, ambientPlayed }
      })

    return {
      update,
      stop: Effect.asVoid(Effect.all([music.stop, ambient.stop])),
    }
  })
