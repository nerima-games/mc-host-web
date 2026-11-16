import { DomainEventSchema, type DomainEvent } from '@nerima-games/mc-kernel'
import * as Render from '@nerima-games/mc-render'
import { Effect, Result, Schema } from 'effect'
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeParticleRuntime } from '../apps/web/particle-runtime'

vi.mock('@nerima-games/mc-render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nerima-games/mc-render')>()
  return { ...actual, particleRequestForDomainEvent: vi.fn(actual.particleRequestForDomainEvent) }
})

const decodeEvent = Schema.decodeUnknownSync(DomainEventSchema)
const at = { dimension: 'nether', x: 3, y: 65, z: -2 }
const address = { dimension: 'nether', position: { x: 3, y: 65, z: -2 } }
const frame: Render.ParticleFrameSnapshot = {
  dimension: 'nether', entities: [{ id: 'actor', feetPosition: { x: 3, y: 65, z: -2 } }],
}
const broken = decodeEvent({ _tag: 'BlockBroken', tick: 1, actor: 'actor', address, block: 1 })
const hurt = decodeEvent({ _tag: 'EntityDamaged', tick: 1, entity: 'actor', position: at, amount: 1, cause: 'mob' })
const healed = decodeEvent({ _tag: 'EntityHealed', tick: 1, entity: 'actor', amount: 1, cause: 'regeneration' })
const achievement = decodeEvent({ _tag: 'AchievementUnlocked', tick: 1, player: 'actor', achievement: 'minecraft:story/root' })

type EventCase = Readonly<{ name: string; event: DomainEvent; kind: Render.ParticleKind }>

// Expected kinds follow mc-render's public particle-event-adapter mapping.
const cases: ReadonlyArray<EventCase> = [
  { name: 'BlockBroken', event: broken, kind: 'block-break' },
  { name: 'BlockPlaced', event: decodeEvent({ _tag: 'BlockPlaced', tick: 1, actor: 'actor', address, block: 1 }), kind: 'level-up' },
  ...['fire', 'weather', 'fluid', 'support-cascade', 'explosion'].map((cause): EventCase => ({
    name: `BlockChangedByWorld/${cause}`,
    event: decodeEvent({ _tag: 'BlockChangedByWorld', tick: 1, address, cause }),
    kind: cause === 'fire' ? 'fire' : 'block-break',
  })),
  ...['creeper', 'tnt'].map((source): EventCase => ({
    name: `Explosion/${source}`, event: decodeEvent({ _tag: 'Explosion', tick: 1, position: at, power: 3, source }), kind: 'explosion',
  })),
  { name: 'EntityDamaged', event: hurt, kind: 'entity-hit' },
  { name: 'EntityDied', event: decodeEvent({ _tag: 'EntityDied', tick: 1, entity: 'actor', kind: 'zombie', position: at, cause: 'mob' }), kind: 'entity-hit' },
  { name: 'EntityHealed', event: healed, kind: 'level-up' },
  { name: 'EntitySpawned', event: decodeEvent({ _tag: 'EntitySpawned', tick: 1, entity: 'actor', kind: 'zombie', position: at }), kind: 'level-up' },
  { name: 'EntityTeleported', event: decodeEvent({ _tag: 'EntityTeleported', tick: 1, entity: 'actor', from: { ...at, x: 1 }, to: at, cause: 'enderman' }), kind: 'level-up' },
  { name: 'LevelUp', event: decodeEvent({ _tag: 'LevelUp', tick: 1, entity: 'actor', position: at, level: 2 }), kind: 'level-up' },
  { name: 'ItemDropped', event: decodeEvent({ _tag: 'ItemDropped', tick: 1, droppedItem: 'drop', item: 1, count: 1, position: at }), kind: 'block-break' },
  { name: 'ItemPickedUp', event: decodeEvent({ _tag: 'ItemPickedUp', tick: 1, actor: 'actor', source: { _tag: 'DroppedItem', id: 'drop' }, item: 1, count: 1 }), kind: 'level-up' },
  { name: 'ItemConsumed', event: decodeEvent({ _tag: 'ItemConsumed', tick: 1, actor: 'actor', item: 1, count: 1, use: 'food' }), kind: 'level-up' },
  { name: 'ExperienceCollected', event: decodeEvent({ _tag: 'ExperienceCollected', tick: 1, player: 'actor', orb: 'orb', amount: 2 }), kind: 'level-up' },
  { name: 'WeatherGameplayEffect/LightningStrike', event: decodeEvent({ _tag: 'WeatherGameplayEffect', tick: 1, effect: { _tag: 'LightningStrike', position: at } }), kind: 'explosion' },
  { name: 'WeatherGameplayEffect/CreeperCharged', event: decodeEvent({ _tag: 'WeatherGameplayEffect', tick: 1, effect: { _tag: 'CreeperCharged', entity: 'actor' } }), kind: 'explosion' },
  { name: 'WeatherGameplayEffect/EntityTransformed', event: decodeEvent({ _tag: 'WeatherGameplayEffect', tick: 1, effect: { _tag: 'EntityTransformed', entity: 'actor', kind: 'witch' } }), kind: 'level-up' },
  { name: 'ProjectileLaunched', event: decodeEvent({ _tag: 'ProjectileLaunched', tick: 1, projectile: 'arrow', shooter: 'actor', origin: at, initialVelocity: { x: 2, y: 1, z: -1 } }), kind: 'entity-hit' },
  { name: 'ProjectileImpacted/Block', event: decodeEvent({ _tag: 'ProjectileImpacted', tick: 1, projectile: 'arrow', position: at, hit: { _tag: 'Block', address } }), kind: 'entity-hit' },
  { name: 'ProjectileImpacted/Entity', event: decodeEvent({ _tag: 'ProjectileImpacted', tick: 1, projectile: 'arrow', position: at, hit: { _tag: 'Entity', entity: 'actor' } }), kind: 'entity-hit' },
  { name: 'ShieldBlocked', event: decodeEvent({ _tag: 'ShieldBlocked', tick: 1, defender: 'actor', position: at, blockedAmount: 2 }), kind: 'entity-hit' },
]

afterEach(() => vi.clearAllMocks())

describe('particle runtime', () => {
  it.each(cases)('spawns $name through the public service', ({ event, kind }) => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const runtime = makeParticleRuntime(pool, { renderContext: () => frame })
    const outcomes = Effect.runSync(runtime.spawnEvents([event]))
    expect(outcomes).toEqual([{ event, result: Result.succeed('spawned') }])
    expect(pool.activeCount()).toBe(Render.PARTICLE_KIND_DEFAULTS[kind].particleCount)
    expect(pool.dimensions[0]).toBe('nether')
    expect(pool.positions.slice(0, 3)).toEqual(new Float32Array([
      event._tag === 'BlockBroken' || event._tag === 'BlockPlaced' || event._tag === 'BlockChangedByWorld' ? 3.5 : 3,
      event._tag === 'BlockBroken' || event._tag === 'BlockPlaced' || event._tag === 'BlockChangedByWorld' ? 65.5 : 65,
      event._tag === 'BlockBroken' || event._tag === 'BlockPlaced' || event._tag === 'BlockChangedByWorld' ? -1.5 : -2,
    ]))
  })

  it('ignores UI and vehicle events and missing entity positions without spawning', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const events = [achievement, decodeEvent({ _tag: 'VehicleTransition', tick: 1, actor: 'actor', vehicle: 'boat', transition: 'mounted' }), healed]
    const runtime = makeParticleRuntime(pool, { renderContext: () => ({ dimension: 'nether', entities: [] }) })
    expect(Effect.runSync(runtime.spawnEvents(events))).toEqual(events.map((event) => ({ event, result: Result.succeed('ignored') })))
    expect(pool.activeCount()).toBe(0)
  })

  it('returns UnhandledParticleEvent unchanged and continues with later events', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const unhandled: Render.UnhandledParticleEvent = { _tag: 'UnhandledParticleEvent', eventTag: 'future-event' }
    // All current kernel tags are mapped; exercise the mapper's public result contract.
    const mapping = vi.mocked(Render.particleRequestForDomainEvent).mockReturnValueOnce(unhandled)
    const outcomes = Effect.runSync(makeParticleRuntime(pool, { renderContext: () => frame }).spawnEvents([broken, hurt]))
    expect(mapping).toHaveBeenCalledTimes(2)
    expect(outcomes[0]?.result).toEqual(Result.fail(unhandled))
    const first = outcomes[0]?.result
    if (first !== undefined && Result.isFailure(first)) expect(first.failure).toBe(unhandled)
    expect(outcomes[1]?.result).toEqual(Result.succeed('spawned'))
    expect(pool.activeCount()).toBe(Render.PARTICLE_KIND_DEFAULTS['entity-hit'].particleCount)
  })

  it.each([
    { name: 'different dimension', renderContext: (): Render.ParticleFrameSnapshot => ({ dimension: 'end', entities: frame.entities }), event: broken },
    { name: 'missing follow target', renderContext: (): Render.ParticleFrameSnapshot => ({ dimension: 'nether', entities: [] }), event: hurt },
  ])('reports PARTICLE_REQUEST_REJECTED for $name', ({ renderContext, event }) => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const outcomes = Effect.runSync(makeParticleRuntime(pool, { renderContext }).spawnEvents([event]))
    const result = outcomes[0]?.result
    expect(result).toEqual(Result.fail({
      _tag: 'ParticleRequestRejected', request: Render.particleRequestForDomainEvent(event),
    }))
    expect(pool.activeCount()).toBe(0)
  })

  it.each([
    { name: 'throwing getter', renderContext: (): Render.ParticleFrameSnapshot => { throw new Error('snapshot unavailable') }, reason: 'render-context-failed' },
    { name: 'nonfinite target', renderContext: (): Render.ParticleFrameSnapshot => ({ dimension: 'nether', entities: [{ id: 'actor', feetPosition: { x: Number.NaN, y: 65, z: -2 } }] }), reason: 'invalid-frame' },
    { name: 'extra entity properties', renderContext: () => ({ dimension: frame.dimension, entities: [{ ...frame.entities[0], id: 'actor', feetPosition: { x: 3, y: 65, z: -2 }, health: 20 }] }), reason: 'invalid-frame' },
  ])('returns typed context failure for $name', ({ renderContext, reason }) => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const events = [healed, broken]
    const outcomes = Effect.runSync(makeParticleRuntime(pool, { renderContext }).spawnEvents(events))
    expect(outcomes).toEqual(events.map((event) => ({ event, result: Result.fail({
      _tag: 'ParticlePoolInputError', operation: 'render-context', reason,
    }) })))
    expect(pool.activeCount()).toBe(0)
  })

  it('preserves the real spawn failure and processes the next event', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const invalid = decodeEvent({ _tag: 'EntityDied', tick: 1, entity: 'actor', kind: 'zombie', position: { ...at, x: Number.MAX_VALUE }, cause: 'mob' })
    const outcomes = Effect.runSync(makeParticleRuntime(pool, { renderContext: () => frame }).spawnEvents([invalid, broken]))
    expect(outcomes[0]?.result).toEqual(Result.fail({ _tag: 'ParticlePoolInputError', operation: 'request', reason: 'invalid-request' }))
    expect(outcomes[1]?.result).toEqual(Result.succeed('spawned'))
    expect(pool.activeCount()).toBe(Render.PARTICLE_KIND_DEFAULTS['block-break'].particleCount)
  })

  it('uses the live dimension and entity position on every call', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    let current = frame
    const runtime = makeParticleRuntime(pool, { renderContext: () => current })
    expect(Effect.runSync(runtime.spawnEvents([healed]))[0]?.result).toEqual(Result.succeed('spawned'))
    current = { dimension: 'end', entities: [{ id: 'actor', feetPosition: { x: 12, y: 75, z: -8 } }] }
    expect(Effect.runSync(runtime.spawnEvents([healed]))[0]?.result).toEqual(Result.succeed('spawned'))
    const firstNew = Render.PARTICLE_KIND_DEFAULTS['level-up'].particleCount
    expect(pool.dimensions[firstNew]).toBe('end')
    expect(pool.positions.slice(firstNew * 3, firstNew * 3 + 3)).toEqual(new Float32Array([12, 75, -8]))
  })

  it('clamps a burst to pool capacity and evicts the oldest particles when full', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool({ capacity: 3 }))
    const runtime = makeParticleRuntime(pool, { renderContext: () => frame })
    expect(Effect.runSync(runtime.spawnEvents([broken]))[0]?.result).toEqual(Result.succeed('spawned'))
    expect(pool.activeCount()).toBe(3)
    expect(pool.evictionCount()).toBe(0)
    expect(Effect.runSync(runtime.spawnEvents([hurt]))[0]?.result).toEqual(Result.succeed('spawned'))
    expect(pool.activeCount()).toBe(3)
    expect(pool.evictionCount()).toBe(3)
    expect(pool.followEntityIds).toEqual(['actor', 'actor', 'actor'])
    expect(pool.positions).toEqual(new Float32Array([3, 65, -2, 3, 65, -2, 3, 65, -2]))
  })

  it('produces identical pool state and ordered outcomes for identical inputs', () => {
    const pools = [Result.getOrThrow(Render.makeParticlePool({ seed: 123 })), Result.getOrThrow(Render.makeParticlePool({ seed: 123 }))]
    const events = [broken, achievement, hurt, healed]
    const outcomes = pools.map((pool) => Effect.runSync(makeParticleRuntime(pool, { renderContext: () => frame }).spawnEvents(events)))
    expect(outcomes[0]).toEqual(outcomes[1])
    expect(outcomes[0]?.map((outcome) => outcome.event)).toEqual(events)
    expect(pools[0]?.positions).toEqual(pools[1]?.positions)
    expect(pools[0]?.velocities).toEqual(pools[1]?.velocities)
    expect(pools[0]?.colors).toEqual(pools[1]?.colors)
    expect(pools[0]?.seed()).toBe(pools[1]?.seed())
  })

  it('does not read context for an empty event sequence', () => {
    const renderContext = vi.fn(() => frame)
    const runtime = makeParticleRuntime(Result.getOrThrow(Render.makeParticlePool()), { renderContext })
    expect(Effect.runSync(runtime.spawnEvents([]))).toEqual([])
    expect(renderContext).not.toHaveBeenCalled()
  })

  it('makes particles from the production renderer pool drawable after sync', () => {
    class GpuSurface {
      render = vi.fn<() => void>()
      setSize = vi.fn<() => void>()
      setClearColor = vi.fn<() => void>()
      dispose = vi.fn<() => void>()
    }
    const renderer = Effect.runSync(Render.makeProductionWorldRenderer<
      object, THREE.BufferGeometry<THREE.NormalBufferAttributes>, THREE.MeshBasicMaterial,
      THREE.InstancedBufferGeometry, THREE.ShaderMaterial
    >(
      { ...THREE, WebGLRenderer: GpuSurface }, {}, { width: 640, height: 480 }, new THREE.Texture(),
    ))
    try {
      const runtime = makeParticleRuntime(renderer.particlePool, { renderContext: () => frame })
      expect(Effect.runSync(renderer.particles.drawnInstances)).toBe(0)
      expect(Effect.runSync(runtime.spawnEvents([broken]))[0]?.result).toEqual(Result.succeed('spawned'))
      expect(renderer.particlePool.activeCount()).toBe(Render.PARTICLE_KIND_DEFAULTS['block-break'].particleCount)
      expect(Effect.runSync(renderer.particles.drawnInstances)).toBe(0)
      Effect.runSync(renderer.particles.sync)
      expect(Effect.runSync(renderer.particles.drawnInstances)).toBe(renderer.particlePool.activeCount())
      expect(renderer.particles.mesh).toBeInstanceOf(THREE.Mesh)
      expect(renderer.particles.mesh).toHaveProperty('parent', expect.any(THREE.Scene))
      expect(renderer.particles.mesh).toHaveProperty('geometry.instanceCount', renderer.particlePool.activeCount())
    } finally {
      Effect.runSync(renderer.dispose)
    }
  })
})
