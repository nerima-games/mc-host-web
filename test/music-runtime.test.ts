import {
  AudioBackendPort,
  AudioVolume,
  decodeMusicScenePlaylistManifest,
  makeRecordingBackend,
  MinecraftSoundNamespace,
  parseMinecraftSoundsJson,
  type AudioBackend,
  type MinecraftAmbientSoundsDefinition,
  type MinecraftSoundRegistry,
  type MusicScene,
  type MusicScenePlaylistManifest,
  type RecordedBackend,
  type ToneHandle,
} from '@nerima-games/mc-audio'
import { MonotonicTimeSecs, PositionAxis, position, type Dimension, type Position } from '@nerima-games/mc-kernel'
import { INITIAL_TIME_STATE, type TimeState } from '@nerima-games/mc-sim'
import { Effect, Exit, Layer, Result } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  MAX_CATCH_UP_TICKS,
  makeMusicRuntime,
  resolveMusicScene,
  type MusicAmbientInput,
  type MusicFrameInput,
  type MusicSceneInput,
} from '../apps/web/music-runtime'

const at = (x: number, y: number, z: number): Position =>
  position(PositionAxis(x), PositionAxis(y), PositionAxis(z))

const SURFACE = at(0, 64, 0)
const UNDERGROUND = at(0, 10, 0)

// isNight is `fraction < 0.25 || fraction > 0.75` (mc-sim time-of-day.js), so
// tick 0 of a 24000-tick day is midnight and INITIAL_TIME_STATE (0.3) is day.
const DAY: TimeState = INITIAL_TIME_STATE
const NIGHT: TimeState = { ticks: 0, dayLengthTicks: 24_000 }

const sceneInput = (overrides: Partial<MusicSceneInput> = {}): MusicSceneInput => ({
  title: false,
  dimension: 'overworld',
  time: DAY,
  playerPosition: SURFACE,
  underwater: false,
  combat: false,
  creative: false,
  ...overrides,
})

type SceneCase = {
  readonly id: string
  readonly input: Partial<MusicSceneInput>
  readonly scene: MusicScene
}

const SCENE_CASES: ReadonlyArray<SceneCase> = [
  { id: 'title', input: { title: true }, scene: 'title' },
  { id: 'nether', input: { dimension: 'nether' }, scene: 'nether' },
  { id: 'end', input: { dimension: 'end' }, scene: 'end' },
  { id: 'combat', input: { combat: true }, scene: 'combat' },
  { id: 'underwater', input: { underwater: true }, scene: 'underwater' },
  { id: 'creative', input: { creative: true }, scene: 'creative' },
  { id: 'day', input: {}, scene: 'day' },
  { id: 'night', input: { time: NIGHT }, scene: 'night' },
  { id: 'cave', input: { playerPosition: UNDERGROUND }, scene: 'cave' },
]

describe('resolveMusicScene', () => {
  for (const sceneCase of SCENE_CASES) {
    it(`${sceneCase.id}: resolves to ${sceneCase.scene}`, () => {
      expect(resolveMusicScene(sceneInput(sceneCase.input))).toBe(sceneCase.scene)
    })
  }

  it('treats Y below 40 as cave and Y at 40 as surface (mc-audio DEFAULT_CAVE_THRESHOLD_Y)', () => {
    expect(resolveMusicScene(sceneInput({ playerPosition: at(0, 39.5, 0) }))).toBe('cave')
    expect(resolveMusicScene(sceneInput({ playerPosition: at(0, 40, 0) }))).toBe('day')
  })

  it('puts cave ahead of night when both hold', () => {
    expect(resolveMusicScene(sceneInput({ playerPosition: UNDERGROUND, time: NIGHT }))).toBe('cave')
  })

  const everything = {
    title: true,
    dimension: 'nether',
    combat: true,
    underwater: true,
    creative: true,
    time: NIGHT,
    playerPosition: UNDERGROUND,
  } satisfies Partial<MusicSceneInput>

  type PriorityCase = {
    readonly id: string
    readonly input: Partial<MusicSceneInput>
    readonly scene: MusicScene
  }
  const PRIORITY_CASES: ReadonlyArray<PriorityCase> = [
    { id: 'title beats nether and everything else', input: everything, scene: 'title' },
    { id: 'nether beats combat', input: { ...everything, title: false }, scene: 'nether' },
    { id: 'end beats combat', input: { ...everything, title: false, dimension: 'end' }, scene: 'end' },
    { id: 'combat beats underwater', input: { ...everything, title: false, dimension: 'overworld' }, scene: 'combat' },
    {
      id: 'underwater beats creative',
      input: { ...everything, title: false, dimension: 'overworld', combat: false },
      scene: 'underwater',
    },
    {
      id: 'creative beats cave and night',
      input: { ...everything, title: false, dimension: 'overworld', combat: false, underwater: false },
      scene: 'creative',
    },
  ]
  for (const priorityCase of PRIORITY_CASES) {
    it(priorityCase.id, () => {
      expect(resolveMusicScene(sceneInput(priorityCase.input))).toBe(priorityCase.scene)
    })
  }

  it('maps each dimension to its scene: overworld falls through to day', () => {
    const dimensions: ReadonlyArray<Dimension> = ['overworld', 'nether', 'end']
    expect(dimensions.map((dimension) => resolveMusicScene(sceneInput({ dimension })))).toEqual(['day', 'nether', 'end'])
  })
})

// ---------------------------------------------------------------------------
// Runtime harness: mc-audio's real recording backend and real music/ambient
// players; only the backend and the random source are fakes.
// ---------------------------------------------------------------------------

const unwrap = <Value, Failure>(result: Result.Result<Value, Failure>): Value => {
  if (Result.isFailure(result)) throw new Error(`unexpected failure: ${JSON.stringify(result.failure)}`)
  return result.success
}

const generatedAttribution = {
  type: 'generated',
  generatorScript: 'scripts/generate-placeholder-music.ts',
  licenseFile: 'LICENSES/placeholder.txt',
  licenseName: 'Creative Commons Zero v1.0',
  licenseSpdx: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
}

const CROSSFADE_TICKS = 10
const MIN_SILENCE_TICKS = 600
const MAX_SILENCE_TICKS = 1200

const playlistFor = (scene: string) => ({
  crossfadeTicks: CROSSFADE_TICKS,
  minimumSilenceTicks: MIN_SILENCE_TICKS,
  maximumSilenceTicks: MAX_SILENCE_TICKS,
  tracks: [{
    eventId: `mc-audio:music/${scene}`,
    file: `audio/music/${scene}.ogg`,
    attribution: generatedAttribution,
  }],
})

const manifestFor = (scenes: ReadonlyArray<MusicScene>): MusicScenePlaylistManifest =>
  unwrap(decodeMusicScenePlaylistManifest(Object.fromEntries(scenes.map((scene) => [scene, playlistFor(scene)]))))

const ALL_SCENES: ReadonlyArray<MusicScene> = SCENE_CASES.map((sceneCase) => sceneCase.scene)

const AMBIENT_LOOP = 'minecraft:ambient.test.loop'
const AMBIENT_MOOD = 'minecraft:ambient.test.mood'
const AMBIENT_ADDITION = 'minecraft:ambient.test.addition'

const ambientRegistry: MinecraftSoundRegistry = unwrap(parseMinecraftSoundsJson(
  {
    [AMBIENT_LOOP]: { sounds: ['ambient/loop'] },
    [AMBIENT_MOOD]: { sounds: ['ambient/mood'] },
    [AMBIENT_ADDITION]: { sounds: ['ambient/addition'] },
  },
  { namespace: MinecraftSoundNamespace('minecraft') },
))

// One loop (starts on the first ambient tick), a mood every 5 ticks, and an
// addition that fires when the random sample is below 0.5.
const AMBIENT_DEFINITION: MinecraftAmbientSoundsDefinition = {
  loop: AMBIENT_LOOP,
  mood: { sound: AMBIENT_MOOD, tick_delay: 5, block_search_extent: 4, offset: 0 },
  additions: [{ sound: AMBIENT_ADDITION, tick_chance: 0.5 }],
}

const ambientInput = (overrides: Partial<MusicAmbientInput> = {}): MusicAmbientInput => ({
  definition: AMBIENT_DEFINITION,
  listener: SURFACE,
  moodPosition: at(3, 0, 4),
  enabled: true,
  volume: AudioVolume(1),
  ...overrides,
})

const cycling = (values: ReadonlyArray<number>): (() => number) => {
  let index = 0
  return () => {
    const value = values[index % values.length] ?? 0
    index += 1
    return value
  }
}

type StopRecord = { readonly id: number; readonly fadeOutSecs: number | undefined }

type Harness = {
  readonly recording: RecordedBackend
  readonly stops: Array<StopRecord>
  readonly runtime: Effect.Success<ReturnType<typeof makeMusicRuntime>>
}

const harness = async (input: {
  readonly scenes: ReadonlyArray<MusicScene>
  readonly randomSource: () => unknown
}): Promise<Harness> => {
  const recording = await Effect.runPromise(makeRecordingBackend('ready'))
  const stops: Array<StopRecord> = []
  // Delegating spy: the recording backend still does the work; stopTone is only observed.
  const backend: AudioBackend = {
    ...recording.backend,
    stopTone: (handle: ToneHandle, fadeOutSecs) =>
      Effect.tap(
        recording.backend.stopTone(handle, fadeOutSecs),
        () => Effect.sync(() => void stops.push({ id: handle.id, fadeOutSecs })),
      ),
  }
  const runtime = await Effect.runPromise(
    makeMusicRuntime({
      scenePlaylists: manifestFor(input.scenes),
      ambientRegistry,
      randomSource: input.randomSource,
    }).pipe(Effect.provide(Layer.succeed(AudioBackendPort, backend))),
  )
  return { recording, stops, runtime }
}

const frame = (nowSecs: number, overrides: Partial<MusicFrameInput> = {}): MusicFrameInput => ({
  nowSecs: MonotonicTimeSecs(nowSecs),
  scene: sceneInput(),
  musicEnabled: true,
  musicVolume: AudioVolume(1),
  ambient: null,
  ...overrides,
})

// The music player waits MINECRAFT_MUSIC_STARTING_DELAY_TICKS (100) idle ticks
// (minecraft-music-planner.js initial state), decrementing once per tick, and
// starts on the 101st. The first update runs 1 tick (index 0) and each whole
// second after adds 20, so the update at 5 s has run 1 + 5 * 20 = 101 ticks.
const START_AT_SECS = 5

const driveUntilMusicStarts = async (h: Harness, overrides: Partial<MusicFrameInput> = {}) => {
  for (let secs = 0; secs < START_AT_SECS; secs += 1) {
    const early = await Effect.runPromise(h.runtime.update(frame(secs, overrides)))
    expect(early.music.every((tick) => !tick.played && tick.soundId === null)).toBe(true)
  }
  return await Effect.runPromise(h.runtime.update(frame(START_AT_SECS, overrides)))
}

describe('music runtime: scene to track', () => {
  it('has played nothing before the 101st tick and starts exactly then', async () => {
    const h = await harness({ scenes: ALL_SCENES, randomSource: () => 0 })

    for (let secs = 0; secs < START_AT_SECS; secs += 1) await Effect.runPromise(h.runtime.update(frame(secs)))
    expect(await Effect.runPromise(h.recording.musicPlayed)).toEqual([])

    const result = await Effect.runPromise(h.runtime.update(frame(START_AT_SECS)))

    expect(result.ticks).toBe(20)
    expect(result.music.map((tick) => tick.played)).toEqual([...Array.from({ length: 19 }, () => false), true])
    expect(await Effect.runPromise(h.recording.musicPlayed)).toHaveLength(1)
  })

  for (const sceneCase of SCENE_CASES) {
    it(`${sceneCase.id}: the started track belongs to the ${sceneCase.scene} playlist`, async () => {
      const h = await harness({ scenes: ALL_SCENES, randomSource: () => 0 })

      const result = await driveUntilMusicStarts(h, { scene: sceneInput(sceneCase.input) })

      expect(result.scene).toBe(sceneCase.scene)
      const last = result.music[result.music.length - 1]
      expect(last?.played).toBe(true)
      expect(last?.soundId).toBe(`mc-audio:music/${sceneCase.scene}`)
      const requests = await Effect.runPromise(h.recording.musicPlayed)
      expect(requests.map((request) => request.soundId)).toEqual([`audio/music/${sceneCase.scene}.ogg`])
      expect(requests[0]?.stream).toBe(true)
    })
  }

  it('stops the old track and starts the new scene track when the scene changes', async () => {
    const h = await harness({ scenes: ['day', 'combat'], randomSource: () => 0 })
    const started = await driveUntilMusicStarts(h)
    expect(started.music[started.music.length - 1]?.soundId).toBe('mc-audio:music/day')
    expect(h.stops).toEqual([])

    const changed = await Effect.runPromise(h.runtime.update(frame(START_AT_SECS + 0.1, {
      scene: sceneInput({ combat: true }),
    })))

    expect(changed.scene).toBe('combat')
    expect(changed.ticks).toBe(2)
    const [first, second] = changed.music
    expect(first?.plan.commands.map((command) => command.kind)).toEqual(['stop', 'start'])
    expect(first?.played).toBe(true)
    expect(first?.soundId).toBe('mc-audio:music/combat')
    expect(second?.plan.commands).toEqual([])
    const requests = await Effect.runPromise(h.recording.musicPlayed)
    expect(requests.map((request) => request.soundId)).toEqual(['audio/music/day.ogg', 'audio/music/combat.ogg'])
    // The new track fades in over the playlist crossfade while the old handle (id 1) fades out.
    expect(requests[1]?.fadeInSecs).toBe(CROSSFADE_TICKS / 20)
    expect(h.stops).toEqual([{ id: 1, fadeOutSecs: CROSSFADE_TICKS / 20 }])
  })

  it('does not restart a track while the scene is unchanged', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0 })
    await driveUntilMusicStarts(h)

    await Effect.runPromise(h.runtime.update(frame(START_AT_SECS + 1)))

    expect(await Effect.runPromise(h.recording.musicPlayed)).toHaveLength(1)
    expect(h.stops).toEqual([])
  })
})

describe('music runtime: missing playlist', () => {
  it('plays nothing and substitutes no default for a scene without a playlist', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0 })

    for (let secs = 0; secs <= 8; secs += 1) {
      const result = await Effect.runPromise(h.runtime.update(frame(secs, { scene: sceneInput({ combat: true }) })))
      expect(result.scene).toBe('combat')
      expect(result.music.every((tick) => tick.soundId === null && !tick.played)).toBe(true)
    }

    expect(await Effect.runPromise(h.recording.musicPlayed)).toEqual([])
    expect(await Effect.runPromise(h.recording.played)).toEqual([])
  })

  it('stops the running track when the new scene has no playlist and does not fall back to the old one', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0 })
    await driveUntilMusicStarts(h)

    const result = await Effect.runPromise(h.runtime.update(frame(START_AT_SECS + 0.05 + 0.05, {
      scene: sceneInput({ underwater: true }),
    })))

    expect(result.scene).toBe('underwater')
    expect(result.music[0]?.plan.commands).toEqual([{ kind: 'stop' }])
    expect(result.music.map((tick) => tick.soundId)).toEqual([null, null])
    expect(h.stops).toEqual([{ id: 1, fadeOutSecs: undefined }])
    expect(await Effect.runPromise(h.recording.musicPlayed)).toHaveLength(1)
  })
})

describe('music runtime: tick conversion', () => {
  const ticksFor = async (nowSecsSequence: ReadonlyArray<number>) => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0 })
    const ticks: Array<number> = []
    for (const nowSecs of nowSecsSequence) {
      ticks.push((await Effect.runPromise(h.runtime.update(frame(nowSecs)))).ticks)
    }
    return ticks
  }

  it('runs one tick on the first update, 0 for 0.04 s and 2 for 0.1 s', async () => {
    expect(await ticksFor([0, 0.04, 0.1])).toEqual([1, 0, 2])
  })

  it('floors partial ticks and carries them in the tick index, not in the remainder', async () => {
    // floor(0.09*20)=1, floor(0.19*20)=3, floor(0.2*20)=4
    expect(await ticksFor([0, 0.09, 0.19, 0.2])).toEqual([1, 1, 2, 1])
  })

  it('treats a first update at a large time as one tick, not a catch-up', async () => {
    expect(await ticksFor([1000])).toEqual([1])
  })

  it('caps a large gap at MAX_CATCH_UP_TICKS and resumes from the new index', async () => {
    expect(MAX_CATCH_UP_TICKS).toBe(20)
    expect(await ticksFor([0, 1000, 1000.05, 1000.1])).toEqual([1, 20, 1, 1])
  })

  it('runs exactly the capped number of ambient ticks against the backend', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0.75 })
    // The second update spans ticks 981..1000 (capped from a ~20000 tick gap);
    // the next mood is due at tick 5, so it fires at 981 and then every 5 ticks: 981, 986, 991, 996.
    await Effect.runPromise(h.runtime.update(frame(0, { musicEnabled: false, ambient: ambientInput() })))
    const before = (await Effect.runPromise(h.recording.played)).length

    await Effect.runPromise(h.runtime.update(frame(1000, { musicEnabled: false, ambient: ambientInput() })))

    const requests = await Effect.runPromise(h.recording.played)
    const moods = requests.slice(before).filter((request) => request.soundId === 'minecraft:ambient/mood')
    expect(moods).toHaveLength(4)
  })

  it('reports clock-regressed as a typed failure and keeps the runtime usable', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0 })
    await Effect.runPromise(h.runtime.update(frame(5)))

    const exit = await Effect.runPromiseExit(h.runtime.update(frame(1)))

    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? exit.cause.reasons.flatMap((reason) => reason._tag === 'Fail' ? [reason.error] : []) : []
    expect(failure).toEqual([{ _tag: 'MusicClockError', reason: 'clock-regressed', nowSecs: 1, lastTickIndex: 100 }])
    // The failed update consumed no ticks: the same index is still 0 ticks away.
    const next = await Effect.runPromise(h.runtime.update(frame(5)))
    expect(next.ticks).toBe(0)
  })

  it('accepts an equal index (same time twice) without regressing', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0 })
    await Effect.runPromise(h.runtime.update(frame(2)))

    const result = await Effect.runPromise(h.runtime.update(frame(2)))

    expect(result.ticks).toBe(0)
    expect(result.music).toEqual([])
    expect(result.ambientPlayed).toEqual([])
  })
})

describe('music runtime: ambient', () => {
  const NOW_SEQUENCE = [0, 0.5, 1.25, 2]

  const ambientRun = async (randomSource: () => number) => {
    const h = await harness({ scenes: ['day'], randomSource })
    const perUpdate: Array<ReadonlyArray<string>> = []
    for (const nowSecs of NOW_SEQUENCE) {
      const result = await Effect.runPromise(
        h.runtime.update(frame(nowSecs, { musicEnabled: false, ambient: ambientInput() })),
      )
      perUpdate.push(result.ambientPlayed)
    }
    return { perUpdate, played: await Effect.runPromise(h.recording.played) }
  }

  it('plans loop once, mood every 5 ticks, and additions from the random sample', async () => {
    // Ticks run: update 0 -> [0]; 0.5 -> [1..10]; 1.25 -> [11..25]; 2 -> [26..40].
    // mood fires at tick 0, 5, 10, 15, 20, 25, 30, 35, 40 (planner: tick >= nextMoodTick, +5).
    const { perUpdate, played } = await ambientRun(() => 0.25)

    const flat = perUpdate.flat()
    expect(flat.filter((sound) => sound === 'minecraft:ambient/loop')).toHaveLength(1)
    expect(perUpdate.map((sounds) => sounds.filter((sound) => sound === 'minecraft:ambient/mood').length)).toEqual([1, 2, 3, 3])
    // 0.25 < 0.5, so the addition plays on every one of the 41 ticks.
    expect(flat.filter((sound) => sound === 'minecraft:ambient/addition')).toHaveLength(41)
    expect(played).toHaveLength(flat.length)
    expect(played.filter((request) => request.loop === true).map((request) => request.soundId))
      .toEqual(['minecraft:ambient/loop'])
  })

  it('does not play the addition when the random sample is at or above its chance', async () => {
    const { perUpdate } = await ambientRun(() => 0.75)

    expect(perUpdate.flat().filter((sound) => sound === 'minecraft:ambient/addition')).toEqual([])
    expect(perUpdate.flat().filter((sound) => sound === 'minecraft:ambient/mood')).toHaveLength(9)
  })

  it('plays the same ambient sequence for the same times and random source', async () => {
    const first = await ambientRun(cycling([0.1, 0.9, 0.3, 0.6, 0.45]))
    const second = await ambientRun(cycling([0.1, 0.9, 0.3, 0.6, 0.45]))

    expect(first.perUpdate.flat().length).toBeGreaterThan(0)
    expect(second.perUpdate).toEqual(first.perUpdate)
    expect(second.played).toEqual(first.played)
  })

  it('changes the ambient plan when the random source changes', async () => {
    const low = await ambientRun(() => 0.25)
    const high = await ambientRun(() => 0.75)

    expect(low.perUpdate.flat().length).toBeGreaterThan(high.perUpdate.flat().length)
  })

  it('plays nothing when ambient is null (ambient player runs disabled)', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0.25 })

    for (const nowSecs of NOW_SEQUENCE) {
      const result = await Effect.runPromise(h.runtime.update(frame(nowSecs, { musicEnabled: false, ambient: null })))
      expect(result.ambientPlayed).toEqual([])
    }

    expect(await Effect.runPromise(h.recording.played)).toEqual([])
  })

  it('plays nothing when the ambient input is present but disabled', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0.25 })

    for (const nowSecs of NOW_SEQUENCE) {
      const result = await Effect.runPromise(h.runtime.update(frame(nowSecs, {
        musicEnabled: false,
        ambient: ambientInput({ enabled: false }),
      })))
      expect(result.ambientPlayed).toEqual([])
    }

    expect(await Effect.runPromise(h.recording.played)).toEqual([])
  })

  it('stops ambient when the input goes from a definition to null, then restarts the loop on return', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0.75 })
    const loops = async () =>
      (await Effect.runPromise(h.recording.played)).filter((request) => request.soundId === 'minecraft:ambient/loop').length

    await Effect.runPromise(h.runtime.update(frame(0, { musicEnabled: false, ambient: ambientInput() })))
    expect(await loops()).toBe(1)
    await Effect.runPromise(h.runtime.update(frame(0.05, { musicEnabled: false, ambient: null })))
    expect(h.stops).toEqual([{ id: 1, fadeOutSecs: undefined }])
    await Effect.runPromise(h.runtime.update(frame(0.1, { musicEnabled: false, ambient: ambientInput() })))

    expect(await loops()).toBe(2)
  })

  it('stop() silences the active music track', async () => {
    const h = await harness({ scenes: ['day'], randomSource: () => 0 })
    await driveUntilMusicStarts(h)

    await Effect.runPromise(h.runtime.stop)

    expect(h.stops).toEqual([{ id: 1, fadeOutSecs: undefined }])
  })
})
