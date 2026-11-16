import { type DomElement, type DomNode } from '@nerima-games/mx-ui'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  createDebugOverlayRuntime,
  type DebugOverlayRuntimeState,
} from '../apps/web/debug-overlay-runtime'
import { makeFrameBoundary } from '../apps/web/frame-boundary-queue'
import { runTickDebugOverlayFrame } from '../apps/web/tick/debug-overlay-frame'

const noop = (): void => {}

class Element {
  readonly nodeType = 1
  textContent: string | null = ''
  readonly attributes = new Map<string, string>()
  readonly children: Array<DomNode> = []
  readonly style = { setProperty: (): void => {}, removeProperty: (): void => {} }
  value = ''
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  appendChild(child: DomNode): void { this.children.push(child) }
  removeChild(child: DomElement): void { this.children.splice(this.children.indexOf(child), 1) }
  readonly addEventListener = noop
  readonly focus = noop
}

const factory = { createElement: (): Element => new Element() }
const unavailable: DebugOverlayRuntimeState = {
  cameraPose: undefined,
  dimension: undefined,
  worldTime: undefined,
  gpuTimingSupported: undefined,
  latestGpuTimeMs: undefined,
  qualityPreset: undefined,
  biome: undefined,
  loadedChunkCount: undefined,
  faultCount: undefined,
}
// main.ts's FIRST_FRAME_SECS: the synthetic interval of the first frame.
const FIRST_FRAME_SECS = 0.016

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe('debug overlay frame step', () => {
  it('reads once per visible frame through the frame boundary, omits the first frame timing, and reads nothing while hidden', async () => {
    const boundary = Effect.runSync(makeFrameBoundary<never>())
    let reads = 0
    // The read count is the rendered chunk count, so the text shows which read the frame rendered.
    const runtime = createDebugOverlayRuntime(factory, new Element(), Effect.sync(() => {
      reads += 1
      return { ...unavailable, loadedChunkCount: reads }
    }))
    let framesTotal = 0
    // Shaped like main.ts's frame: gameplay counts the frame, then the overlay step runs.
    const frame = (raw: number) => boundary.frame(Effect.gen(function* () {
      framesTotal += 1
      yield* runTickDebugOverlayFrame(runtime.update, { framesTotal, raw })
    }))

    runtime.setVisible(true)
    await Effect.runPromise(frame(FIRST_FRAME_SECS))
    expect(reads).toBe(1)
    expect(runtime.root.textContent).toMatch(/Loaded chunks: 1|読み込み済みチャンク数: 1/)
    expect(runtime.root.textContent).toMatch(/FPS: None|FPS: なし/)

    await Effect.runPromise(frame(0.02))
    expect(reads).toBe(2)
    expect(runtime.root.textContent).toMatch(/Loaded chunks: 2|読み込み済みチャンク数: 2/)
    expect(runtime.root.textContent).toContain('FPS: 50')

    await Effect.runPromise(frame(0.04))
    expect(reads).toBe(3)
    expect(runtime.root.textContent).toContain('FPS: 25')

    await Effect.runPromise(frame(0.01))
    expect(reads).toBe(4)
    expect(runtime.root.textContent).toContain('FPS: 100')

    runtime.setVisible(false)
    const hiddenText = runtime.root.textContent
    for (const raw of [0.02, 0.02, 0.02]) await Effect.runPromise(frame(raw))
    expect(framesTotal).toBe(7)
    expect(reads).toBe(4)
    expect(runtime.root.textContent).toBe(hiddenText)
  })

  it('runs the update while the frame holds the frame lock', async () => {
    const boundary = Effect.runSync(makeFrameBoundary<never>())
    const reading = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const order: Array<string> = []
    const runtime = createDebugOverlayRuntime(factory, new Element(), Effect.gen(function* () {
      order.push('read')
      yield* Deferred.succeed(reading, undefined)
      yield* Deferred.await(release)
      order.push('read done')
      return unavailable
    }))
    runtime.setVisible(true)

    const frame = Effect.runFork(boundary.frame(runTickDebugOverlayFrame(runtime.update, { framesTotal: 2, raw: 0.02 })))
    await Effect.runPromise(Deferred.await(reading))
    // `outsideFrame` takes the same one-permit lock that `frame` holds for its
    // whole body. While the update is suspended in its read, work under the lock
    // stays pending, while an unlocked fiber forked at the same moment completes.
    // So the update runs with the lock held, not after `frame` released it.
    const locked = Effect.runFork(boundary.outsideFrame(Effect.sync(() => { order.push('outside') })))
    const unlocked = Effect.runFork(Effect.sync(() => { order.push('unlocked') }))
    await settle()
    expect(unlocked.pollUnsafe()).toBeDefined()
    expect(locked.pollUnsafe()).toBeUndefined()
    expect(order).toEqual(['read', 'unlocked'])

    Effect.runSync(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(frame))
    await Effect.runPromise(Fiber.join(locked))
    expect(order).toEqual(['read', 'unlocked', 'read done', 'outside'])
    expect(runtime.root.textContent).toContain('FPS: 50')
  })
})
