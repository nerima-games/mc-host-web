import { describe, expect, it } from '@effect/vitest'
import { AngleRadians, EntityId, PositionAxis } from '@nerima-games/mc-kernel'
import { BlocksPerSecond, DeltaTimeSecs, position, type AABB } from '@nerima-games/mc-physics'
import type { ProjectileWorld } from '@nerima-games/mc-sim'
import {
  advanceProjectileRuntime,
  initialProjectileRuntimeState,
  launchRuntimeProjectile,
  projectileRenderDescriptors,
  recoverProjectile,
} from '../apps/web/projectile-runtime'

// Fixture bounds, poses, speeds, and deltas are finite literals.
const box = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): AABB => ({
  minX: PositionAxis(minX),
  minY: PositionAxis(minY),
  minZ: PositionAxis(minZ),
  maxX: PositionAxis(maxX),
  maxY: PositionAxis(maxY),
  maxZ: PositionAxis(maxZ),
})

const world = (overrides: Partial<ProjectileWorld> = {}): ProjectileWorld => ({
  blockBounds: () => [],
  bounds: box(-100, -100, -100, 100, 100, 100),
  entities: [],
  isInWater: () => false,
  ...overrides,
})

const launched = () => launchRuntimeProjectile(initialProjectileRuntimeState(), {
  dimension: 'overworld',
  position: position(PositionAxis(0), PositionAxis(1), PositionAxis(0)),
  yawRadians: AngleRadians(-Math.PI / 2),
  pitchRadians: AngleRadians(0),
  speed: BlocksPerSecond(100),
  damage: 7,
  knockback: 1,
  shooterId: EntityId('player'),
})

describe('projectile runtime', () => {
  it('integrates gravity and drag and emits an existing renderer descriptor', () => {
    const result = advanceProjectileRuntime(launched(), world(), 'overworld', DeltaTimeSecs(0.05))
    expect(result.state.projectiles[0]?.arrow.velocity.y).toBeLessThan(0)
    expect(projectileRenderDescriptors(result.state, 'overworld')[0]).toMatchObject({
      id: 'projectile:arrow-1', category: 'item', kind: 'arrow',
    })
  })

  it('advances only the active dimension and preserves other dimension projectiles', () => {
    const overworld = launched()
    const state = launchRuntimeProjectile(overworld, {
      dimension: 'nether',
      position: position(PositionAxis(4), PositionAxis(1), PositionAxis(0)),
      yawRadians: AngleRadians(0),
      pitchRadians: AngleRadians(0),
      speed: BlocksPerSecond(10),
      damage: 4,
      knockback: 0,
      shooterId: EntityId('player'),
    })
    const netherProjectile = state.projectiles.find(({ dimension }) => dimension === 'nether')

    const result = advanceProjectileRuntime(state, world(), 'overworld', DeltaTimeSecs(0.05))

    expect(result.state.projectiles.find(({ dimension }) => dimension === 'nether')).toStrictEqual(netherProjectile)
    expect(result.state.projectiles.find(({ dimension }) => dimension === 'overworld')).not.toStrictEqual(
      state.projectiles.find(({ dimension }) => dimension === 'overworld'),
    )
  })

  it('continuously collides with a block, remains stuck, and can be recovered', () => {
    const result = advanceProjectileRuntime(launched(), world({
      blockBounds: () => [box(2, 0, -1, 3, 2, 1)],
    }), 'overworld', DeltaTimeSecs(0.05))
    expect(result.impacts[0]?.hit).toMatchObject({ kind: 'block', point: { x: 2 } })
    expect(result.state.projectiles[0]?.arrow.state).toBe('stuck')
    const recovered = recoverProjectile(result.state, 'overworld', { x: 2, y: 1, z: 0 }, 1)
    expect(recovered.recovered?.id).toBe('arrow-1')
    expect(recovered.state.projectiles).toHaveLength(0)
  })

  it('damages through entity impacts, despawns, and observes shooter grace', () => {
    const target = { id: EntityId('mob'), bounds: box(2, 0, -1, 3, 2, 1) }
    const hit = advanceProjectileRuntime(launched(), world({ entities: [target] }), 'overworld', DeltaTimeSecs(0.05))
    expect(hit.impacts[0]).toMatchObject({ damage: 7, knockback: 1, hit: { kind: 'entity', entityId: 'mob' } })
    expect(hit.state.projectiles).toHaveLength(0)

    const shooter = { id: EntityId('player'), bounds: box(0, 0, -1, 1, 2, 1) }
    expect(advanceProjectileRuntime(launched(), world({ entities: [shooter] }), 'overworld', DeltaTimeSecs(0.01)).impacts).toHaveLength(0)
  })

  it('removes projectiles that expire or leave the world and resets deterministically', () => {
    const out = advanceProjectileRuntime(launched(), world({
      bounds: box(-1, -1, -1, 0.1, 2, 1),
    }), 'overworld', DeltaTimeSecs(0.05))
    expect(out.state.projectiles).toHaveLength(0)
    expect(initialProjectileRuntimeState()).toStrictEqual({ nextId: 0, projectiles: [] })
  })
})
