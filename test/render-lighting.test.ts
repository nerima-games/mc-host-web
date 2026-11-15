import { BlockId } from '@nerima-games/mc-kernel'
import type { GeometryQuad, MeshQuad } from '@nerima-games/mc-render'
import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'

import { trackChunkLightColor } from '../apps/web/render-lighting'

const quad: MeshQuad = {
  blockId: BlockId(1), direction: 'yPos', role: 'top',
  lx: 2, y: 64, lz: 3, width: 1, height: 1, ao: 0,
}

describe('render lighting tracking', () => {
  it('counts resolved chunks and consumed quads separately, including empty chunks', () => {
    const seen: Array<ReadonlyArray<GeometryQuad>> = []
    const tracked = trackChunkLightColor((_chunk, quads) => Effect.sync(() => {
      seen.push(quads)
      return (sample: GeometryQuad) => [sample === dark ? 0 : 255, 64, 128] as const
    }))
    const initial = {
      resolvedChunks: 0, sampledQuads: 0, darkestShade: null,
      brightestShade: null, lastChunk: null,
    }
    const dark = { ...quad, ao: 0 }
    const bright = { ...quad, ao: 3 }
    const quads = [dark, bright]
    const before = tracked.snapshot()
    const pending = tracked.colorForChunk({ cx: 2, cz: -3 }, quads)
    expect(tracked.snapshot()).toEqual(initial)
    expect(seen).toEqual([])

    const color = Effect.runSync(pending)
    expect(seen[0]).toBe(quads)
    expect(tracked.snapshot()).toEqual({
      ...initial, resolvedChunks: 1, lastChunk: { cx: 2, cz: -3 },
    })
    expect(color(dark)).toEqual([0, 64, 128])
    expect(color(bright)).toEqual([255, 64, 128])
    expect(color(dark)).toEqual([0, 64, 128])
    Effect.runSync(tracked.colorForChunk({ cx: -1, cz: 0 }, []))
    expect(tracked.snapshot()).toEqual({
      resolvedChunks: 2, sampledQuads: 3, darkestShade: 0,
      brightestShade: 255, lastChunk: { cx: -1, cz: 0 },
    })
    expect(before).toEqual(initial)
  })
})
