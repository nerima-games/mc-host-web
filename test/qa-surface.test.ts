import { describe, expect, it, vi } from 'vitest'

// These tests exercise QA composition and transport.
vi.mock('../apps/web/session-persistence', () => ({ SESSION_FORMAT_VERSION: 3 }))
import { Effect, Layer, Result, Schema } from 'effect'
import { QaNamespaceNameSchema, QaOperationNameSchema, ModuleContractIdSchema, ModuleContractKindSchema, WorldIdSchema, itemStack, StackCount } from '@nerima-games/mc-kernel'
import { makeWeatherService, makeBrewingService, makeBrewingServiceRegistration, makeReplicatedOwnerId, makeWorldCommitCoordinator, brewingState } from '@nerima-games/mc-sim'
import {
  GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
  GameplayVillagerTradeSnapshotSchema,
  addVillager,
  emptyVillagerTradeState,
  gameplayOwnerRegistrations,
  makeVillager,
  useVillagerOffer,
  weatherLightScale,
  type VillagerTradeState,
} from '@nerima-games/mx-gameplay'
import { composeGame, DuplicateModuleContract, QA_GLOBAL_KEY } from '@nerima-games/mc-compose'
import { composeQaBridge, installQaDispatch, makeQaNamespaces, makeQaOperation, makeQaSurface, makeQaRenderCommands, makeQaWeatherCommand, observeQaBrewing, seedQaVillagerRestock, type QaDispatchTransport } from '../apps/web/qa-surface'

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
    const { transport } = install(makeQaNamespaces([{ namespace: 'render', observe: { snapshotLighting: makeQaOperation('snapshotLighting', Schema.Null, () => render.snapshotLighting()) }, command: {  } },
      { namespace: 'gameplay', observe: {  }, command: { setWeather: makeQaOperation('setWeather', Schema.Null, command) } }]))
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
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', observe: { snapshot: makeQaOperation('snapshot', Schema.Null, snapshot) }, command: {  } }]))
    const result = await transport.dispatch(namespaceName('gameplay'), operationName('snapshot'), null)
    expect(result).toEqual({ _tag: 'Success', value: JSON.parse(JSON.stringify({ brewing: publicState })) })
    expect(result).toMatchObject({
      _tag: 'Success',
      value: { brewing: { bottles: [{ item: 'water_bottle', count: 1 }, null, { item: 'water_bottle', count: 1 }], brewProgressSecs: 5 } },
    })
  })

  it('preserves observe and command JSON outputs and optional setPose input', async () => {
    let block = 1
    const snapshot = () => ({ block, nested: { absent: undefined }, values: [1, 'ready'] })
    const setPose = (value?: number) => {
      if (value !== undefined) block = value
      return snapshot()
    }
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', observe: { snapshot: makeQaOperation('snapshot', Schema.Null, snapshot) }, command: { setPose: makeQaOperation('setPose', Schema.NullOr(Schema.Number), (value) => setPose(value === null ? undefined : value)) } }]))
    const dispatch = (operation: string, input: unknown) => transport.dispatch(namespaceName('gameplay'), operationName(operation), input)

    expect(await dispatch('snapshot', null)).toEqual({ _tag: 'Success', value: JSON.parse(JSON.stringify(snapshot())) })
    expect(await dispatch('setPose', 7)).toEqual({ _tag: 'Success', value: JSON.parse(JSON.stringify(snapshot())) })
    expect(block).toBe(7)
    expect(await dispatch('setPose', null)).toEqual({ _tag: 'Success', value: JSON.parse(JSON.stringify(snapshot())) })
  })

  it('returns unknown namespace and operation failures as JSON', async () => {
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', observe: { snapshot: makeQaOperation('snapshot', Schema.Null, () => ({ ready: true })) }, command: {  } }]))
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
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', observe: {  }, command: { setPose: makeQaOperation('setPose', Schema.NullOr(Schema.Number), () => { calls += 1; throw failure }) } }]))
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
    const { transport } = install(makeQaNamespaces([{ namespace: 'gameplay', observe: {  }, command: { setPose: makeQaOperation('setPose', Schema.NullOr(Schema.Number), () => Effect.runSync(Effect.fail(failure))) } }]))
    const result = await transport.dispatch(namespaceName('gameplay'), operationName('setPose'), 1)
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      _tag: 'Failure',
      error: { _tag: 'QaFixtureRejected', code: 'FIXTURE_UNAVAILABLE', reason: 'world stopped', message: 'fixture unavailable' },
    })
  })

  it('keeps async command outputs and failures in the dispatch result', async () => {
    const failure = { _tag: 'FlushRejected', reason: 'storage unavailable' }
    const { transport } = install(makeQaNamespaces([{ namespace: 'persistence', observe: {  }, command: { flush: makeQaOperation('flush', Schema.Null, async () => ({ flushed: true })), reject: makeQaOperation('reject', Schema.Null, async () => { throw failure }) } }]))
    expect(await transport.dispatch(namespaceName('persistence'), operationName('flush'), null))
      .toEqual({ _tag: 'Success', value: { flushed: true } })
    expect(await transport.dispatch(namespaceName('persistence'), operationName('reject'), null))
      .toEqual({ _tag: 'Failure', error: failure })
  })

  it('removes the transport on teardown and invalidates retained dispatch functions', async () => {
    let calls = 0
    const { target, transport, dispose } = install(makeQaNamespaces([{ namespace: 'gameplay', observe: { snapshot: makeQaOperation('snapshot', Schema.Null, () => { calls += 1; return { ready: true } }) }, command: {  } }]))
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
    const bridge = makeBridge(makeQaNamespaces([{ namespace: 'gameplay', observe: { snapshot: makeQaOperation('snapshot', Schema.Null, () => 1) }, command: {  } }]))
    const disposeFirst = installQaDispatch(target, bridge)
    installQaDispatch(target, bridge)
    const current = target[QA_GLOBAL_KEY]
    disposeFirst()
    expect(target[QA_GLOBAL_KEY]).toBe(current)
    expect(await current?.dispatch(namespaceName('gameplay'), operationName('snapshot'), null))
      .toEqual({ _tag: 'Success', value: 1 })
  })

  it('uses declared observe kind and numeric input independently of operation names', async () => {
    const namespaces = makeQaNamespaces([{
      namespace: 'measurements',
      observe: { current: makeQaOperation('current', Schema.Number, (input) => input * 2) },
      command: {},
    }])
    expect(namespaces[0]?.observe).toHaveProperty('current')
    expect(namespaces[0]?.command).not.toHaveProperty('current')
    const { transport } = install(namespaces)
    expect(await transport.dispatch(namespaceName('measurements'), operationName('current'), 12))
      .toEqual({ _tag: 'Success', value: 24 })
  })

  it('returns makeQaBridge failure unchanged before reading session dependencies', () => {
    const failure = new DuplicateModuleContract({
      kind: Schema.decodeUnknownSync(ModuleContractKindSchema)('qa-namespace'),
      id: Schema.decodeUnknownSync(ModuleContractIdSchema)('gameplay'),
    })
    const rejected = Result.fail(failure)
    let attempts = 0
    const context: Parameters<typeof makeQaSurface>[0] = {
      makeQaBridge: () => { attempts += 1; return rejected },
      get render(): never { throw new Error('render accessed after composition failure') },
      get gameplay(): never { throw new Error('gameplay accessed after composition failure') },
      get persistence(): never { throw new Error('persistence accessed after composition failure') },
      get audio(): never { throw new Error('audio accessed after composition failure') },
      get lifecycle(): never { throw new Error('lifecycle accessed after composition failure') },
    }
    const result = makeQaSurface(context)
    expect(result).toEqual(rejected)
    if (Result.isFailure(result)) expect(result.failure).toBe(failure)
    expect(attempts).toBe(1)
  })
})

// The same composition main.ts performs: module registrations first, then host namespaces.
const makeComposition = (modules: ReturnType<typeof makeQaNamespaces>) =>
  (namespaces: ReturnType<typeof makeQaNamespaces>) => Effect.runSync(Effect.result(Effect.map(
    composeGame([...modules, ...namespaces].map((qa) => ({ name: qa.name, layers: Layer.empty, frameStages: [], qa }))),
    ({ qaBridge, qaNamespaces }) => ({ qaBridge, qaNamespaces }),
  )))

describe('H13-b runtime.qaCatalog', () => {
  it('lists every composed operation, including module registrations and itself, without running any', async () => {
    let calls = 0
    const counted = (name: string) => makeQaOperation(name, Schema.Null, () => { calls += 1; return null })
    const modules = makeQaNamespaces([{ namespace: 'ui', observe: { snapshot: counted('snapshot') }, command: { focus: counted('focus') } }])
    const host = makeQaNamespaces([
      { namespace: 'gameplay', observe: { snapshot: counted('snapshot') }, command: { setPose: counted('setPose') } },
      { namespace: 'persistence', observe: {}, command: { flush: counted('flush') } },
    ])
    const bridge = composeQaBridge(makeComposition(modules), host)
    if (Result.isFailure(bridge)) throw new Error('QA composition failed')
    const target: { [QA_GLOBAL_KEY]?: QaDispatchTransport } = {}
    installQaDispatch(target, bridge.success)
    const result = await target[QA_GLOBAL_KEY]?.dispatch(namespaceName('runtime'), operationName('qaCatalog'), null)
    expect(result?._tag).toBe('Success')
    const catalog = result?._tag === 'Success' ? result.value : undefined
    expect(Array.isArray(catalog) ? [...catalog].sort() : catalog).toEqual([
      'gameplay.setPose',
      'gameplay.snapshot',
      'persistence.flush',
      'runtime.qaCatalog',
      'ui.focus',
      'ui.snapshot',
    ])
    expect(calls).toBe(0)
    const invalid = await target[QA_GLOBAL_KEY]?.dispatch(namespaceName('runtime'), operationName('qaCatalog'), 1)
    expect(invalid).toMatchObject({ _tag: 'Failure', error: { _tag: 'SchemaError' } })
  })

  it('returns the composition failure when a module already owns the runtime namespace', () => {
    const modules = makeQaNamespaces([{ namespace: 'runtime', observe: {}, command: {} }])
    const bridge = composeQaBridge(makeComposition(modules), [])
    expect(bridge).toMatchObject({ _tag: 'Failure', failure: { _tag: 'DuplicateModuleContract', id: 'runtime' } })
  })
})

describe('H13-b gameplay.seedVillagerRestockPersistence', () => {
  const traded = (): VillagerTradeState => {
    const villager = makeVillager('villager-qa', 'farmer')
    const offer = villager.offers[0]
    if (offer === undefined) throw new Error('farmer has no offer')
    const state = useVillagerOffer(addVillager(emptyVillagerTradeState(), villager), villager.id, offer.id)
    if (state === undefined) throw new Error('offer could not be used')
    return state
  }
  const makeOwners = (villagerTrades: VillagerTradeState) => {
    const registrations = Result.getOrThrow(gameplayOwnerRegistrations({ villagerTrades }))
    const coordinator = Effect.runSync(makeWorldCommitCoordinator({
      world: Schema.decodeUnknownSync(WorldIdSchema)('qa-restock'), owners: registrations,
    }))
    const ownerStates = () => new Map(registrations.map(({ ownerId }) => [
      ownerId, Effect.runSync(coordinator.snapshot(ownerId, Schema.Unknown)).state,
    ]))
    const trades = () => Effect.runSync(coordinator.snapshot(GAMEPLAY_VILLAGER_TRADES_OWNER_ID, GameplayVillagerTradeSnapshotSchema)).state
    return { coordinator, ownerStates, trades }
  }
  const installRestock = (owners: ReturnType<typeof makeOwners>) => {
    let dirtyCount = 0
    const restock = seedQaVillagerRestock({
      coordinator: owners.coordinator,
      markSessionDirty: () => { dirtyCount += 1 },
      snapshot: () => ({ villagerTrades: owners.trades() }),
    })
    const { transport } = install(makeQaNamespaces([{
      namespace: 'gameplay',
      observe: {},
      command: {
        seedVillagerRestockPersistence: {
          name: operationName('seedVillagerRestockPersistence'),
          input: Schema.Null,
          output: Schema.Unknown,
          run: () => restock,
        },
      },
    }]))
    return {
      dispatch: () => transport.dispatch(namespaceName('gameplay'), operationName('seedVillagerRestockPersistence'), null),
      dirtyCount: () => dirtyCount,
    }
  }

  it('advances a zero restock clock by one second and preserves every other owner and offer', async () => {
    const initial = traded()
    const owners = makeOwners(initial)
    const before = owners.ownerStates()
    const restock = installRestock(owners)
    expect(await restock.dispatch()).toEqual({
      _tag: 'Success',
      value: JSON.parse(JSON.stringify({ villagerTrades: { ...initial, restockElapsedSecs: 1 } })),
    })
    expect(owners.trades()).toEqual({ ...initial, restockElapsedSecs: 1 })
    const after = owners.ownerStates()
    for (const [ownerId, state] of before) {
      if (ownerId === GAMEPLAY_VILLAGER_TRADES_OWNER_ID) continue
      expect(after.get(ownerId)).toEqual(state)
    }
    expect(restock.dirtyCount()).toBe(1)
  })

  it('fails with a typed precondition failure and leaves the owner untouched once the clock has advanced', async () => {
    const initial = { ...traded(), restockElapsedSecs: 7 }
    const owners = makeOwners(initial)
    const restock = installRestock(owners)
    const result = await restock.dispatch()
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      _tag: 'Failure',
      error: { _tag: 'QaVillagerRestockNotFresh', restockElapsedSecs: 7 },
    })
    expect(owners.trades()).toEqual(initial)
    expect(restock.dirtyCount()).toBe(0)
  })
})
