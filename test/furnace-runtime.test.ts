import { Result } from 'effect'
import type { ItemType } from '@nerima-games/mc-kernel'
import { emptyFurnaceState, furnaceState, itemStack, type FurnaceState } from '@nerima-games/mc-sim'
import { planFurnaceAdvance } from '@nerima-games/mx-gameplay'
import { describe, expect, it } from 'vitest'
import { advanceFurnaceRuntime } from '../apps/web/furnace-runtime'

// Fixture literals are in-range stack counts, a valid furnace snapshot and finite non-negative seconds.
const stackOf = (item: ItemType, count: number) => Result.getOrThrow(itemStack(item, count))
const planOf = (...args: Parameters<typeof planFurnaceAdvance>) => Result.getOrThrow(planFurnaceAdvance(...args))

const fueledFurnace = (): FurnaceState => Result.getOrThrow(furnaceState({
  input: stackOf('raw_iron', 1),
  fuel: stackOf('coal', 1),
}))

describe('furnace web runtime', () => {
  it('leaves an empty furnace unchanged', () => {
    const state = Result.getOrThrow(emptyFurnaceState())

    const outcome = advanceFurnaceRuntime(state, planOf(state, 1))

    expect(outcome.state).toEqual(state)
    expect(outcome._tag).toBe('Applied')
    expect(outcome.changed).toBe(false)
  })

  it('advances a fueled furnace through the gameplay plan boundary', () => {
    const state = fueledFurnace()
    const outcome = advanceFurnaceRuntime(state, planOf(state, 10))

    expect(outcome._tag).toBe('Applied')
    expect(outcome.changed).toBe(true)
    expect(outcome.state.input).toBeNull()
    expect(outcome.state.fuel).toBeNull()
    expect(outcome.state.output).toEqual(stackOf('iron_ingot', 1))
  })

  it('reports time deferred by the bounded gameplay plan', () => {
    const state = fueledFurnace()
    const outcome = advanceFurnaceRuntime(state, planOf(state, 12))

    expect(outcome.advancedSecs).toBe(10)
    expect(outcome.deferredSecs).toBe(2)
  })

  it('rejects a plan when the host-owned snapshot changed before apply', () => {
    const state = fueledFurnace()
    const plan = planOf(state, 1)
    const changed = { ...state, fuel: undefined }

    const outcome = advanceFurnaceRuntime(changed, plan)

    expect(outcome.state).toEqual(changed)
    expect(outcome._tag).toBe('Stale')
    expect(outcome.changed).toBe(false)
    expect(outcome.advancedSecs).toBe(0)
    expect(outcome.deferredSecs).toBe(1)
  })
})
