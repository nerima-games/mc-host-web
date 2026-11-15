import { BlockId, LightLevelCandidate } from '@nerima-games/mc-kernel'
import { litColor, packedLightColor, type FaceDirection, type GeometryQuad, type MeshQuad } from '@nerima-games/mc-render'
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
    const bright = { ...quad, ao: 255 }
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

  const levels = Array.from({ length: 16 }, (_, level) => level)
  const lightPairs = levels.flatMap((sky) => levels.map((block) => ({ sky, block })))
  it.each(lightPairs)('preserves packed sky=$sky block=$block', ({ sky, block }) => {
    const resolve = packedLightColor(() => ({ sky: LightLevelCandidate(sky), block: LightLevelCandidate(block) }))
    const tracked = trackChunkLightColor(() => Effect.succeed(resolve))
    const color = Effect.runSync(tracked.colorForChunk({ cx: 0, cz: 0 }, [quad]))
    expect(color(quad)).toEqual([255, sky * 17, block * 17])
    expect(tracked.snapshot()).toMatchObject({ darkestShade: 255, brightestShade: 255, sampledQuads: 1 })
  })

  const faces: ReadonlyArray<{ direction: FaceDirection; brightness: number }> = [
    { direction: 'yPos', brightness: 1 }, { direction: 'yNeg', brightness: 0.5 },
    { direction: 'xPos', brightness: 0.6 }, { direction: 'xNeg', brightness: 0.6 },
    { direction: 'zPos', brightness: 0.8 }, { direction: 'zNeg', brightness: 0.8 },
  ]
  const shadeCases = faces.flatMap(({ direction, brightness }) =>
    [0, 1, 2, 3].flatMap((ao) => [0, 15].flatMap((sky) => [0, 15].flatMap((block) =>
      [0, 0.08, 0.5, 1].map((daylight) => ({ direction, brightness, ao, sky, block, daylight })),
    ))),
  )
  it.each(shadeCases)('preserves CPU shade $direction ao=$ao sky=$sky block=$block daylight=$daylight',
    ({ direction, brightness, ao, sky, block, daylight }) => {
      const sample = { ...quad, direction, ao }
      const resolve = litColor(() => ({ sky: LightLevelCandidate(sky), block: LightLevelCandidate(block) }), {
        skyIntensity: daylight,
      })
      const tracked = trackChunkLightColor(() => Effect.succeed(resolve))
      const color = Effect.runSync(tracked.colorForChunk({ cx: 0, cz: 0 }, [sample]))
      const level = Math.max(sky * daylight, block)
      const shade = Math.round(255 * (0.45 + 0.55 * level / 15) * (0.8 + 0.2 * (1 - ao / 5)) * brightness)
      expect(color(sample)).toEqual([shade, shade, shade])
      expect(tracked.snapshot()).toMatchObject({ darkestShade: shade, brightestShade: shade, sampledQuads: 1 })
    },
  )
})
