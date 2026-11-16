import { describe, expect, it, vi } from 'vitest'

// Persistence decoding belongs to H8; these tests exercise QA composition and transport.
vi.mock('../apps/web/session-persistence', () => ({ SESSION_FORMAT_VERSION: 3 }))
import { Effect, Layer, Result, Schema } from 'effect'
import { QaNamespaceNameSchema, QaOperationNameSchema, WorldIdSchema, itemStack, StackCount } from '@nerima-games/mc-kernel'
import { makeWeatherService, makeBrewingService, makeBrewingServiceRegistration, makeReplicatedOwnerId, makeWorldCommitCoordinator, brewingState } from '@nerima-games/mc-sim'
import { weatherLightScale } from '@nerima-games/mx-gameplay'
import { composeGame, QA_GLOBAL_KEY } from '@nerima-games/mc-compose'
import { installQaDispatch, makeQaNamespaces, makeQaRenderCommands, makeQaWeatherCommand, observeQaBrewing, type QaDispatchTransport } from '../apps/web/qa-surface'

const namespaceName = Schema.decodeUnknownSync(QaNamespaceNameSchema)
const operationName = Schema.decodeUnknownSync(QaOperationNameSchema)

const makeBridge = (namespaces: ReturnType<typeof makeQaNamespaces>) =>
  Effect.runSync(composeGame(namespaces.map((qa) => ({
    name: qa.name,
    layers: Layer.empty,
    frameStages: [],
    qa,
  })))).qaBridge

const install = (namespaces: ReturnType<typeof makeQaNamespaces>) => {
  const target: { [QA_GLOBAL_KEY]?: QaDispatchTransport } = {}
  const dispose = installQaDispatch(target, makeBridge(namespaces))
  const transport = target[QA_GLOBAL_KEY]
  if (transport === undefined) throw new Error('QA transport was not installed')
  return { target, dispose, transport }
}

describe('C1 QA dispatch transport', () => {
  it('preserves the real lighting observe and weather command outputs', async () => {
    const weather = Effect.runSync(makeWeatherService({ weather: 'clear', remainingSecs: 120 }))
    const lighting = { resolvedChunks: 2, sampledQuads: 3, darkestShade: 0.2, brightestShade: 1, lastChunk: { cx: 0, cz: 1 } }
    const render = makeQaRenderCommands({ weather, getLightingSnapshot: () => lighting })
    let dirtyCount = 0
    let presented: unknown
    const snapshot = () => Effect.runSync(weather.snapshot)
    const command = makeQaWeatherCommand({
      weather,
      presentWeather: (state) => { presented = state },
      markSessionDirty: () => { dirtyCount += 1 },
      snapshot,
    })
    const { transport } = install(makeQaNamespaces([
      { namespace: 'render', commands: render },
      { namespace: 'gameplay', commands: { setWeather: command } },
    ]))
    expect(await transport.dispatch(namespaceName('render'), operationName('snapshotLighting'), null))
      .toEqual({ _tag: 'Success', value: { ...lighting, weatherBrightness: weatherLightScale('clear') } })
    expect(await transport.dispatch(namespaceName('gameplay'), operationName('setWeather'), null))
      .toEqual({ _tag: 'Success', value: { weather: 'thunder', remainingSecs: 300 } })
    expect(presented).toEqual({ weather: 'thunder', remainingSecs: 300 })
    expect(dirtyCount).toBe(1)
    expect(await transport.dispatch(namespaceName('render'), operationName('snapshotLighting'), null))
      .toEqual({ _tag: 'Success', value: { ...lighting, weatherBrightness: weatherLightScale('thunder') } })
  })

  it('publishes the complete public brewing state without projecting to the old single bottle shape', async () => {
    const bottle = Result.getOrThrow(itemStack('water_bottle', StackCount(1)))
    const ingredient = Result.getOrThrow(itemStack('nether_wart', StackCount(2)))
    const publicState = Result.getOrThrow(brewingState({
      bottles: [bottle, undefined, bottle], ingredient, fuelCharges: 2, brewProgressSecs: 5,
    }))
    const ownerId = makeReplicatedOwnerId('qa-brewing')
    const registration = Result.getOrThrow(makeBrewingServiceRegistration(ownerId, publicState))
    const coordinator = Effect.runSync(makeWorldCommitCoordinator({
      world: Schema.decodeUnknownSync(WorldIdSchema)('qa'), owners: [registration],
    }))
    const service = Effect.runSync(makeBrewingService(ownerId))
    const snapshot = () => ({ brewing: Effect.runSync(observeQaBrewing(service, coordinator)) })
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', commands: { snapshot } }]))
    const result = await transport.dispatch(namespaceName('gameplay'), operationName('snapshot'), null)
    expect(result).toEqual({ _tag: 'Success', value: JSON.parse(JSON.stringify({ brewing: publicState })) })
    expect(publicState.bottles[2]).toEqual(bottle)
    expect(publicState.brewProgressSecs).toBe(5)
  })

  it('preserves observe and command JSON outputs and optional setPose input', async () => {
    let block = 1
    const snapshot = () => ({ block, nested: { absent: undefined }, values: [1, 'ready'] })
    const setPose = (value?: number) => {
      if (value !== undefined) block = value
      return snapshot()
    }
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', commands: { snapshot, setPose } }]))
    const dispatch = (operation: string, input: unknown) => transport.dispatch(namespaceName('gameplay'), operationName(operation), input)

    expect(await dispatch('snapshot', null)).toEqual({ _tag: 'Success', value: JSON.parse(JSON.stringify(snapshot())) })
    expect(await dispatch('setPose', 7)).toEqual({ _tag: 'Success', value: JSON.parse(JSON.stringify(snapshot())) })
    expect(block).toBe(7)
    expect(await dispatch('setPose', null)).toEqual({ _tag: 'Success', value: JSON.parse(JSON.stringify(snapshot())) })
  })

  it('returns unknown namespace and operation failures as JSON', async () => {
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', commands: { snapshot: () => ({ ready: true }) } }]))
    for (const [namespace, operation] of [['missing', 'snapshot'], ['gameplay', 'missing']]) {
      const result = await transport.dispatch(namespaceName(namespace), operationName(operation), null)
      expect(JSON.parse(JSON.stringify(result))).toEqual({
        _tag: 'Failure',
        error: { _tag: 'QaOperationNotFound', namespace, operation },
      })
    }
  })

  it('preserves registered failures and rejects invalid input before a command runs', async () => {
    const failure = { _tag: 'QaFixtureRejected', reason: 'fixture unavailable' }
    let calls = 0
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', commands: {
      setPose: () => { calls += 1; throw failure },
    } }]))
    const result = await transport.dispatch(namespaceName('gameplay'), operationName('setPose'), 1)
    expect(JSON.parse(JSON.stringify(result))).toEqual({ _tag: 'Failure', error: failure })
    expect(calls).toBe(1)
    const invalid = await transport.dispatch(namespaceName('gameplay'), operationName('setPose'), 'invalid')
    expect(invalid).toMatchObject({ _tag: 'Failure', error: { _tag: 'SchemaError' } })
    expect(calls).toBe(1)
  })

  it('preserves tagged Error fields from synchronous Effect failures', async () => {
    const failure = Object.assign(new Error('fixture unavailable'), {
      _tag: 'QaFixtureRejected',
      code: 'FIXTURE_UNAVAILABLE',
      reason: 'world stopped',
    })
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', commands: {
      setPose: () => Effect.runSync(Effect.fail(failure)),
    } }]))
    const result = await transport.dispatch(namespaceName('gameplay'), operationName('setPose'), 1)
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      _tag: 'Failure',
      error: { _tag: 'QaFixtureRejected', code: 'FIXTURE_UNAVAILABLE', reason: 'world stopped', message: 'fixture unavailable' },
    })
  })

  it('keeps async command outputs and failures in the dispatch result', async () => {
    const failure = { _tag: 'FlushRejected', reason: 'storage unavailable' }
    const { transport } = install(makeQaNamespaces([{ namespace: 'persistence', commands: {
      flush: async () => ({ flushed: true }),
      reject: async () => { throw failure },
    } }]))
    expect(await transport.dispatch(namespaceName('persistence'), operationName('flush'), null))
      .toEqual({ _tag: 'Success', value: { flushed: true } })
    expect(await transport.dispatch(namespaceName('persistence'), operationName('reject'), null))
      .toEqual({ _tag: 'Failure', error: failure })
  })

  it('removes the transport on teardown and invalidates retained dispatch functions', async () => {
    let calls = 0
    const { target, transport, dispose } = install(makeQaNamespaces([{ namespace: 'gameplay', commands: {
      snapshot: () => { calls += 1; return { ready: true } },
    } }]))
    await transport.dispatch(namespaceName('gameplay'), operationName('snapshot'), null)
    dispose()
    dispose()
    expect(target[QA_GLOBAL_KEY]).toBeUndefined()
    expect(await transport.dispatch(namespaceName('gameplay'), operationName('snapshot'), null))
      .toEqual({ _tag: 'Failure', error: { _tag: 'QaOperationNotFound', namespace: 'gameplay', operation: 'snapshot' } })
    expect(calls).toBe(1)
  })

  it('does not remove a newer session transport when an older session tears down', async () => {
    const target: { [QA_GLOBAL_KEY]?: QaDispatchTransport } = {}
    const bridge = makeBridge(makeQaNamespaces([{ namespace: 'gameplay', commands: { snapshot: () => 1 } }]))
    const disposeFirst = installQaDispatch(target, bridge)
    installQaDispatch(target, bridge)
    const current = target[QA_GLOBAL_KEY]
    disposeFirst()
    expect(target[QA_GLOBAL_KEY]).toBe(current)
    expect(await current?.dispatch(namespaceName('gameplay'), operationName('snapshot'), null))
      .toEqual({ _tag: 'Success', value: 1 })
  })

  it('keeps duplicate namespace composition failures typed', () => {
    const namespaces = makeQaNamespaces([
      { namespace: 'gameplay', commands: { snapshot: () => 1 } },
      { namespace: 'gameplay', commands: { snapshot: () => 2 } },
    ])
    const result = Effect.runSync(Effect.result(composeGame(namespaces.map((qa) => ({
      name: qa.name, layers: Layer.empty, frameStages: [], qa,
    })))))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toMatchObject({ _tag: 'DuplicateModuleContract', kind: 'qa-namespace', id: 'gameplay' })
  })
})
