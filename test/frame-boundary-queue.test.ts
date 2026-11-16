import { position, PositionAxis, WorldId } from '@nerima-games/mc-kernel'
import {
  makeWorldCommitCoordinator,
  PlayerServiceSnapshotSchema,
  PlayerStorageSnapshotSchema,
  WorldRevisionConflict,
  type RemoveAtResult,
  type WorldCommitCoordinatorApi,
} from '@nerima-games/mc-sim'
import {
  GAMEPLAY_ENTITIES_OWNER_ID,
  GAMEPLAY_PLAYER_OWNER_ID,
  GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  GAMEPLAY_VITALS_OWNER_ID,
  gameplayOwnerRegistrations,
  makeInMemoryWorld,
  totalOf,
  type MobBehaviour,
} from '@nerima-games/mx-gameplay'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeFrameBoundaryQueue } from '../apps/web/frame-boundary-queue'
import { makeOwnerBackedWorld, type OwnerBackedWorld } from '../apps/web/owner-backed-services'

const ownerIds = {
  player: GAMEPLAY_PLAYER_OWNER_ID,
  playerStorage: GAMEPLAY_PLAYER_STORAGE_OWNER_ID,
  vitals: GAMEPLAY_VITALS_OWNER_ID,
  entities: GAMEPLAY_ENTITIES_OWNER_ID,
}

const at = (x: number, y: number, z: number) => position(PositionAxis(x), PositionAxis(y), PositionAxis(z))

type Harness = Readonly<{
  coordinator: WorldCommitCoordinatorApi
  view: OwnerBackedWorld
  /** The next view commit stops after the view read its revision, until `resume`. */
  pauseNextCommit: () => Readonly<{ reached: Effect.Effect<void>; resume: () => void }>
}>

const makeHarness = async (): Promise<Harness> => {
  const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
    world: WorldId('frame-boundary-queue-test'),
    owners: gameplayOwnerRegistrations(),
  }))
  const world = await Effect.runPromise(makeInMemoryWorld<MobBehaviour>())
  let pause: Effect.Effect<void> = Effect.void
  const view = await Effect.runPromise(makeOwnerBackedWorld({
    coordinator: {
      revision: coordinator.revision,
      snapshot: coordinator.snapshot,
      commit: (request) =>
        Effect.andThen(
          Effect.suspend(() => {
            const current = pause
            pause = Effect.void
            return current
          }),
          coordinator.commit(request),
        ),
    },
    world,
    ownerIds,
  }))
  const pauseNextCommit = () => {
    const reached = Effect.runSync(Deferred.make<void>())
    const resume = Effect.runSync(Deferred.make<void>())
    pause = Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(resume))
    return {
      reached: Deferred.await(reached),
      resume: () => {
        Effect.runSync(Deferred.succeed(resume, undefined))
      },
    }
  }
  return { coordinator, view, pauseNextCommit }
}

const ownerStone = (coordinator: WorldCommitCoordinatorApi) =>
  totalOf(
    Effect.runSync(coordinator.snapshot(GAMEPLAY_PLAYER_STORAGE_OWNER_ID, PlayerStorageSnapshotSchema)).state.inventory.slots,
    'stone',
  )

const ownerFeet = (coordinator: WorldCommitCoordinatorApi) =>
  Effect.runSync(coordinator.snapshot(GAMEPLAY_PLAYER_OWNER_ID, PlayerServiceSnapshotSchema)).state.pose.feetPosition

// A DOM handler in the shape of main.ts: write the inventory, then act on the
// write's result (here, record what the UI would show).
const dropTwoStone = (view: OwnerBackedWorld, slotIndex: number, shown: Array<RemoveAtResult>) =>
  Effect.map(view.inventory.removeAt(slotIndex, 'stone', 2), (removal) => {
    shown.push(removal)
  })

type DropTwoStoneError = Effect.Error<ReturnType<typeof dropTwoStone>>

const seedStone = (view: OwnerBackedWorld): number => {
  Effect.runSync(view.inventory.add('stone', 5))
  return Effect.runSync(view.inventory.snapshot).slots.findIndex((stack) => stack?.item === 'stone')
}

describe('frame-boundary queue with owner-backed views', () => {
  it('holds a mid-frame handler write until the frame boundary, without a commit failure', async () => {
    const { coordinator, view, pauseNextCommit } = await makeHarness()
    const slotIndex = seedStone(view)
    const queue = makeFrameBoundaryQueue<DropTwoStoneError>()
    const shown: Array<RemoveAtResult> = []
    const frame = (x: number) => Effect.andThen(queue.drain, view.player.moveTo(at(x, 64, 0)))

    const paused = pauseNextCommit()
    const first = Effect.runFork(frame(1))
    await Effect.runPromise(paused.reached)
    queue.enqueue(dropTwoStone(view, slotIndex, shown))
    expect(ownerStone(coordinator)).toBe(5)
    expect(shown).toEqual([])
    paused.resume()
    await Effect.runPromise(Fiber.join(first))
    expect(ownerFeet(coordinator)).toMatchObject({ x: 1 })
    // The frame that was running does not pick the write up; the next boundary does.
    expect(ownerStone(coordinator)).toBe(5)

    await Effect.runPromise(frame(2))
    expect(ownerStone(coordinator)).toBe(3)
    expect(shown).toEqual([{ _tag: 'Removed', removed: 2 }])
    expect(ownerFeet(coordinator)).toMatchObject({ x: 2 })
  })

  it('control: the same handler committing directly mid-frame fails the frame with WorldRevisionConflict', async () => {
    const { coordinator, view, pauseNextCommit } = await makeHarness()
    const slotIndex = seedStone(view)
    const shown: Array<RemoveAtResult> = []
    const revisionBefore = Effect.runSync(coordinator.revision)

    const paused = pauseNextCommit()
    const frame = Effect.runFork(view.player.moveTo(at(1, 64, 0)))
    await Effect.runPromise(paused.reached)
    Effect.runSync(dropTwoStone(view, slotIndex, shown))
    expect(ownerStone(coordinator)).toBe(3)
    paused.resume()
    const failure = await Effect.runPromise(Effect.flip(Fiber.join(frame)))
    expect(failure).toBeInstanceOf(WorldRevisionConflict)
    expect(failure).toMatchObject({ expected: revisionBefore, actual: revisionBefore + 1 })
    expect(ownerFeet(coordinator)).toMatchObject({ x: 0 })
  })
})

describe('frame-boundary queue', () => {
  type Failure = Readonly<{ _tag: 'Failure'; id: string }>

  it('runs queued writes in enqueue order and leaves nothing behind', () => {
    const queue = makeFrameBoundaryQueue<never>()
    const ran: Array<string> = []
    queue.enqueue(Effect.sync(() => ran.push('a')))
    queue.enqueue(Effect.sync(() => ran.push('b')))
    Effect.runSync(queue.drain)
    Effect.runSync(queue.drain)
    expect(ran).toEqual(['a', 'b'])
  })

  it('fails the drain with the typed error and keeps the unrun writes in order for the next drain', () => {
    const queue = makeFrameBoundaryQueue<Failure>()
    const ran: Array<string> = []
    queue.enqueue(Effect.sync(() => ran.push('a')))
    queue.enqueue(Effect.fail({ _tag: 'Failure', id: 'b' }))
    queue.enqueue(Effect.sync(() => ran.push('c')))
    expect(Effect.runSync(Effect.flip(queue.drain))).toEqual({ _tag: 'Failure', id: 'b' })
    expect(ran).toEqual(['a'])
    queue.enqueue(Effect.sync(() => ran.push('d')))
    Effect.runSync(queue.drain)
    expect(ran).toEqual(['a', 'c', 'd'])
  })

  it('defers a write enqueued by a queued write to the next drain', () => {
    const queue = makeFrameBoundaryQueue<never>()
    const ran: Array<string> = []
    queue.enqueue(Effect.sync(() => {
      ran.push('outer')
      queue.enqueue(Effect.sync(() => ran.push('inner')))
    }))
    Effect.runSync(queue.drain)
    expect(ran).toEqual(['outer'])
    Effect.runSync(queue.drain)
    expect(ran).toEqual(['outer', 'inner'])
  })
})
