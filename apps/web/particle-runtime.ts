import { type DomainEvent, WorldPositionSchema } from '@nerima-games/mc-kernel'
import {
  ParticleFrameSnapshotSchema, ParticleService, ParticleServiceForPool,
  particleRequestForDomainEvent,
  type ParticleFrameSnapshot, type ParticlePool, type ParticlePoolInputError,
  type ParticleRequest, type UnhandledParticleEvent,
} from '@nerima-games/mc-render'
import { Effect, Result, Schema } from 'effect'

export type ParticleRequestRejected = Readonly<{
  _tag: 'ParticleRequestRejected'
  request: ParticleRequest
}>

export type ParticleEventFailure =
  | UnhandledParticleEvent
  | ParticlePoolInputError
  | ParticleRequestRejected

export type ParticleEventOutcome = Readonly<{
  event: DomainEvent
  result: Result.Result<'spawned' | 'ignored', ParticleEventFailure>
}>

export type ParticleRuntime = Readonly<{
  spawnEvents: (events: ReadonlyArray<DomainEvent>) => Effect.Effect<ReadonlyArray<ParticleEventOutcome>>
}>

export type ParticleRuntimeOptions = Readonly<{
  renderContext: () => ParticleFrameSnapshot
}>

const readFrame = (read: () => ParticleFrameSnapshot): Effect.Effect<ParticleFrameSnapshot, ParticlePoolInputError> =>
  Effect.try({
    try: read,
    catch: (): ParticlePoolInputError => ({
      _tag: 'ParticlePoolInputError', operation: 'render-context', reason: 'render-context-failed',
    }),
  }).pipe(Effect.flatMap((frame) => {
    // Entity lookup reads this snapshot before spawn, so validate at that boundary too.
    const decoded = Schema.decodeUnknownResult(ParticleFrameSnapshotSchema, { onExcessProperty: 'error' })(frame)
    return Result.isSuccess(decoded)
      ? Effect.succeed(decoded.success)
      : Effect.fail<ParticlePoolInputError>({
        _tag: 'ParticlePoolInputError', operation: 'render-context', reason: 'invalid-frame',
      })
  }))

export const makeParticleRuntime = (pool: ParticlePool, options: ParticleRuntimeOptions): ParticleRuntime => ({
  spawnEvents: (events) => Effect.forEach(events, (event) => Effect.gen(function* () {
    const result = yield* Effect.result(Effect.gen(function* () {
      const frame = yield* readFrame(options.renderContext)
      const request = particleRequestForDomainEvent(event, {
        positionOfEntity: (id) => {
          const entity = frame.entities.find((target) => target.id === id)
          // The validated frame restricts dimension and finite coordinates more tightly than WorldPositionSchema.
          return entity === undefined ? undefined : Schema.decodeUnknownSync(WorldPositionSchema)({
            dimension: frame.dimension, ...entity.feetPosition,
          })
        },
      })
      if (request === undefined) return yield* Effect.succeed<'ignored'>('ignored')
      if ('_tag' in request) return yield* Effect.fail(request)
      return yield* Effect.gen(function* () {
        const particles = yield* ParticleService
        const accepted = yield* particles.spawn(request)
        // mc-render declares PARTICLE_REQUEST_REJECTED as 0 but does not export the constant.
        if (accepted === 0) return yield* Effect.fail<ParticleRequestRejected>({ _tag: 'ParticleRequestRejected', request })
        return yield* Effect.succeed<'spawned'>('spawned')
      }).pipe(Effect.provide(ParticleServiceForPool(pool, { renderContext: () => frame })))
    }))
    return { event, result }
  })),
})
