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

})
