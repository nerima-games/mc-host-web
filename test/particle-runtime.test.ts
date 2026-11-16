import { DomainEventSchema, WorldPositionSchema } from '@nerima-games/mc-kernel'
import * as Render from '@nerima-games/mc-render'
import { Effect, Option, Result, Schema } from 'effect'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

import { makeParticleRuntime } from '../apps/web/particle-runtime'

const decodeEvent = Schema.decodeUnknownSync(DomainEventSchema)
const at = { dimension: 'nether', x: 3, y: 65, z: -2 }
const address = { dimension: 'nether', position: { x: 3, y: 65, z: -2 } }
const frame: Render.ParticleFrameSnapshot = {
  dimension: 'nether', entities: [{ id: 'actor', feetPosition: { x: 3, y: 65, z: -2 } }],
}
const broken = decodeEvent({ _tag: 'BlockBroken', tick: 1, actor: 'actor', address, block: 1 })
const hurt = decodeEvent({ _tag: 'EntityDamaged', tick: 1, entity: 'actor', position: at, amount: 1, cause: 'mob' })
const healed = decodeEvent({ _tag: 'EntityHealed', tick: 1, entity: 'actor', amount: 1, cause: 'regeneration' })
const missingHealed = decodeEvent({ _tag: 'EntityHealed', tick: 1, entity: 'missing', amount: 1, cause: 'regeneration' })
const achievement = decodeEvent({ _tag: 'AchievementUnlocked', tick: 1, player: 'actor', achievement: 'minecraft:story/root' })
const invalid = decodeEvent({ _tag: 'EntityDied', tick: 1, entity: 'actor', kind: 'zombie', position: { ...at, x: Number.MAX_VALUE }, cause: 'mob' })

describe('particle runtime', () => {
  it.each([
    { name: 'block position', event: broken },
    { name: 'snapshot position', event: healed },
    { name: 'entity follower', event: hurt },
  ])('matches the real mapper and service for a $name event', ({ event }) => {
    const pool = Result.getOrThrow(Render.makeParticlePool({ seed: 123 }))
    const reference = Result.getOrThrow(Render.makeParticlePool({ seed: 123 }))
    const outcomes = Effect.runSync(makeParticleRuntime(pool, { renderContext: () => frame }).spawnEvents([event]))
    const request = Render.particleRequestForDomainEvent(event, {
      positionOfEntity: () => Schema.decodeUnknownSync(WorldPositionSchema)(at),
    })
    if (request === undefined || '_tag' in request) throw new Error('Fixture must produce a particle request')
    expect(Effect.runSync(Effect.gen(function* () {
      const service = yield* Render.ParticleService
      return yield* service.spawn(request)
    }).pipe(Effect.provide(Render.ParticleServiceForPool(reference, { renderContext: () => frame }))))).toBe(1)
    expect(outcomes).toEqual([{ event, result: Result.succeed('spawned') }])
    expect(pool.activeCount()).toBeGreaterThan(0)
    expect(pool.activeCount()).toBe(reference.activeCount())
    expect(pool.positions).toEqual(reference.positions)
    expect(pool.velocities).toEqual(reference.velocities)
    expect(pool.colors).toEqual(reference.colors)
    expect(pool.dimensions).toEqual(reference.dimensions)
    expect(pool.followEntityIds).toEqual(reference.followEntityIds)
  })

  it('ignores intentional UI and vehicle events without spawning', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const events = [achievement, decodeEvent({ _tag: 'VehicleTransition', tick: 1, actor: 'actor', vehicle: 'boat', transition: 'mounted' })]
    const runtime = makeParticleRuntime(pool, { renderContext: () => ({ dimension: 'nether', entities: [] }) })
    expect(Effect.runSync(runtime.spawnEvents(events))).toEqual(events.map((event) => ({ event, result: Result.succeed('ignored') })))
    expect(pool.activeCount()).toBe(0)
  })

  it('fails the batch when an entity position lookup misses its snapshot target', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const runtime = makeParticleRuntime(pool, { renderContext: () => frame })
    const result = Effect.runSync(Effect.result(runtime.spawnEvents([missingHealed])))
    const failure = Option.getOrThrow(Result.getFailure(result))
    const missing = { _tag: 'ParticleEntityMissing', entityId: 'missing' }
    expect(failure).toEqual({
      _tag: 'ParticleEventBatchFailure', failures: [{ event: missingHealed, failure: missing }],
      outcomes: [{ event: missingHealed, result: Result.fail(missing) }],
    })
    expect(pool.activeCount()).toBe(0)
  })

  it.each([
    { name: 'different dimension', renderContext: (): Render.ParticleFrameSnapshot => ({ dimension: 'end', entities: frame.entities }), event: broken },
    { name: 'missing follow target', renderContext: (): Render.ParticleFrameSnapshot => ({ dimension: 'nether', entities: [] }), event: hurt },
  ])('fails the effect for PARTICLE_REQUEST_REJECTED with $name', ({ renderContext, event }) => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const result = Effect.runSync(Effect.result(makeParticleRuntime(pool, { renderContext }).spawnEvents([event])))
    const failure = Option.getOrThrow(Result.getFailure(result))
    const rejection = { _tag: 'ParticleRequestRejected', request: Render.particleRequestForDomainEvent(event) }
    expect(failure).toEqual({
      _tag: 'ParticleEventBatchFailure', failures: [{ event, failure: rejection }],
      outcomes: [{ event, result: Result.fail(rejection) }],
    })
    expect(pool.activeCount()).toBe(0)
  })

  it.each([
    { name: 'throwing getter', renderContext: (): Render.ParticleFrameSnapshot => { throw new Error('snapshot unavailable') }, reason: 'render-context-failed' },
    { name: 'nonfinite target', renderContext: (): Render.ParticleFrameSnapshot => ({ dimension: 'nether', entities: [{ id: 'actor', feetPosition: { x: Number.NaN, y: 65, z: -2 } }] }), reason: 'invalid-frame' },
    { name: 'extra entity properties', renderContext: () => ({ dimension: frame.dimension, entities: [{ id: 'actor', feetPosition: { x: 3, y: 65, z: -2 }, health: 20 }] }), reason: 'invalid-frame' },
  ])('fails the effect with typed context failures for $name', ({ renderContext, reason }) => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const events = [healed, broken]
    const result = Effect.runSync(Effect.result(makeParticleRuntime(pool, { renderContext }).spawnEvents(events)))
    const failure = Option.getOrThrow(Result.getFailure(result))
    const contextFailure = { _tag: 'ParticlePoolInputError', operation: 'render-context', reason }
    expect(failure).toEqual({
      _tag: 'ParticleEventBatchFailure', failures: events.map((event) => ({ event, failure: contextFailure })),
      outcomes: events.map((event) => ({ event, result: Result.fail(contextFailure) })),
    })
    expect(pool.activeCount()).toBe(0)
  })

  it('aggregates real failures in event order after processing later successes', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    const rejected = decodeEvent({ _tag: 'EntityDamaged', tick: 1, entity: 'missing', position: at, amount: 1, cause: 'mob' })
    const events = [invalid, rejected, missingHealed, achievement, broken]
    const result = Effect.runSync(Effect.result(makeParticleRuntime(pool, { renderContext: () => frame }).spawnEvents(events)))
    const failure = Option.getOrThrow(Result.getFailure(result))
    const spawnFailure = { _tag: 'ParticlePoolInputError', operation: 'request', reason: 'invalid-request' }
    const rejection = { _tag: 'ParticleRequestRejected', request: Render.particleRequestForDomainEvent(rejected) }
    const missing = { _tag: 'ParticleEntityMissing', entityId: 'missing' }
    expect(failure).toEqual({
      _tag: 'ParticleEventBatchFailure',
      failures: [{ event: invalid, failure: spawnFailure }, { event: rejected, failure: rejection }, { event: missingHealed, failure: missing }],
      outcomes: [
        { event: invalid, result: Result.fail(spawnFailure) },
        { event: rejected, result: Result.fail(rejection) },
        { event: missingHealed, result: Result.fail(missing) },
        { event: achievement, result: Result.succeed('ignored') },
        { event: broken, result: Result.succeed('spawned') },
      ],
    })
    expect(pool.activeCount()).toBeGreaterThan(0)
    expect(pool.followEntityIds.every((id) => id === undefined)).toBe(true)
  })

  it('uses the live dimension and entity position on every call', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool())
    let current = frame
    const runtime = makeParticleRuntime(pool, { renderContext: () => current })
    expect(Effect.runSync(runtime.spawnEvents([healed]))[0]?.result).toEqual(Result.succeed('spawned'))
    const firstNew = pool.activeCount()
    current = { dimension: 'end', entities: [{ id: 'actor', feetPosition: { x: 12, y: 75, z: -8 } }] }
    expect(Effect.runSync(runtime.spawnEvents([healed]))[0]?.result).toEqual(Result.succeed('spawned'))
    expect(pool.activeCount()).toBeGreaterThan(firstNew)
    expect(pool.dimensions[firstNew]).toBe('end')
    expect(pool.positions.slice(firstNew * 3, firstNew * 3 + 3)).toEqual(new Float32Array([12, 75, -8]))
  })

  it('clamps a burst to pool capacity and evicts the oldest particle when full', () => {
    const pool = Result.getOrThrow(Render.makeParticlePool({ capacity: 1 }))
    const runtime = makeParticleRuntime(pool, { renderContext: () => frame })
    expect(Effect.runSync(runtime.spawnEvents([broken]))[0]?.result).toEqual(Result.succeed('spawned'))
    expect(pool.activeCount()).toBe(1)
    expect(pool.evictionCount()).toBe(0)
    expect(Effect.runSync(runtime.spawnEvents([hurt]))[0]?.result).toEqual(Result.succeed('spawned'))
    expect(pool.activeCount()).toBe(1)
    expect(pool.evictionCount()).toBe(1)
    expect(pool.followEntityIds).toEqual(['actor'])
    expect(pool.positions).toEqual(new Float32Array([3, 65, -2]))
  })

  it('returns ordered successful outcomes and identical state for identical inputs', () => {
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

  it('succeeds without reading context for an empty event sequence', () => {
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
      expect(renderer.particlePool.activeCount()).toBeGreaterThan(0)
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
