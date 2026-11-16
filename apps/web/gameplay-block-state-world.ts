import type { BlockStateValues, Dimension, WorldWriteBatch } from '@nerima-games/mc-kernel'
import type { WorldCommitCoordinatorApi } from '@nerima-games/mc-sim'
import type { ChunkStoreRegistryApi } from '@nerima-games/mc-worldgen'
import type { BlockStateRead, BlockStateWrite, GameplayBlockStateWorldApi } from '@nerima-games/mx-gameplay'
import { Effect } from 'effect'

import { commitWorldWrite, dieUnexpected } from './world-write-port'

// The chunk store omits `state` exactly when the decoded state has no
// properties, so the empty state is the stored value, not a stand-in.
const STATELESS: BlockStateValues = {}

const WRITTEN: BlockStateWrite = { _tag: 'Written' }

// `Unsupported` is the port's only outcome other than `Written`, so every write
// the world refused maps to it. The rule records it as a failed outcome in
// `blockStateRuleResults`, and nothing was committed.
const REFUSED: BlockStateWrite = { _tag: 'Unsupported', operation: 'writeState' }

export type HostGameplayBlockStateWorldOptions = {
  readonly coordinator: WorldCommitCoordinatorApi
  // The registry the coordinator commits to, so reads see the published state
  // that the next commit is checked against.
  readonly chunkStores: ChunkStoreRegistryApi
  // Decoded once at boot, as for the host's other C7 batches.
  readonly dimensionIds: Readonly<Record<Dimension, WorldWriteBatch['dimension']>>
}

/**
 * mx-gameplay's `GameplayBlockStateWorld` over the host's C7 coordinator: reads
 * come from the dimension's ChunkStore, and each write is one coordinator
 * commit holding the block edits and every owner change bound to the port or
 * passed to `write`.
 */
export const makeHostGameplayBlockStateWorld = (
  { coordinator, chunkStores, dimensionIds }: HostGameplayBlockStateWorldOptions,
): GameplayBlockStateWorldApi => ({
  forDimension: (dimension, boundOwnerChanges, expectedWorldRevision) => ({
    read: (position) => chunkStores.forDimension(dimension).getBlockWithState(position).pipe(
      Effect.map((reading): BlockStateRead => reading._tag === 'Block'
        ? { _tag: 'Found', cell: { block: reading.block, state: reading.state ?? STATELESS } }
        : { _tag: 'Unavailable', reason: reading._tag }),
      // The store decodes codes it encoded itself, and persisted chunks are
      // decoded on load, so a resident code the codec rejects is a corrupt
      // store rather than a state the port can report.
      Effect.catchTag('BlockStateCodecFailure', dieUnexpected),
    ),
    write: (edits, ownerChanges) => Effect.gen(function* () {
      const batch = {
        world: coordinator.worldId,
        // Without an expectation from the caller the batch expects the
        // revision current at commit time; a given one is checked by the
        // coordinator inside the same commit.
        expectedWorldRevision: expectedWorldRevision ?? (yield* coordinator.revision),
        dimension: dimensionIds[dimension],
        expectedDimensionRevision: yield* coordinator.dimensionRevision(dimension),
        edits,
      }
      const changes = [...boundOwnerChanges ?? [], ...ownerChanges ?? []]
      return yield* commitWorldWrite(coordinator, batch, changes).pipe(
        Effect.as(WRITTEN),
        Effect.catchTags({
          // Another commit advanced the world or the dimension since the
          // expected revisions: a genuine outcome, and never `Written`.
          WorldWriteConflict: () => Effect.succeed(REFUSED),
          // The rule read every edited cell as resident and inside the world,
          // so this is a chunk that left residency before the commit.
          WorldWriteChunkUnavailable: () => Effect.succeed(REFUSED),
          // Rules build non-empty edits at distinct positions with states from
          // the block's own definition, so an invalid batch is a rule defect.
          WorldWriteInvalidBatch: dieUnexpected,
        }),
      )
    }),
  }),
})
