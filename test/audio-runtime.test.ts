import {
  AudioCaptionText,
  AudioCount,
  AudioVolume,
  makeRecordingBackend,
  SoundCueId,
  type AudioBackend,
  type WebAudioBackend,
} from '@nerima-games/mc-audio'
import {
  AngleRadians,
  EpochMillis,
  FixedClockLayer,
  MonotonicTimeSecs,
  PositionAxis,
  position,
  type ClockPort,
  type Position,
} from '@nerima-games/mc-kernel'
import { describe, expect, it } from 'vitest'
import { Effect, type Layer } from 'effect'

import {
  announceConfirmedPlacements,
  announceInventoryTransition,
  captionRenderSignature,
  horizontalListenerForward,
  makeAudioRuntime,
  makePlacementAudioLatch,
  pruneExpiredCaptionEvents,
} from '../apps/web/audio-runtime'

// A fixed reading is enough for every test below: none of them advance the
// clock mid-test, they just need a `ClockPort` in scope for
// `makeSoundCueService` (mc-audio 0.2.7 reads caption timestamps from it
// instead of taking a `nowSecs` effect directly).
const fixedClockLayer = (atSecs: number): Layer.Layer<ClockPort> =>
  FixedClockLayer({
    monotonicSecs: MonotonicTimeSecs(atSecs),
    wallClockEpochMillis: EpochMillis(0),
  })

const makeBackend = (
  backend: AudioBackend,
  lifecycle: { unlocks: number; closes: number },
): AudioBackend & Pick<WebAudioBackend, 'unlock' | 'dispose' | 'preloadSamples'> => ({
  ...backend,
  unlock: Effect.sync(() => {
    lifecycle.unlocks += 1
    return 'ready' as const
  }),
  preloadSamples: () =>
    Effect.succeed({ requested: AudioCount(0), loaded: AudioCount(0), cached: AudioCount(0), failed: AudioCount(0) }),
  dispose: Effect.sync(() => {
    lifecycle.closes += 1
  }),
})

const at = (x: number, y: number, z: number): Position =>
  position(PositionAxis(x), PositionAxis(y), PositionAxis(z))

const ORIGIN = at(0, 0, 0)

describe('web audio runtime', () => {
  it('derives the horizontal listener direction from camera yaw', () => {
    expect(horizontalListenerForward(AngleRadians(0))).toEqual({ x: -0, y: 0, z: -1 })
    expect(horizontalListenerForward(AngleRadians(Math.PI / 2)).x).toBeCloseTo(-1)
    expect(horizontalListenerForward(AngleRadians(-Math.PI / 2)).x).toBeCloseTo(1)
  })

  it('rotates world-space placement panning with the listener', async () => {
    const recording = await Effect.runPromise(makeRecordingBackend('ready'))
    let yawRadians = 0
    const runtime = await Effect.runPromise(
      makeAudioRuntime({
        backend: makeBackend(recording.backend, { unlocks: 0, closes: 0 }),
        clockLayer: fixedClockLayer(0),
        listener: () => ORIGIN,
        listenerForward: () => horizontalListenerForward(AngleRadians(yawRadians)),
      }),
    )

    runtime.play(SoundCueId('blockPlace'), { position: at(12, 0, 0) })
    yawRadians = Math.PI
    runtime.play(SoundCueId('blockPlace'), { position: at(12, 0, 0) })

    const played = await Effect.runPromise(recording.played)
    expect(played[0]?.pan).toBeCloseTo(1)
    expect(played[1]?.pan).toBeCloseTo(-1)
    expect(runtime.snapshot(MonotonicTimeSecs(0)).listenerForward).toEqual(horizontalListenerForward(AngleRadians(Math.PI)))
  })

  it('emits the damage caption while autoplay remains locked', async () => {
    const recording = await Effect.runPromise(makeRecordingBackend('locked'))
    const runtime = await Effect.runPromise(
      makeAudioRuntime({
        backend: makeBackend(recording.backend, { unlocks: 0, closes: 0 }),
        clockLayer: fixedClockLayer(12),
        listener: () => ORIGIN,
      }),
    )

    runtime.play(SoundCueId('playerHurt'))

    expect(runtime.visible(MonotonicTimeSecs(12))).toMatchObject([
      { cueId: 'playerHurt', atSecs: 12, reason: 'gate-blocked' },
    ])
    expect(await Effect.runPromise(recording.played)).toEqual([])
  })

  it('does not announce an inventory state that is already active', async () => {
    const recording = await Effect.runPromise(makeRecordingBackend('ready'))
    const runtime = await Effect.runPromise(
      makeAudioRuntime({
        backend: makeBackend(recording.backend, { unlocks: 0, closes: 0 }),
        clockLayer: fixedClockLayer(0),
        listener: () => ORIGIN,
      }),
    )

    expect(announceInventoryTransition(runtime, false, true)).toBe(true)
    expect(announceInventoryTransition(runtime, true, true)).toBe(false)
    expect(runtime.snapshot(MonotonicTimeSecs(0)).cueIds).toEqual(['inventoryOpen'])
  })

  it('applies volume and mute changes immediately', async () => {
    const recording = await Effect.runPromise(makeRecordingBackend('ready'))
    const runtime = await Effect.runPromise(
      makeAudioRuntime({
        backend: makeBackend(recording.backend, { unlocks: 0, closes: 0 }),
        clockLayer: fixedClockLayer(0),
        listener: () => ORIGIN,
      }),
    )

    runtime.configure({ masterVolume: AudioVolume(0.4), sfxVolume: AudioVolume(0.25), audioEnabled: true })
    runtime.play(SoundCueId('playerHurt'))
    runtime.configure({ masterVolume: AudioVolume(0.9), sfxVolume: AudioVolume(1), audioEnabled: false })
    runtime.play(SoundCueId('inventoryOpen'))

    expect(await Effect.runPromise(recording.masterGains)).toEqual([0.4, 0])
    expect((await Effect.runPromise(recording.played))[0]).toMatchObject({ gain: 0.125 })
    expect(await Effect.runPromise(recording.played)).toHaveLength(1)
  })

  it('announces placement only after the success outbox contains a result', async () => {
    const recording = await Effect.runPromise(makeRecordingBackend('ready'))
    const runtime = await Effect.runPromise(
      makeAudioRuntime({
        backend: makeBackend(recording.backend, { unlocks: 0, closes: 0 }),
        clockLayer: fixedClockLayer(0),
        listener: () => ORIGIN,
      }),
    )

    expect(announceConfirmedPlacements(runtime, [])).toBe(false)
    expect(runtime.snapshot(MonotonicTimeSecs(0)).cueIds).toEqual([])
    expect(announceConfirmedPlacements(runtime, ['oak_planks'])).toBe(true)
    expect(runtime.snapshot(MonotonicTimeSecs(0)).cueIds).toEqual(['blockPlace'])
  })

  it('clears an unconfirmed placement position before the next single in-flight request', () => {
    const plays: Array<{ cueId: string; position: Position | undefined }> = []
    const latch = makePlacementAudioLatch({
      play: (cueId, options) => plays.push({ cueId, position: options?.position }),
    })

    latch.request(at(4, 5, 6))
    latch.request()
    expect(latch.confirm([])).toBe(false)
    latch.request(at(-2, 1, 3))
    expect(latch.confirm(['stone'])).toBe(true)
    expect(latch.confirm(['stone'])).toBe(true)

    expect(plays).toEqual([
      { cueId: 'blockPlace', position: at(-2, 1, 3) },
      { cueId: 'blockPlace', position: undefined },
    ])
  })

  it('unlocks and closes at most once while their work is active', async () => {
    const recording = await Effect.runPromise(makeRecordingBackend('locked'))
    const lifecycle = { unlocks: 0, closes: 0 }
    const runtime = await Effect.runPromise(
      makeAudioRuntime({
        backend: makeBackend(recording.backend, lifecycle),
        clockLayer: fixedClockLayer(0),
        listener: () => ORIGIN,
      }),
    )

    runtime.unlock()
    runtime.unlock()
    runtime.close()
    runtime.close()
    await Promise.resolve()
    runtime.play(SoundCueId('playerHurt'))
    runtime.unlock()
    await Promise.resolve()

    expect(lifecycle).toEqual({ unlocks: 1, closes: 1 })
    expect(runtime.snapshot(MonotonicTimeSecs(0)).cueIds).toEqual([])
  })

  it('retries unlock after rejection and stops retrying after ready', async () => {
    const recording = await Effect.runPromise(makeRecordingBackend('locked'))
    const lifecycle = { unlocks: 0, closes: 0 }
    const backend = makeBackend(recording.backend, lifecycle)
    const runtime = await Effect.runPromise(
      makeAudioRuntime({
        backend: {
          ...backend,
          unlock: Effect.sync(() => {
            lifecycle.unlocks += 1
            if (lifecycle.unlocks === 1) throw new Error('unlock rejected')
            return 'ready' as const
          }),
        },
        clockLayer: fixedClockLayer(0),
        listener: () => ORIGIN,
      }),
    )

    // Three microtask hops per settle: the unlock promise chain gained a
    // preloadSamples link, so clearing unlockPending takes one hop more than
    // the pre-0.2.7 wiring this test was first calibrated against.
    runtime.unlock()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    runtime.unlock()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    runtime.unlock()
    await Promise.resolve()

    expect(lifecycle.unlocks).toBe(2)
  })

  it('uses all rendered caption fields in a stable signature', () => {
    const caption = {
      cueId: SoundCueId('playerHurt'),
      text: AudioCaptionText('Player hurt'),
      reason: 'gate-blocked' as const,
      atSecs: MonotonicTimeSecs(12),
    }

    expect(captionRenderSignature([caption])).toBe(captionRenderSignature([{ ...caption }]))
    expect(captionRenderSignature([caption])).not.toBe(
      captionRenderSignature([{ ...caption, atSecs: MonotonicTimeSecs(13) }]),
    )
    expect(captionRenderSignature([])).not.toBe(captionRenderSignature([caption]))
  })

  it('keeps the cue request when the audio backend defects', async () => {
    const recording = await Effect.runPromise(makeRecordingBackend('ready'))
    const runtime = await Effect.runPromise(
      makeAudioRuntime({
        backend: makeBackend({
          ...recording.backend,
          playTone: () => Effect.die(new Error('backend defect')),
        }, { unlocks: 0, closes: 0 }),
        clockLayer: fixedClockLayer(4),
        listener: () => ORIGIN,
      }),
    )

    expect(() => runtime.play(SoundCueId('playerHurt'))).not.toThrow()
    expect(runtime.snapshot(MonotonicTimeSecs(4)).cueIds).toEqual(['playerHurt'])
  })

  it('prunes only expired caption history across read times', () => {
    const captions = [
      { cueId: SoundCueId('playerHurt'), text: AudioCaptionText('Expired'), reason: 'audible' as const, atSecs: MonotonicTimeSecs(0) },
      { cueId: SoundCueId('inventoryOpen'), text: AudioCaptionText('Current'), reason: 'audible' as const, atSecs: MonotonicTimeSecs(2) },
      { cueId: SoundCueId('inventoryClose'), text: AudioCaptionText('Future'), reason: 'audible' as const, atSecs: MonotonicTimeSecs(8) },
    ]

    const atFour = pruneExpiredCaptionEvents(captions, MonotonicTimeSecs(4))
    expect(atFour.map((caption) => caption.text)).toEqual(['Current', 'Future'])
    expect(pruneExpiredCaptionEvents(atFour, MonotonicTimeSecs(8)).map((caption) => caption.text)).toEqual(['Future'])
  })
})
