import { planRenderEnvironment, RenderEnvironmentDimensionSchema } from '@nerima-games/mc-render'
import { describe, expect, it } from 'vitest'
import { Result, Schema } from 'effect'

const daylightCases = [
  { daylight: 0, skyColor: 0x232a45, rgb: [35, 42, 69] },
  { daylight: 0.08, skyColor: 0x2b3752, rgb: [43, 55, 82] },
  { daylight: 0.5, skyColor: 0x557c98, rgb: [85, 124, 152] },
  { daylight: 1, skyColor: 0x87ceeb, rgb: [135, 206, 235] },
] as const

describe('render environment dimensions', () => {
  const cases = daylightCases.flatMap((daylight) => [16, 300, undefined].flatMap((farPlane) =>
    (['overworld', 'nether', 'end'] as const).map((dimension) => ({ ...daylight, farPlane, dimension })),
  ))
  it.each(cases)('$dimension daylight=$daylight farPlane=$farPlane retains its environment',
    ({ daylight, skyColor, rgb, farPlane, dimension }) => {
      const plan = Result.getOrThrow(planRenderEnvironment(daylight, farPlane, dimension))
      const far = farPlane ?? 300
      const expected = dimension === 'nether'
        ? { skyColor: 0x3c1e18, rgb: [60, 30, 24], sunIntensity: 0, fogNear: far * 0.05, fogFar: far * 0.3 }
        : dimension === 'end'
          ? { skyColor: 0x0a0714, rgb: [10, 7, 20], sunIntensity: 0, fogNear: far * 0.45, fogFar: far * 0.9 }
          : { skyColor, rgb, sunIntensity: daylight, fogNear: far * 0.45, fogFar: far * 0.9 }
      expect(plan).toEqual({
        dimension, daylight, skyColor: expected.skyColor,
        fogColor: expected.rgb.map((channel) => channel / 255),
        sunIntensity: expected.sunIntensity, fogNear: expected.fogNear, fogFar: expected.fogFar,
      })
      if (dimension === 'overworld') {
        expect(Result.getOrThrow(planRenderEnvironment(daylight, farPlane))).toEqual(plan)
      }
    },
  )

  it.each([-0.01, 1.01, NaN, Infinity])('rejects invalid daylight %s', (daylight) => {
    expect(Result.isFailure(planRenderEnvironment(daylight))).toBe(true)
  })
  it.each([0, -1, NaN, Infinity])('rejects invalid far plane %s', (farPlane) => {
    expect(Result.isFailure(planRenderEnvironment(0.5, farPlane))).toBe(true)
  })
  it('rejects an explicit unknown dimension', () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(RenderEnvironmentDimensionSchema)('unknown'))).toBe(true)
  })
})
