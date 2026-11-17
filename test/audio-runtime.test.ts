import {
  AudioCaptionText,
  AudioCount,
  AudioVolume,
  makeRecordingBackend,
  SoundCueId,
  type AudioBackend,
  type AudioEvent,
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
import { Effect, type Layer, Result } from 'effect'

import {
  announceConfirmedPlacements,
  announceInventoryTransition,
  captionRenderSignature,
  horizontalListenerForward,
  makeAudioRuntime,
  makePlacementAudioLatch,
  playAudioEvent,
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

const freshRuntime = async (atSecs: number, wrap?: (backend: AudioBackend) => AudioBackend) => {
  const recording = await Effect.runPromise(makeRecordingBackend('ready'))
  const runtime = await Effect.runPromise(
    makeAudioRuntime({
      backend: makeBackend(wrap === undefined ? recording.backend : wrap(recording.backend), { unlocks: 0, closes: 0 }),
      clockLayer: fixedClockLayer(atSecs),
      listener: () => ORIGIN,
    }),
  )
  return { recording, runtime }
}

type EventCase = {
  readonly id: string
  readonly event: AudioEvent
  readonly cueId: string
  readonly caption: string
}

// Expected cue ids and caption strings come from mc-audio's cue-definitions
// (dist/data/cue-definitions.js) and audio-event-map.js, not from the code under test.
const EVENT_CASES: ReadonlyArray<EventCase> = [
  { id: 'mining-stone', event: { kind: 'mining', blockType: 'stone' }, cueId: 'blockBreak', caption: 'Block breaks' },
  { id: 'place-oak-planks', event: { kind: 'place', blockType: 'oak_planks' }, cueId: 'blockPlace', caption: 'Block placed' },
  { id: 'pickup', event: { kind: 'pickup' }, cueId: 'itemPickup', caption: 'Item picked up' },
  { id: 'attack', event: { kind: 'attack' }, cueId: 'entityHit', caption: 'Attack lands' },
  { id: 'hurt-player', event: { kind: 'hurt', target: 'player' }, cueId: 'playerHurt', caption: 'You were hurt' },
  { id: 'hurt-mob', event: { kind: 'hurt', target: 'mob' }, cueId: 'mobHurt', caption: 'Mob hurts' },
  { id: 'mob-death', event: { kind: 'mobDeath' }, cueId: 'mobDeath', caption: 'Mob dies' },
  { id: 'ambient-rain', event: { kind: 'ambient', layer: 'rain' }, cueId: 'rainAmbient', caption: 'Rain falls' },
  { id: 'ambient-thunder', event: { kind: 'ambient', layer: 'thunder' }, cueId: 'thunderClap', caption: 'Thunder rumbles' },
]

describe('playAudioEvent through a real audio runtime', () => {
  for (const eventCase of EVENT_CASES) {
    it(`${eventCase.id}: plays ${eventCase.cueId} with caption "${eventCase.caption}"`, async () => {
      const { recording, runtime } = await freshRuntime(3)

      const mapping = playAudioEvent(runtime, eventCase.event)

      expect(Result.isSuccess(mapping) && mapping.success.cueId).toBe(eventCase.cueId)
      const snapshot = runtime.snapshot(MonotonicTimeSecs(3))
      expect(snapshot.cueIds).toEqual([eventCase.cueId])
      expect(snapshot.captions.map((caption) => caption.text)).toEqual([eventCase.caption])
      expect(await Effect.runPromise(recording.played)).toHaveLength(1)
    })
  }

  it('forwards play options so a positioned event pans in world space', async () => {
    const { recording, runtime } = await freshRuntime(0)

    playAudioEvent(runtime, { kind: 'place', blockType: 'stone' }, { position: at(12, 0, 0) })

    expect((await Effect.runPromise(recording.played))[0]?.pan).toBeCloseTo(1)
  })

  it('returns the typed failure and plays nothing for an unknown block type', async () => {
    const { recording, runtime } = await freshRuntime(0)

    const mapping = playAudioEvent(runtime, { kind: 'mining', blockType: 'not_a_block' })

    expect(Result.isFailure(mapping) && mapping.failure).toEqual({
      _tag: 'AudioEventMapFailure',
      kind: 'mining',
      blockType: 'not_a_block',
      reason: 'unknown-block-type',
    })
    const snapshot = runtime.snapshot(MonotonicTimeSecs(0))
    expect(snapshot.cueIds).toEqual([])
    expect(snapshot.captions).toEqual([])
    expect(await Effect.runPromise(recording.played)).toEqual([])
  })

  it('returns an invalid-type failure and plays nothing for a non-string block type', async () => {
    const { recording, runtime } = await freshRuntime(0)

    const mapping = playAudioEvent(runtime, { kind: 'place', blockType: 42 })

    expect(Result.isFailure(mapping) && mapping.failure).toEqual({
      _tag: 'AudioEventMapFailure',
      kind: 'place',
      blockType: null,
      reason: 'invalid-type',
    })
    const snapshot = runtime.snapshot(MonotonicTimeSecs(0))
    expect(snapshot.cueIds).toEqual([])
    expect(snapshot.captions).toEqual([])
    expect(await Effect.runPromise(recording.played)).toEqual([])
  })

  it('does not let a failed event suppress a later valid one', async () => {
    const { runtime } = await freshRuntime(0)

    playAudioEvent(runtime, { kind: 'mining', blockType: 'not_a_block' })
    playAudioEvent(runtime, { kind: 'mining', blockType: 'dirt' })

    expect(runtime.snapshot(MonotonicTimeSecs(0)).cueIds).toEqual(['blockBreak'])
  })

  it('produces the same cue and caption sequence in two fresh runtimes', async () => {
    const events: ReadonlyArray<AudioEvent> = EVENT_CASES.map((eventCase) => eventCase.event)
    const run = async () => {
      const { recording, runtime } = await freshRuntime(5)
      for (const event of events) playAudioEvent(runtime, event)
      const snapshot = runtime.snapshot(MonotonicTimeSecs(5))
      return {
        cueIds: snapshot.cueIds,
        captions: snapshot.captions.map((caption) => caption.text),
        gains: (await Effect.runPromise(recording.played)).map((request) => request.gain),
      }
    }

    const first = await run()
    const second = await run()

    expect(first.cueIds).toEqual(EVENT_CASES.map((eventCase) => eventCase.cueId))
    expect(second).toEqual(first)
  })

  it('keeps the cue and caption when backend playback defects', async () => {
    const { runtime } = await freshRuntime(4, (backend) => ({
      ...backend,
      playTone: () => Effect.die(new Error('backend defect')),
    }))

    const mapping = playAudioEvent(runtime, { kind: 'hurt', target: 'player' })

    expect(Result.isSuccess(mapping) && mapping.success.cueId).toBe('playerHurt')
    const snapshot = runtime.snapshot(MonotonicTimeSecs(4))
    expect(snapshot.cueIds).toEqual(['playerHurt'])
    expect(snapshot.captions.map((caption) => caption.text)).toEqual(['You were hurt'])
  })
})
