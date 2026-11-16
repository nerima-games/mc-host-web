import {
  assert,
  describe,
  expect,
  it,
  beforeAll,
} from '@effect/vitest'
import {
  Effect,
  Option,
  Result,
  Schema,
} from 'effect'
import {
  SaveDecodeError,
  SaveKey,
  StorageError,
} from '@nerima-games/mc-save'
import {
  ChunkAxis,
  chunkCoord,
  CHUNK_SIZE_XZ,
  EntityHealthPoints,
  EntityKind,
  position,
  PositionAxis,
  WorldIdSchema,
  blockIdOf,
  encodeBlockState,
} from '@nerima-games/mc-kernel'
import {
  BrewingStateSchema,
  CropSnapshotSchema,
  emptyBrewingState,
  EntitySerial,
  INVENTORY_SLOT_COUNT,
  itemStack,
  PlayerServiceSnapshotSchema,
  PlayerStorageSnapshotSchema,
  storageFromInventory,
} from '@nerima-games/mc-sim'
import {
  ChunkCapacity,
  CHUNK_VOLUME,
  generatedChunkSource,
  makeChunkStore,
  NoiseSeed,
  type ChunkSource,
  type ChunkWithBlockStates,
  generatedDimensionChunkSource,
  chunkSnapshotOf,
  type Chunk,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import {
  ExperienceOrbVitalsOwnerSnapshotSchema,
  GAMEPLAY_BREWING_OWNER_ID,
  GAMEPLAY_CROPS_OWNER_ID,
  GAMEPLAY_ENTITIES_OWNER_ID,
  GAMEPLAY_PLAYER_OWNER_ID,
  GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  GAMEPLAY_STATUS_EFFECTS_OWNER_ID,
  GAMEPLAY_VILLAGER_TRADES_OWNER_ID,
  GAMEPLAY_VITALS_OWNER_ID,
  GameplayEntityRosterSchema,
  GameplayVillagerTradeSnapshotSchema,
  gameplayOwnerRegistrations,
  emptyVillagerTradeState,
  emptyStatusEffectState,
  hostileMobSnapshot,
  mintEntityId,
  makeGameplayFrameState,
  snapshotStatusEffects,
  SPAWN_PLAYER_VITALS,
  type DroppedItemBehaviour,
  type GameplayOwnerInitialState,
  type MobEntity,
  type MobRoster,
} from '@nerima-games/mx-gameplay'
import {
  gameplayOwnerInitialState,
  makeSessionChunkSourceFor,
  restoreInitialWorld,
  restoreLoadedSessionServices,
  sessionLoadErrorMessage,
  sessionLoadErrorOf,
  sessionOpenFailureMessage,
  type GeneratedOwnerState,
  makeSessionTerrainSources,
  restoreDimensionTerrain,
} from '../apps/web/session-restoration'
import {
  createDroppedItemLifetimeTracker,
} from '../apps/web/dropped-item-lifetime'
import {
  initializeSessionWorld,
} from '../apps/web/session-world'
import {
  SessionCorruptError,
  SessionIncompatibleError,
  type PersistedEntityRoster,
  type PersistedEntityRosters,
  type SessionOpenError,
  type SessionState,
  type DimensionChunk,
} from '../apps/web/session-persistence'
import {
  makeHostWorldWrite,
} from '../apps/web/world-write-port'

const chunk = (cx: number, cz: number, marker: number): ChunkWithBlockStates => ({
  coord: chunkCoord(ChunkAxis(cx), ChunkAxis(cz)),
  blocks: new Uint16Array(CHUNK_VOLUME).fill(marker),
  blockStates: new Uint32Array(CHUNK_VOLUME),
  biomes: Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, () => 'PLAINS'),
})

describe('session open failure messages', () => {
  const failures: ReadonlyArray<readonly [SessionOpenError, string, string]> = [
    [
      new SessionIncompatibleError({
        reason: 'future-version',
        key: SaveKey('mc-compose/session/w/head'),
        storedVersion: 19,
        currentVersion: 18,
      }),
      'future-version-session',
      'This world was saved by a newer version and cannot be opened.',
    ],
    [
      new SessionIncompatibleError({
        reason: 'unsupported-version',
        key: SaveKey('mc-compose/session/w/head'),
        storedVersion: 16,
        currentVersion: 18,
      }),
      'unsupported-version-session',
      'This world was saved by an older version that can no longer be opened.',
    ],
    [
      new SessionCorruptError({
        sessionId: 'w',
        liveFailure: new SaveDecodeError({ format: 'f', version: 18, reason: 'checksum mismatch' }),
        checkpoint: 'absent',
      }),
      'corrupt-session',
      'This world could not be read, and no earlier save of it could be opened.',
    ],
    [
      new StorageError({ operation: 'get', key: 'mc-compose/session/w/head' }),
      'session-storage-failure',
      'Saved worlds could not be read from or updated in browser storage.',
    ],
  ]

  it('gives each open failure its own message and title query value', () => {
    for (const [error, loadError, message] of failures) {
      expect(sessionOpenFailureMessage(error)).toBe(message)
      expect(sessionLoadErrorOf(error)).toBe(loadError)
      expect(sessionLoadErrorMessage(loadError)).toEqual(Option.some(message))
    }
  })

  it('shows nothing for a query value it did not produce', () => {
    expect(sessionLoadErrorMessage(null)).toEqual(Option.none())
    expect(sessionLoadErrorMessage('missing-session')).toEqual(Option.none())
    expect(sessionLoadErrorMessage('toString')).toEqual(Option.none())
  })
})

const seed = NoiseSeed(81)
const coord = chunkCoord(ChunkAxis(0), ChunkAxis(0))
const materialize = async (chunk: Chunk): Promise<ChunkWithBlockStates> => {
  const store = await Effect.runPromise(makeChunkStore(() => Effect.succeed(chunk), ChunkCapacity(1)))
  await Effect.runPromise(store.load(chunk.coord))
  return Option.getOrThrow(Option.fromUndefinedOr(await Effect.runPromise(store.snapshot(chunk.coord))))
}
const terrainFixtures = new Map<Dimension, { generated: Chunk; snapshot: ChunkWithBlockStates }>()
beforeAll(async () => {
  for (const dimension of ['overworld', 'nether', 'end'] satisfies ReadonlyArray<Dimension>) {
    const generated = await Effect.runPromise(generatedDimensionChunkSource(seed, dimension)(coord))
    terrainFixtures.set(dimension, { generated, snapshot: await materialize(generated) })
  }
})
const terrainFixture = (dimension: Dimension): { generated: Chunk; snapshot: ChunkWithBlockStates } =>
  Option.getOrThrow(Option.fromUndefinedOr(terrainFixtures.get(dimension)))
const legacyChunk = async (): Promise<ChunkWithBlockStates> =>
  chunkSnapshotOf(terrainFixture('overworld').snapshot)

describe('dimension terrain restoration', () => {
  for (const dimension of ['nether', 'end'] satisfies ReadonlyArray<Dimension>) {
    it(`rebuilds an unedited saved ${dimension} chunk from that dimension`, async () => {
      const saved = await legacyChunk()
      const result = await Effect.runPromise(restoreDimensionTerrain(makeSessionTerrainSources(seed), [{ dimension, chunk: saved }]))
      const fixture = terrainFixture(dimension)
      const expected = {
        ...fixture.generated,
        ...chunkSnapshotOf(fixture.snapshot),
      }

      expect(result.chunks).toEqual([{ dimension, chunk: expected }])
      expect(result.rebuiltChunks).toEqual(result.chunks)
      expect(result.chunks[0]?.chunk.blocks).not.toEqual(saved.blocks)
      expect(saved).toEqual(await legacyChunk())
    })
  }

  it('preserves an edited block instead of regenerating it', async () => {
    const saved = await legacyChunk()
    // Generated air at the world ceiling becomes stone with its default state.
    saved.blocks[saved.blocks.length - 1] = 1
    saved.blockStates[saved.blockStates.length - 1] = 0
    const result = await Effect.runPromise(restoreDimensionTerrain(makeSessionTerrainSources(seed), [{ dimension: 'nether', chunk: saved }]))

    expect(result.chunks).toEqual([{ dimension: 'nether', chunk: saved }])
    expect(result.rebuiltChunks).toEqual([])
  })

  it('preserves a biome edit even when every block matches', async () => {
    const legacy = await legacyChunk()
    const saved: ChunkWithBlockStates = { ...legacy, biomes: legacy.biomes.map(() => 'DESERT') }
    const result = await Effect.runPromise(restoreDimensionTerrain(makeSessionTerrainSources(seed), [{ dimension: 'end', chunk: saved }]))

    expect(result.chunks[0]?.chunk).toEqual(saved)
    expect(result.rebuiltChunks).toEqual([])
  })

  it('preserves a block-state edit when block ids are unchanged', async () => {
    const saved = await legacyChunk()
    const water = Option.getOrThrow(blockIdOf('water'))
    const index = saved.blocks.findIndex((id) => id === water)
    expect(index).toBeGreaterThanOrEqual(0)
    saved.blockStates[index] = Result.getOrThrow(encodeBlockState(water, { level: 1 }))
    const result = await Effect.runPromise(restoreDimensionTerrain(makeSessionTerrainSources(seed), [{ dimension: 'nether', chunk: saved }]))

    expect(result.chunks[0]?.chunk).toEqual(saved)
    expect(result.rebuiltChunks).toEqual([])
  })

  it('never rebuilds a saved overworld chunk', async () => {
    const saved = await legacyChunk()
    const result = await Effect.runPromise(restoreDimensionTerrain(makeSessionTerrainSources(seed), [{ dimension: 'overworld', chunk: saved }]))

    expect(result.chunks).toEqual([{ dimension: 'overworld', chunk: saved }])
    expect(result.rebuiltChunks).toEqual([])
  })

  it('keys rebuilt chunks by dimension at the same coordinates', async () => {
    const saved = await legacyChunk()
    const records: Array<DimensionChunk> = [
      { dimension: 'overworld', chunk: saved },
      { dimension: 'nether', chunk: chunkSnapshotOf(saved) },
      { dimension: 'end', chunk: chunkSnapshotOf(saved) },
    ]
    const result = await Effect.runPromise(restoreDimensionTerrain(makeSessionTerrainSources(seed), records))

    expect(result.rebuiltChunks.map(({ dimension, chunk }) => ({ dimension, coord: chunk.coord }))).toEqual([
      { dimension: 'nether', coord },
      { dimension: 'end', coord },
    ])
    expect(result.chunks[0]).toEqual(records[0])
    expect(result.chunks[1]?.chunk.blocks).not.toEqual(result.chunks[2]?.chunk.blocks)
  })

  it('propagates schema failure from an injected invalid chunk buffer', async () => {
    const legacy = await legacyChunk()
    const corrupt = { ...legacy, blockStates: new Uint32Array(1) }
    const result = await Effect.runPromise(Effect.result(restoreDimensionTerrain(makeSessionTerrainSources(seed), [{ dimension: 'nether', chunk: corrupt }])))

    if (!Result.isFailure(result)) assert.fail('corrupt saved chunk must fail')
    expect(result.failure._tag).toBe('SchemaError')
  })

  it('preserves already dimension-generated terrain on subsequent restores', async () => {
    const saved = chunkSnapshotOf(terrainFixture('end').snapshot)
    const result = await Effect.runPromise(restoreDimensionTerrain(makeSessionTerrainSources(seed), [{ dimension: 'end', chunk: saved }]))

    expect(result.chunks).toEqual([{ dimension: 'end', chunk: saved }])
    expect(result.rebuiltChunks).toEqual([])
  })

})

describe('session restoration', () => {
  it('uses persisted chunks for the selected dimension and generated chunks otherwise', async () => {
    const persisted = chunk(-1, 2, 7)
    const generatedCalls: Array<{ cx: number; cz: number }> = []
    const generatedSource: ChunkSource = (coord) => Effect.sync(() => {
      generatedCalls.push({ cx: coord.cx, cz: coord.cz })
      return chunk(coord.cx, coord.cz, 3)
    })
    const source = makeSessionChunkSourceFor(
      'overworld',
      new Map([['overworld:-1,2', persisted]]),
      generatedSource,
    )

    const restored = await Effect.runPromise(source(chunkCoord(ChunkAxis(-1), ChunkAxis(2))))
    const generated = await Effect.runPromise(source(chunkCoord(ChunkAxis(4), ChunkAxis(-3))))

    expect(restored).toEqual(persisted)
    expect(restored).not.toBe(persisted)
    expect(generated.blocks[0]).toBe(3)
    expect(generatedCalls).toEqual([{ cx: 4, cz: -3 }])
  })

  it('builds a new world from its generated source and restores each dimension roster', async () => {
    const calls: Array<string> = []
    const initialized = await initializeSessionWorld({
      loadedSession: Option.none(),
      initialDimension: 'overworld',
      worldSeed: 42,
      loadSavedChunks: async () => { throw new Error('new worlds do not load session chunks') },
      makeWorld: async ({ seed, dimension, chunkSource }) => {
        calls.push(`world:${String(seed)}:${dimension}`)
        return { chunkSource }
      },
      restoreEntities: (_world, roster) => {
        calls.push(`restore:${String(roster.entities.length)}`)
      },
      snapshotEntities: () => ({ entities: [], nextSerial: EntitySerial(0) }),
      droppedItemLifetime: createDroppedItemLifetimeTracker(),
      droppedItemMetadata: new Map(),
      droppedItemMetadataKey: (dimension, entityId) => `${dimension}:${entityId}`,
      droppedItemMetadataFromBehaviour: () => ({}),
    })

    assert.isTrue(Result.isSuccess(initialized))
    const world = Result.getOrThrow(initialized)
    const generated = await Effect.runPromise(world.chunkSourceFor('nether')(chunkCoord(ChunkAxis(2), ChunkAxis(-1))))

    expect(world.activeSeed).toBe(42)
    expect(generated.coord).toEqual(chunkCoord(ChunkAxis(2), ChunkAxis(-1)))
    expect(calls).toEqual(['world:42:overworld', 'restore:0', 'restore:0', 'restore:0'])
    expect(world.entities).toEqual({ entities: [], nextSerial: EntitySerial(0) })
    expect(world.snapshotEntityRosters({ entities: [], nextSerial: EntitySerial(0) })).toEqual({
      overworld: { entities: [], nextSerial: 0 },
      nether: { entities: [], nextSerial: 0 },
      end: { entities: [], nextSerial: 0 },
    })
  })

  // The player, storage, vitals and entities start in the owners
  // (`gameplayOwnerInitialState`), so only the local containers are restored.
  it('restores only the loaded container storage and leaves new survival worlds untouched', async () => {
    const state = { seed: 81 }
    const calls: Array<string> = []
    const actions = {
      restoreContainerStorage: async (value: typeof state) => {
        expect(value).toBe(state)
        calls.push('containers')
      },
      addCreativeStartingItems: async () => { calls.push('creative-items') },
    }

    await restoreInitialWorld(state, false, actions)
    expect(calls).toEqual(['containers'])

    calls.length = 0
    await restoreInitialWorld(undefined, false, actions)
    expect(calls).toEqual([])
  })

  it('adds creative starting items only for a new creative world', async () => {
    const calls: Array<string> = []
    const actions = {
      restoreContainerStorage: async () => { calls.push('containers') },
      addCreativeStartingItems: async () => { calls.push('creative-items') },
    }

    await restoreInitialWorld(undefined, true, actions)

    expect(calls).toEqual(['creative-items'])
  })

  it('restores services in order and stops after the first failed restore', async () => {
    const state = { seed: 12 }
    const calls: Array<string> = []
    const actions = {
      restoreTime: async () => { calls.push('time') },
      restoreWeather: async () => {
        calls.push('weather')
        throw new Error('weather restore failed')
      },
      restoreStatusEffects: async () => { calls.push('status-effects') },
      restoreEnderDragon: async () => { calls.push('ender-dragon') },
    }

    await restoreLoadedSessionServices(undefined, actions)
    expect(calls).toEqual([])

    await expect(restoreLoadedSessionServices(state, actions)).rejects.toThrow('weather restore failed')
    expect(calls).toEqual(['time', 'weather'])
  })

  it('restores every loaded service in its existing order', async () => {
    const state = { seed: 12 }
    const calls: Array<string> = []
    const actions = {
      restoreTime: async () => { calls.push('time') },
      restoreWeather: async () => { calls.push('weather') },
      restoreStatusEffects: async () => { calls.push('status-effects') },
      restoreEnderDragon: async () => { calls.push('ender-dragon') },
    }

    await restoreLoadedSessionServices(state, actions)

    expect(calls).toEqual([
      'time',
      'weather',
      'status-effects',
      'ender-dragon',
    ])
  })
})

// One coordinator seeded exactly as main.ts seeds it.
const coordinatorFor = (initial: GameplayOwnerInitialState) =>
  Effect.gen(function* () {
    const owners = yield* Effect.fromResult(gameplayOwnerRegistrations(initial))
    const chunkStore = yield* makeChunkStore(generatedChunkSource(NoiseSeed(1)), ChunkCapacity(4))
    const hostWorldWrite = yield* makeHostWorldWrite({
      world: yield* Schema.decodeEffect(WorldIdSchema)('session-restoration-test'),
      owners,
      chunkStores: { forDimension: () => chunkStore },
    })
    return hostWorldWrite.coordinator
  })

const emptyStorage = () => storageFromInventory({ slots: Array.from({ length: INVENTORY_SLOT_COUNT }, () => undefined) })

const generatedOwnerState: GeneratedOwnerState = {
  pose: { feetPosition: position(PositionAxis(0.5), PositionAxis(71), PositionAxis(0.5)), yawRadians: 0, pitchRadians: 0 },
  dimension: 'overworld',
  storage: emptyStorage(),
  vitals: SPAWN_PLAYER_VITALS,
}

const zombie = (serial: number): MobEntity => ({
  id: mintEntityId(EntityKind('zombie'), serial),
  kind: EntityKind('zombie'),
  feetPosition: position(PositionAxis(2), PositionAxis(65), PositionAxis(3)),
  healthPoints: EntityHealthPoints(20),
  behaviour: hostileMobSnapshot(undefined),
})

describe('owner initial state', () => {
  it.effect('seeds every owner with the loaded session, including the player pose and dimension', () =>
    Effect.gen(function* () {
      const loaded: Pick<SessionState, 'dimension' | 'player' | 'storage' | 'vitals' | 'villagers' | 'brewing' | 'statusEffects' | 'crops'> = {
        dimension: 'nether',
        player: { feetPosition: { x: 3.5, y: 70, z: -4.5 }, yawRadians: 0.5, pitchRadians: -0.25 },
        storage: storageFromInventory({
          slots: Array.from({ length: INVENTORY_SLOT_COUNT }, (_, index) =>
            index === 0 ? Result.getOrThrow(itemStack('stone', 12)) : undefined),
        }),
        vitals: { ...SPAWN_PLAYER_VITALS, healthPoints: EntityHealthPoints(7) },
        villagers: { residents: [], trades: emptyVillagerTradeState() },
        brewing: Result.getOrThrow(emptyBrewingState()),
        statusEffects: { effects: [{ type: 'speed', remainingSecs: 30, pulseClockSecs: 0, amplifier: 0 }] },
        crops: yield* Schema.decodeUnknownEffect(CropSnapshotSchema)({
          crops: [{ dimension: 'nether', position: { x: 1, y: 65, z: 2 }, crop: 'nether_wart_crop', growthSecs: 120 }],
        }),
      }
      const entities: MobRoster = {
        entities: [{ ...zombie(0), dimension: 'nether' }],
        nextSerial: EntitySerial(1),
      }

      const initial = yield* Effect.fromResult(gameplayOwnerInitialState(loaded, generatedOwnerState, entities))
      const coordinator = yield* coordinatorFor(initial)

      const player = yield* coordinator.snapshot(GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema)
      expect(player.state.pose).toEqual({
        feetPosition: { dimension: 'nether', x: 3.5, y: 70, z: -4.5 },
        yawRadians: 0.5,
        pitchRadians: -0.25,
      })
      expect((yield* coordinator.snapshot(GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state)
        .toEqual(loaded.storage)
      expect((yield* coordinator.snapshot(GAMEPLAY_VITALS_OWNER_ID, ExperienceOrbVitalsOwnerSnapshotSchema)).state.vitals)
        .toEqual(loaded.vitals)
      const owned = (yield* coordinator.snapshot(GAMEPLAY_ENTITIES_OWNER_ID, GameplayEntityRosterSchema)).state
      expect(owned.entities.map(({ id, dimension }) => ({ id, dimension })))
        .toEqual([{ id: zombie(0).id, dimension: 'nether' }])
      expect(owned.nextSerial).toBe(1)
      expect((yield* coordinator.snapshot(GAMEPLAY_VILLAGER_TRADES_OWNER_ID, GameplayVillagerTradeSnapshotSchema)).state)
        .toEqual(loaded.villagers.trades)
      expect((yield* coordinator.snapshot(GAMEPLAY_BREWING_OWNER_ID, BrewingStateSchema)).state).toEqual(loaded.brewing)
      expect(yield* snapshotStatusEffects(yield* makeGameplayFrameState, {
        coordinator,
        playerOwnerId: GAMEPLAY_PLAYER_OWNER_ID,
        playerStorageOwnerId: GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
        statusEffectsOwnerId: GAMEPLAY_STATUS_EFFECTS_OWNER_ID,
      })).toEqual(loaded.statusEffects)
      expect(initial.droppedItems).toEqual({ items: [] })
      expect(initial.crops).toEqual(loaded.crops)
    }))

  it.effect('seeds a new session with the generated spawn rather than the registrations\' origin', () =>
    Effect.gen(function* () {
      const initial = yield* Effect.fromResult(
        gameplayOwnerInitialState(undefined, generatedOwnerState, { entities: [], nextSerial: EntitySerial(0) }),
      )
      const coordinator = yield* coordinatorFor(initial)

      expect('crops' in initial).toBe(false)

      const player = yield* coordinator.snapshot(GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema)
      expect(player.state.pose).toEqual({
        feetPosition: { dimension: 'overworld', x: 0.5, y: 71, z: 0.5 },
        yawRadians: 0,
        pitchRadians: 0,
      })
    }))

  it('returns the decode failure for a saved pose that is not a finite position', () => {
    const initial = gameplayOwnerInitialState(
      {
        dimension: 'overworld',
        player: { feetPosition: { x: Number.NaN, y: 70, z: 0 }, yawRadians: 0, pitchRadians: 0 },
        storage: emptyStorage(),
        vitals: SPAWN_PLAYER_VITALS,
        villagers: { residents: [], trades: emptyVillagerTradeState() },
        brewing: Result.getOrThrow(emptyBrewingState()),
        statusEffects: emptyStatusEffectState(),
        crops: { crops: [] },
      },
      generatedOwnerState,
      { entities: [], nextSerial: EntitySerial(0) },
    )

    assert.isTrue(Result.isFailure(initial))
    if (Result.isFailure(initial)) expect(initial.failure._tag).toBe('SchemaError')
  })

  it.effect('returns the typed crop registration failure for an invalid saved crop', () =>
    Effect.gen(function* () {
      const valid = yield* Schema.decodeUnknownEffect(CropSnapshotSchema)({
        crops: [{ dimension: 'overworld', position: { x: 1, y: 65, z: 2 }, crop: 'potato_crop', growthSecs: 120 }],
      })
      const initial = yield* Effect.fromResult(gameplayOwnerInitialState({
        dimension: 'overworld',
        player: generatedOwnerState.pose,
        storage: emptyStorage(),
        vitals: SPAWN_PLAYER_VITALS,
        villagers: { residents: [], trades: emptyVillagerTradeState() },
        brewing: Result.getOrThrow(emptyBrewingState()),
        statusEffects: emptyStatusEffectState(),
        crops: { crops: valid.crops.map((crop) => ({ ...crop, growthSecs: -1 })) },
      }, generatedOwnerState, { entities: [], nextSerial: EntitySerial(0) }))
      const registered = gameplayOwnerRegistrations(initial)
      assert.isTrue(Result.isFailure(registered))
      if (Result.isFailure(registered)) {
        expect(registered.failure).toMatchObject({
          _tag: 'InvalidGameplayOwnerRegistration',
          ownerId: GAMEPLAY_CROPS_OWNER_ID,
          error: { _tag: 'SchemaError' },
        })
      }
    }))
})

describe('saved entity rosters and the entities owner', () => {
  // Stands in for the generated world's entity manager: it returns the typed
  // entity each saved one describes, as a restore followed by a snapshot does.
  const fakeWorld = (typed: ReadonlyArray<MobEntity>) => {
    // Ids may repeat across dimensions in a saved session, so the position tells them apart.
    const keyOf = (entity: Pick<MobEntity, 'id' | 'kind' | 'feetPosition'>) =>
      `${entity.id}|${entity.kind}|${String(entity.feetPosition.x)},${String(entity.feetPosition.y)},${String(entity.feetPosition.z)}`
    const byKey = new Map(typed.map((entity) => [keyOf(entity), entity]))
    let current: PersistedEntityRoster = { entities: [], nextSerial: 0 }
    return {
      restoreEntities: (_world: unknown, roster: PersistedEntityRoster) => { current = roster },
      snapshotEntities: (): MobRoster => ({
        entities: current.entities.flatMap((entity) => {
          const found = byKey.get(`${entity.id}|${entity.kind}|${String(entity.feetPosition.x)},${String(entity.feetPosition.y)},${String(entity.feetPosition.z)}`)
          return found === undefined ? [] : [found]
        }),
        nextSerial: EntitySerial(current.nextSerial),
      }),
    }
  }

  const drop: DroppedItemBehaviour & { readonly elapsedSecs: number } = {
    _tag: 'DroppedItem',
    item: 'apple',
    count: 2,
    durability: null,
    enchantments: [],
    elapsedSecs: 12,
  }
  const droppedApple: MobEntity = {
    id: mintEntityId(EntityKind('dropped_item'), 1),
    kind: EntityKind('dropped_item'),
    feetPosition: position(PositionAxis(1), PositionAxis(65), PositionAxis(1)),
    healthPoints: EntityHealthPoints(1),
    behaviour: drop,
  }
  const netherZombie: MobEntity = { ...zombie(0), feetPosition: position(PositionAxis(-8), PositionAxis(40), PositionAxis(5)) }
  const saved: PersistedEntityRosters = {
    overworld: { entities: [zombie(0), droppedApple], nextSerial: 2 },
    // Before the shared owner every dimension minted its own serials, so the
    // nether zombie reuses the overworld zombie's id.
    nether: { entities: [netherZombie], nextSerial: 1 },
    end: { entities: [], nextSerial: 0 },
  }

  const initialize = () => {
    const fake = fakeWorld([zombie(0), droppedApple, netherZombie])
    const lifetime = createDroppedItemLifetimeTracker()
    const metadata = new Map()
    return Effect.promise(async () => ({
      lifetime,
      metadata,
      initialized: await initializeSessionWorld({
        loadedSession: Option.some({ state: { seed: 7, entities: saved } }),
        initialDimension: 'overworld',
        worldSeed: 42,
        loadSavedChunks: async () => ({ chunks: [] }),
        makeWorld: async () => ({}),
        restoreEntities: fake.restoreEntities,
        snapshotEntities: fake.snapshotEntities,
        droppedItemLifetime: lifetime,
        droppedItemMetadata: metadata,
        droppedItemMetadataKey: (dimension, entityId) => `${dimension}:${entityId}`,
        droppedItemMetadataFromBehaviour: () => ({ customName: 'kept' }),
      }),
    }))
  }

  it.effect('merges every dimension into one roster and renumbers a cross-dimension duplicate id', () =>
    Effect.gen(function* () {
      const { initialized, lifetime, metadata } = yield* initialize()
      const world = yield* Effect.fromResult(initialized)

      // The repair mints from the highest saved serial (2), skipping saved ids.
      const renumbered = mintEntityId(EntityKind('zombie'), 2)
      expect(world.entities.entities.map(({ id, dimension }) => ({ id, dimension }))).toEqual([
        { id: zombie(0).id, dimension: 'overworld' },
        { id: droppedApple.id, dimension: 'overworld' },
        { id: renumbered, dimension: 'nether' },
      ])
      expect(world.entities.nextSerial).toBe(3)
      // The owner gets the behaviour without the host's lifetime field, which
      // the lifetime tracker and metadata keep under the final id.
      expect(world.entities.entities[1]?.behaviour).toEqual({
        _tag: 'DroppedItem', item: 'apple', count: 2, durability: null, enchantments: [],
      })
      expect(world.entities.entities[0]?.behaviour).toEqual(hostileMobSnapshot(undefined))
      expect(lifetime.elapsed('overworld', droppedApple.id)).toBe(12)
      expect(metadata.get(`overworld:${droppedApple.id}`)).toEqual({ customName: 'kept' })
    }))

  it.effect('seeds the entities owner and saves it back per dimension in the unchanged format', () =>
    Effect.gen(function* () {
      const { initialized } = yield* initialize()
      const world = yield* Effect.fromResult(initialized)
      const coordinator = yield* coordinatorFor({ entities: world.entities })
      const owned = (yield* coordinator.snapshot(GAMEPLAY_ENTITIES_OWNER_ID, GameplayEntityRosterSchema)).state

      const rosters = world.snapshotEntityRosters(owned)

      const persisted = (entity: MobEntity) => ({
        id: entity.id,
        kind: entity.kind,
        feetPosition: entity.feetPosition,
        healthPoints: entity.healthPoints,
        behaviour: entity.behaviour,
      })
      expect(rosters).toEqual({
        overworld: {
          entities: [
            persisted(zombie(0)),
            { ...persisted(droppedApple), behaviour: { ...drop, customName: 'kept' } },
          ],
          nextSerial: 3,
        },
        nether: {
          entities: [{ ...persisted(netherZombie), id: mintEntityId(EntityKind('zombie'), 2) }],
          nextSerial: 3,
        },
        end: { entities: [], nextSerial: 3 },
      })
    }))
})
