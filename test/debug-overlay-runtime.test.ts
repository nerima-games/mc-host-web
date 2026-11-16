import {
  EpochMillis,
  FixedClockLayer,
  MonotonicTimeSecs,
  PositionAxis,
  WorldId,
  position,
} from '@nerima-games/mc-kernel'
import { makeWorldCommitCoordinator } from '@nerima-games/mc-sim'
import { GAMEPLAY_PLAYER_OWNER_ID, gameplayOwnerRegistrations } from '@nerima-games/mx-gameplay'
import { type DomElement, type DomNode } from '@nerima-games/mx-ui'
import { Effect, Result } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  createDebugOverlayRuntime,
  type DebugOverlayRuntimeState,
} from '../apps/web/debug-overlay-runtime'
import { makeOwnerBackedStagePlayer } from '../apps/web/owner-backed-services'

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

const created: Array<Element> = []
const factory = { createElement: (): Element => {
  const element = new Element()
  created.push(element)
  return element
} }
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
const clock = FixedClockLayer({ monotonicSecs: MonotonicTimeSecs(12), wallClockEpochMillis: EpochMillis(0) })
const at = (x: number, y: number, z: number) => position(PositionAxis(x), PositionAxis(y), PositionAxis(z))

describe('debug overlay runtime', () => {
  it('accepts the browser document and mount element without casts', () => {
    expectTypeOf<Document>().toExtend<Parameters<typeof createDebugOverlayRuntime>[0]>()
    expectTypeOf<HTMLElement>().toExtend<Parameters<typeof createDebugOverlayRuntime>[1]>()
  })

  it('renders fresh coordinator-owned camera state through the published view', async () => {
    const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
      world: WorldId('debug-overlay-test'),
      owners: gameplayOwnerRegistrations(),
    }))
    const player = makeOwnerBackedStagePlayer({ coordinator, playerOwnerId: GAMEPLAY_PLAYER_OWNER_ID })
    Effect.runSync(player.moveTo(at(-0.25, 64, 32)))
    Effect.runSync(player.look(0.5, -0.25))
    const readState = Effect.gen(function* () {
      const cameraPose = yield* player.cameraPose
      const dimension = yield* player.dimension
      return {
        ...unavailable,
        cameraPose,
        dimension,
        loadedChunkCount: 3,
        faultCount: 2,
        gpuTimingSupported: true,
        latestGpuTimeMs: 1.5,
        qualityPreset: 'low',
      } satisfies DebugOverlayRuntimeState
    }).pipe(Effect.provide(clock))
    const parent = new Element()
    const runtime = createDebugOverlayRuntime(factory, parent, readState)
    expect(parent.children).toEqual([runtime.root])
    const root = created.at(-1)
    expect(root?.attributes.has('hidden')).toBe(true)
    expect(runtime.toggle()).toBe(true)
    expect(root?.attributes.has('hidden')).toBe(false)
    await Effect.runPromise(runtime.update(0.02))
    expect(runtime.root.textContent).toContain('-0.25, 65.62, 32')
    expect(runtime.root.textContent).toMatch(/Chunk: -1, 2|チャンク: -1, 2/)
    expect(runtime.root.textContent).toContain('0.5')
    expect(runtime.root.textContent).toContain('-0.25')
    expect(runtime.root.textContent).toContain('FPS: 50')
    expect(runtime.root.textContent).toContain('0.02')
    expect(runtime.root.textContent).toContain('Loaded chunks: 3')
    expect(runtime.root.textContent).toContain('Faults: 2')
    expect(runtime.root.textContent).toContain('GPU timing supported: Yes')
    expect(runtime.root.textContent).toContain('GPU time: 1.5')
    expect(runtime.root.textContent).toContain('Quality: Low')

    Effect.runSync(player.moveTo(at(16, 70, -16.01)))
    Effect.runSync(player.setDimension('nether'))
    await Effect.runPromise(runtime.update(0.04))
    expect(runtime.root.textContent).toContain('16, 71.62, -16.01')
    expect(runtime.root.textContent).toMatch(/Chunk: 1, -2|チャンク: 1, -2/)
    expect(runtime.root.textContent).toMatch(/Nether|ネザー/)
    expect(runtime.root.textContent).toContain('FPS: 25')
    expect(runtime.toggle()).toBe(false)
    expect(root?.attributes.has('hidden')).toBe(true)
    runtime.dispose()
    expect(parent.children).toHaveLength(0)
  })

  it('keeps readable timing when pose is unavailable and marks missing fields explicitly', async () => {
    const runtime = createDebugOverlayRuntime(factory, new Element(), Effect.succeed(unavailable))
    runtime.setVisible(true)
    await Effect.runPromise(runtime.update(0.01))
    expect(runtime.root.textContent).toContain('FPS: 100')
    expect(runtime.root.textContent).toMatch(/Coordinates: None|座標: なし/)
    expect(runtime.root.textContent).toMatch(/Chunk: None|チャンク: なし/)
    expect(runtime.root.textContent).toMatch(/Facing: None|向き: なし/)
    expect(runtime.root.textContent).toMatch(/Biome: None|バイオーム: なし/)
    expect(runtime.root.textContent).toMatch(/Faults: None|フォールト数: なし/)
    await Effect.runPromise(runtime.update(undefined))
    expect(runtime.root.textContent).toMatch(/FPS: None|FPS: なし/)
  })

  it('reads on each visible update and does not read while hidden', async () => {
    let reads = 0
    const runtime = createDebugOverlayRuntime(factory, new Element(), Effect.sync(() => {
      reads += 1
      return { ...unavailable, loadedChunkCount: reads }
    }))
    await Effect.runPromise(runtime.update(0.01))
    expect(reads).toBe(0)
    runtime.setVisible(true)
    await Effect.runPromise(runtime.update(0.01))
    expect(runtime.root.textContent).toMatch(/Loaded chunks: 1|読み込み済みチャンク数: 1/)
    await Effect.runPromise(runtime.update(0.01))
    expect(runtime.root.textContent).toMatch(/Loaded chunks: 2|読み込み済みチャンク数: 2/)
    runtime.setVisible(false)
    await Effect.runPromise(runtime.update(0.01))
    expect(reads).toBe(2)
  })

  it('preserves typed owner read failures', async () => {
    const failure = { _tag: 'OwnerUnavailable' }
    const runtime = createDebugOverlayRuntime(factory, new Element(), Effect.fail(failure))
    runtime.setVisible(true)
    const result = await Effect.runPromise(Effect.result(runtime.update(0.01)))
    expect(result).toEqual(Result.fail(failure))
    expect(runtime.root.textContent).toBe('')
  })

  it.each([NaN, Infinity, -0.01])('rejects invalid frame time %s without rendering a substitute', async (delta) => {
    const runtime = createDebugOverlayRuntime(factory, new Element(), Effect.succeed(unavailable))
    runtime.setVisible(true)
    await Effect.runPromise(runtime.update(0.02))
    const previous = runtime.root.textContent
    const result = await Effect.runPromise(Effect.result(runtime.update(delta)))
    expect(Result.isFailure(result)).toBe(true)
    expect(runtime.root.textContent).toBe(previous)
  })

  it.each([
    { ...unavailable, loadedChunkCount: -1 },
    { ...unavailable, faultCount: 0.5 },
    { ...unavailable, latestGpuTimeMs: NaN },
  ])('rejects invalid diagnostics through the published schemas', async (state) => {
    const runtime = createDebugOverlayRuntime(factory, new Element(), Effect.succeed(state))
    runtime.setVisible(true)
    const result = await Effect.runPromise(Effect.result(runtime.update(0.01)))
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'SchemaError' } })
    expect(runtime.root.textContent).toBe('')
  })

  it('shows zero frame time with unavailable FPS rather than inventing a rate', async () => {
    const runtime = createDebugOverlayRuntime(factory, new Element(), Effect.succeed(unavailable))
    runtime.setVisible(true)
    await Effect.runPromise(runtime.update(0))
    expect(runtime.root.textContent).toMatch(/FPS: None|FPS: なし/)
    expect(runtime.root.textContent).toMatch(/Frame delta: 0(?:\n|$)/)
  })
})
