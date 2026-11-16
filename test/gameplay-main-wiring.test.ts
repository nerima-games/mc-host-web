import { readFileSync } from 'node:fs'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { vi } from 'vitest'
import {
  BlockAxis,
  blockIdOf,
  blockPosition,
  ChunkAxis,
  chunkCoord,
  WorldIdSchema,
  WorldWriteBatchSchema,
} from '@nerima-games/mc-kernel'
import { ChunkCapacity, generatedChunkSource, makeChunkStore, NoiseSeed } from '@nerima-games/mc-worldgen'
import { gameplayOwnerRegistrations } from '@nerima-games/mx-gameplay'
import { makeHostWorldWrite } from '../apps/web/world-write-port'

const mainSource = readFileSync(new URL('../apps/web/main.ts', import.meta.url), 'utf8')

describe('gameplay startup wiring', () => {
  it.effect('creates the session coordinator with a lazy registry returning the host ChunkStore objects', () =>
    Effect.gen(function* () {
      const stores = yield* Effect.all({
        overworld: makeChunkStore(generatedChunkSource(NoiseSeed(1)), ChunkCapacity(4)),
        nether: makeChunkStore(generatedChunkSource(NoiseSeed(2)), ChunkCapacity(4)),
        end: makeChunkStore(generatedChunkSource(NoiseSeed(3)), ChunkCapacity(4)),
      })
      let initialized = false
      const forDimension = vi.fn((dimension: keyof typeof stores) => {
        assert.isTrue(initialized)
        return stores[dimension]
      })
      const world = yield* Schema.decodeEffect(WorldIdSchema)('startup-session')
      const hostWorldWrite = yield* makeHostWorldWrite({
        world,
        owners: gameplayOwnerRegistrations(),
        chunkStores: { forDimension },
      })

      expect(forDimension).not.toHaveBeenCalled()
      expect(hostWorldWrite.coordinator.worldId).toBe(world)
      initialized = true
      for (const dimension of ['overworld', 'nether', 'end'] as const) {
        expect(forDimension(dimension)).toBe(stores[dimension])
        yield* stores[dimension].load(chunkCoord(ChunkAxis(0), ChunkAxis(0)))
        const at = blockPosition(BlockAxis(1), BlockAxis(100), BlockAxis(1))
        const stone = Option.getOrThrow(blockIdOf('stone'))
        const batch = yield* Schema.decodeUnknownEffect(WorldWriteBatchSchema)({
          world,
          expectedWorldRevision: yield* hostWorldWrite.coordinator.revision,
          dimension,
          expectedDimensionRevision: yield* hostWorldWrite.coordinator.dimensionRevision(dimension),
          edits: [{ position: at, block: stone }],
        })
        yield* hostWorldWrite.port.applyBatch(batch)
        expect(yield* stores[dimension].getBlock(at)).toEqual({ _tag: 'Block', block: stone })
      }
      expect(yield* hostWorldWrite.coordinator.revision).toBe(3)
    }))

  it('connects bootGame to the tested construction and shares its commit object with stages, QA and status effects', () => {
    expect(mainSource.match(/makeHostWorldWrite\(\{/g)).toHaveLength(1)
    const creation = mainSource.indexOf('(worldId) => makeHostWorldWrite({')
    const cropCreation = mainSource.indexOf('const crops = await Effect.runPromise(makeCropService())')
    const frameCreation = mainSource.indexOf('const gameplayState = await Effect.runPromise(makeGameplayFrameStateForOwner({')
    expect(creation).toBeGreaterThanOrEqual(0)
    expect(creation).toBeLessThan(cropCreation)
    expect(creation).toBeLessThan(frameCreation)
    expect(mainSource).toContain('Schema.decodeEffect(WorldIdSchema)(sessionId)')
    expect(mainSource).toContain('const gameplayOwners = gameplayOwnerRegistrations(ownerInitialState.success)')
    expect(mainSource).toContain('owners: gameplayOwners.success,')
    expect(mainSource).toContain('forDimension: (dimension) => getOrCreateDimensionChunkContext(dimension).chunkStore,')
    expect(mainSource).toContain('worldWrite: hostWorldWrite.port,')

    const commitStart = mainSource.indexOf('const gameplayCommit: GameplayCommitServices = {')
    const commitEnd = mainSource.indexOf('\n  }', commitStart)
    expect(commitStart).toBeGreaterThanOrEqual(0)
    const commit = mainSource.slice(commitStart, commitEnd)
    expect(commit).toContain('coordinator: hostWorldWrite.coordinator,')
    for (const [field, owner] of [
      ['player', 'PLAYER'],
      ['playerStorage', 'PLAYER_STORAGE'],
      ['crop', 'CROPS'],
      ['droppedItems', 'DROPPED_ITEMS'],
      ['entities', 'ENTITIES'],
      ['vitals', 'VITALS'],
      ['statusEffects', 'STATUS_EFFECTS'],
      ['villagerTrades', 'VILLAGER_TRADES'],
      ['brewing', 'BREWING'],
    ]) {
      expect(commit).toContain(`${field}OwnerId: GAMEPLAY_${owner}_OWNER_ID,`)
    }
    expect(commit).toContain('brewingService: gameplayBrewingService,')
    const registration = mainSource.slice(mainSource.indexOf('registerHostModules({'), mainSource.indexOf('(modules) => composeGame(modules)'))
    expect(registration).toContain('gameplayCommit,')
    expect(mainSource).toContain('commit: gameplayCommit,')
    expect(mainSource).toContain('targetingEntitiesOwnerId: GAMEPLAY_ENTITIES_OWNER_ID,')
    expect(mainSource).toContain('brewingService: gameplayBrewingService,')
    expect(mainSource).toContain('restoreStatusEffects(gameplayState, state.statusEffects, gameplayCommit)')
    expect(mainSource).toContain('snapshotStatusEffects(gameplayState, gameplayCommit)')
  })
})
