import { planRenderEnvironment } from '@nerima-games/mc-render'
import { describe, expect, it } from 'vitest'
import { Result } from 'effect'

describe('planRenderEnvironment overworld default', () => {
  it.each([
    [0, 300],
    [0.08, 300],
    [0.5, 300],
    [1, 300],
    [0.5, 16],
    [0.5, undefined],
  ] as const)('daylight=%s farPlane=%s: omitting dimension matches passing overworld explicitly', (daylight, farPlane) => {
    const omitted = planRenderEnvironment(daylight, farPlane)
    const explicitOverworld = planRenderEnvironment(daylight, farPlane, 'overworld')
    expect(Result.isSuccess(omitted)).toBe(true)
    expect(Result.isSuccess(explicitOverworld)).toBe(true)
    expect(Result.getOrThrow(omitted)).toEqual(Result.getOrThrow(explicitOverworld))
  })
})
