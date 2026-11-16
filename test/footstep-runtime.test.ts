import { blockIdOf, PositionAxis, position, type BlockType, type Position } from '@nerima-games/mc-kernel'
import { Option } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  advanceFootstepRuntime,
  initialFootstepRuntimeState,
  type FootstepAdvanceInput,
} from '../apps/web/footstep-runtime'

const at = (x: number, y: number, z: number): Position =>
  position(PositionAxis(x), PositionAxis(y), PositionAxis(z))

// Every name passed here is a registered kernel block type, so the lookup
// cannot be empty; a missing entry means the registry changed under the test.
const idOf = (type: BlockType): number => Option.getOrThrow(blockIdOf(type))

const walking = (overrides: Partial<FootstepAdvanceInput>): FootstepAdvanceInput => ({
  grounded: true,
  horizontalDistance: 0,
  standingOnBlockId: idOf('stone'),
  sneaking: false,
  dead: false,
  dimensionChanged: false,
  position: at(0, 0, 0),
  ...overrides,
})

describe('footstep runtime', () => {
  it('emits one spatial cue per walking interval and preserves remainder', () => {
    const play = vi.fn()
    const state = advanceFootstepRuntime(initialFootstepRuntimeState(), walking({
      horizontalDistance: 4.5,
      standingOnBlockId: idOf('grass_block'),
      sneaking: true,
      position: at(1, 2, 3),
    }), { play })

    expect(play).toHaveBeenCalledTimes(2)
    expect(play).toHaveBeenNthCalledWith(1, 'footstepGrass', {
      position: { x: 1, y: 2, z: 3 },
      gainScale: 0.55,
    })
    expect(play).toHaveBeenNthCalledWith(2, 'footstepGrass', {
      position: { x: 1, y: 2, z: 3 },
      gainScale: 0.55,
    })
    expect(state.distanceSinceLastStep).toBeCloseTo(0.5)
  })

  it.each([
    ['stone', 'footstepStone'],
    ['oak_planks', 'footstepWood'],
    ['cactus', 'footstepDefault'],
  ] as const)('plays the cue for the footstep material of %s', (type, cueId) => {
    const play = vi.fn()
    const state = advanceFootstepRuntime({ distanceSinceLastStep: 1.5 }, walking({
      horizontalDistance: 1,
      standingOnBlockId: idOf(type),
    }), { play })

    expect(play).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledWith(cueId, {
      position: { x: 0, y: 0, z: 0 },
      gainScale: 1,
    })
    expect(state.distanceSinceLastStep).toBeCloseTo(0.5)
  })

  it('advances distance without a cue when the block id is invalid', () => {
    const play = vi.fn()
    const state = advanceFootstepRuntime({ distanceSinceLastStep: 1.5 }, walking({
      horizontalDistance: 1,
      standingOnBlockId: -1,
    }), { play })

    expect(play).not.toHaveBeenCalled()
    expect(state.distanceSinceLastStep).toBe(2.5)
  })

  it.each([
    ['airborne', { grounded: false }],
    ['dead', { dead: true }],
    ['dimension change', { dimensionChanged: true }],
  ] as const)('resets accumulated distance on %s', (_label, overrides) => {
    const play = vi.fn()
    const state = advanceFootstepRuntime({ distanceSinceLastStep: 1.5 }, walking({
      horizontalDistance: 4,
      ...overrides,
    }), { play })

    expect(state).toEqual(initialFootstepRuntimeState())
    expect(play).not.toHaveBeenCalled()
  })
})
