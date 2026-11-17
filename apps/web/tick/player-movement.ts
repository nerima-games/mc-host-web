import { position, PositionAxis } from '@nerima-games/mc-kernel'
import { BlocksPerSecond } from '@nerima-games/mc-physics'
import { WorldId } from '@nerima-games/mx-multiplayer'
import { Effect, Exit, Option, Ref, Result } from 'effect'

import type { InputAction } from '@nerima-games/mc-render'
import type { Vitals } from '@nerima-games/mc-sim'
import type { H5aMovementContext, H5aMovementFrameInput, H5aMovementResult } from './h5a-context'

/**
 * Whether the vitals moved the way the survival-hunger tick reports work:
 * exhaustion added (exhaustion, saturation or hunger changes), regeneration or
 * starvation (health changes), or a completed food tick (the timer wraps).
 * Only the timer advancing is not a change worth saving.
 */
export const vitalsChangedByHunger = (before: Vitals, after: Vitals): boolean =>
  after.healthPoints !== before.healthPoints
  || after.hungerPoints !== before.hungerPoints
  || after.saturation !== before.saturation
  || after.exhaustion !== before.exhaustion
  || after.foodTimerSecs < before.foodTimerSecs

export const movementInput = (
  mounted: boolean,
  held: (action: InputAction) => number,
): Readonly<{ forward: number; strafe: number }> => ({
  forward: mounted ? 0 : held('moveForward') - held('moveBackward'),
  strafe: mounted ? 0 : held('moveRight') - held('moveLeft'),
})

export const runTickPlayerMovement = (
  context: H5aMovementContext,
  frame: H5aMovementFrameInput,
): Effect.Effect<
  H5aMovementResult | undefined,
  Effect.Error<H5aMovementContext['time']['timeOfDay'] | ReturnType<H5aMovementContext['drainChunkRenderFaults']>>
> => Effect.gen(function* () {
  const { deltaSecs, dead } = frame
  const poseBeforeFrame = Effect.runSync(context.playerApi.pose)
  const groundedBeforeFrame = Effect.runSync(Ref.get(context.simState.isGrounded))
  const dimensionBeforeFrame = Effect.runSync(context.playerApi.dimension)
  const mountedVehicleId = context.mountedVehicleId()
  const mountedVehicle = mountedVehicleId === undefined
    ? undefined
    : context.vehicleById(mountedVehicleId)
  const input = movementInput(mountedVehicle !== undefined, frame.held)
  const movementForward = input.forward
  const movementStrafe = input.strafe
  const feetReading = Effect.runSync(context.currentChunkStore.getBlock(context.blockPosition(
    Math.floor(poseBeforeFrame.feetPosition.x),
    Math.floor(poseBeforeFrame.feetPosition.y + 0.1),
    Math.floor(poseBeforeFrame.feetPosition.z),
  )))
  const eyesReading = Effect.runSync(context.currentChunkStore.getBlock(context.blockPosition(
    Math.floor(poseBeforeFrame.feetPosition.x),
    Math.floor(poseBeforeFrame.feetPosition.y + context.eyeLevelOffset),
    Math.floor(poseBeforeFrame.feetPosition.z),
  )))
  // Chunk-store block IDs belong to the registered block vocabulary.
  const canSwim = mountedVehicle === undefined && !dead
  const feetInWater = canSwim
    && feetReading._tag === 'Block'
    && Result.getOrThrow(context.blockTypeOfId(feetReading.block)) === 'water'
  const eyesInWater = canSwim
    && eyesReading._tag === 'Block'
    && Result.getOrThrow(context.blockTypeOfId(eyesReading.block)) === 'water'
  const sinYaw = Math.sin(poseBeforeFrame.yawRadians)
  const cosYaw = Math.cos(poseBeforeFrame.yawRadians)
  const wasSwimming = context.state.swimmingState.get().active
  const swimmingTick = context.advanceSwimming(context.state.swimmingState.get(), {
    feetInWater,
    eyesInWater,
    dead,
    horizontalInput: {
      x: -sinYaw * movementForward + cosYaw * movementStrafe,
      z: -cosYaw * movementForward - sinYaw * movementStrafe,
    },
    verticalInput: frame.held('jump') - frame.held('sneak'),
    deltaSecs,
  })
  context.state.swimmingState.set(swimmingTick.state)
  context.presentSwimmingState()
  Effect.runSync(Ref.set(context.simState.movementIntent, {
    forward: context.state.swimmingState.get().active ? 0 : movementForward,
    strafe: context.state.swimmingState.get().active ? 0 : movementStrafe,
  }))
  Effect.runSync(Ref.set(
    context.simState.jumpIntent,
    mountedVehicle === undefined && frame.held('jump') > 0,
  ))
  // Vanilla only sprints moving forward — not backward, not strafe-only —
  // which is the same gate mc-physics's own (unused-by-mc-sim)
  // applyMovementInput encodes for `input.sprint && forward > 0`.
  const sprinting = mountedVehicle === undefined && !context.state.swimmingState.get().active
    && movementForward > 0 && frame.held('sprint') > 0
  Effect.runSync(
    Ref.set(context.simState.physicsConfig, dead || mountedVehicle !== undefined || context.state.swimmingState.get().active
      ? Option.none()
      : Option.some({
          ...context.simPhysicsConfig,
          walkSpeed: (sprinting ? context.sprintSpeedMPerSec : context.simPhysicsConfig.walkSpeed)
            * Effect.runSync(context.getPlayerMovementSpeedMultiplier(context.gameplayState)),
        })),
  )
  const timeOfDay = yield* context.time.timeOfDay
  yield* Ref.set(context.gameplayState.timeOfDay, timeOfDay)
  const weatherBeforeFrame = Effect.runSync(context.weather.snapshot)
  Effect.runSync(Ref.set(context.gameplayState.weather, weatherBeforeFrame))
  Effect.runSync(Ref.set(context.gameplayState.weatherAdvanced, undefined))
  Effect.runSync(context.syncPortalCandidateSnapshots())

  const fishingSession = context.state.fishingSession.get()
  const fishingWater = context.state.fishingWater.get()
  if (context.multiplayer === undefined && fishingSession !== undefined && fishingWater !== undefined) {
    const storage = Effect.runSync(context.world.inventory.storageSnapshot)
    const held = storage.inventory.slots[context.state.selectedHotbarIndex.get()]
    if (held?.item !== 'fishing_rod') {
      context.cancelFishing(fishingSession)
      context.state.fishingSession.set(undefined)
      context.state.fishingWater.set(undefined)
      context.setFishingResult('cancelled')
    } else {
      const fishingContext = context.getOrCreateDimensionChunkContext(fishingWater.dimension)
      const water = Effect.runSync(fishingContext.chunkStore.getBlock(context.blockPosition(
        fishingWater.position.x,
        fishingWater.position.y,
        fishingWater.position.z,
      )))
      const advanced = context.advanceFishing(fishingSession, deltaSecs, {
        hasWater: water._tag === 'Block' && Result.getOrThrow(context.blockTypeOfId(water.block)) === 'water',
      })
      if (advanced._tag === 'Cancelled') {
        context.state.fishingSession.set(undefined)
        context.state.fishingWater.set(undefined)
        context.setFishingResult('lost-water')
      } else if (advanced._tag !== 'InvalidDuration') {
        context.state.fishingSession.set(advanced.session)
        context.setFishingResult(advanced._tag.toLowerCase())
      }
    }
  }

  const multiplayer = context.multiplayer
  if (
    multiplayer !== undefined &&
    !context.state.multiplayerHandshakeComplete.get() &&
    multiplayer.transport.state() === 'open' &&
    multiplayer.transport.isAuthenticated()
  ) {
    const pose = Effect.runSync(context.playerApi.pose)
    const worldId = WorldId.make(Effect.runSync(context.playerApi.dimension))
    Effect.runSync(multiplayer.host.transitionConnection({
      _tag: 'HandshakeSucceeded',
      player: multiplayer.query.player,
      world: worldId,
    }))
    Effect.runSync(multiplayer.host.enqueueOutbound({
      _tag: 'PlayerJoin',
      player: multiplayer.query.player,
      name: multiplayer.query.name,
      at: pose.feetPosition,
    }))
    context.state.multiplayerHandshakeComplete.set(true)
    context.pumpPlayerDamage()
    context.state.lastPlayerMoveSent.set({
      world: worldId,
      at: pose.feetPosition,
      facing: { yawRadians: pose.yawRadians, pitchRadians: pose.pitchRadians },
    })
    context.state.lastPlayerMoveSentAt.set(frame.nowSecs)
    context.canvas.setAttribute('data-multiplayer-connection', 'connected')
    context.canvas.setAttribute('data-multiplayer-player-count', String(multiplayer.players.size + 1))
    context.multiplayerStatus.textContent = `Connected as ${String(multiplayer.query.name)}`
    context.multiplayerStatus.hidden = false
  } else if (
    multiplayer !== undefined &&
    !context.state.multiplayerClosed.get() &&
    multiplayer.transport.state() === 'closed'
  ) {
    Effect.runSync(multiplayer.host.transitionConnection({ _tag: 'PeerClosed' }))
    context.state.multiplayerClosed.set(true)
    context.canvas.setAttribute('data-multiplayer-connection', 'closed')
    context.multiplayerStatus.textContent = 'Multiplayer connection closed.'
    context.multiplayerStatus.hidden = false
  }

  if (multiplayer === undefined) {
    for (const [key, furnace] of context.furnaceStates) {
      const nextItemUseRequestId = context.state.nextItemUseRequestId.get() + 1
      context.state.nextItemUseRequestId.set(nextItemUseRequestId)
      const requestId = `furnace-advance-${String(nextItemUseRequestId)}`
      context.pendingFurnaceAdvances.set(requestId, key)
      const deferredSecs = context.deferredFurnaceAdvanceSecs.get(key) ?? 0
      context.deferredFurnaceAdvanceSecs.delete(key)
      Effect.runSync(context.requestFurnaceAdvance(
        context.gameplayState,
        requestId,
        furnace.state,
        deltaSecs + deferredSecs,
      ))
    }
  }

  if (multiplayer !== undefined) yield* context.drainMultiplayerInbound()
  context.drainCraftingInbound()
  context.drainAnvilInbound()
  context.drainEnchantingInbound()
  context.drainPlayerDamageInbound()
  // WIRING, NOT A RULE. mx-gameplay owns vehicle motion and collision; this
  // loop supplies input intent before the frame and mirrors its authoritative state after.
  const pearlOutcomesBeforeFrame = yield* Ref.get(context.gameplayState.enderPearlOutcomes)
  const vitalsBeforeFrame = Effect.runSync(context.world.vitals.snapshot)
  const outcome = yield* Effect.exit(context.runFrame(deltaSecs))
  const vitalsAfterFrame = Effect.runSync(context.world.vitals.snapshot)
  const pearlOutcomesAfterFrame = yield* Ref.get(context.gameplayState.enderPearlOutcomes)
  // The stage appends an outcome only after committing the teleport.
  // Post-frame gameplay drains it later; old outcomes do not suppress movement.
  const pearlTeleported = pearlOutcomesAfterFrame.length > pearlOutcomesBeforeFrame.length
  if (context.state.swimmingState.get().active && mountedVehicle === undefined) {
    Effect.runSync(Ref.set(context.simState.velocity, {
      x: BlocksPerSecond(swimmingTick.state.velocity.x),
      y: BlocksPerSecond(swimmingTick.state.velocity.y),
      z: BlocksPerSecond(swimmingTick.state.velocity.z),
    }))
    if (!pearlTeleported) {
      Effect.runSync(context.playerApi.moveTo(position(
        PositionAxis(poseBeforeFrame.feetPosition.x + swimmingTick.state.velocity.x * deltaSecs),
        PositionAxis(poseBeforeFrame.feetPosition.y + swimmingTick.state.velocity.y * deltaSecs),
        PositionAxis(poseBeforeFrame.feetPosition.z + swimmingTick.state.velocity.z * deltaSecs),
      )))
    }
  } else if (wasSwimming) {
    Effect.runSync(Ref.set(context.simState.velocity, { x: BlocksPerSecond(0), y: BlocksPerSecond(0), z: BlocksPerSecond(0) }))
  }
  if (swimmingTick.drowningDamagePoints > 0) {
    context.applyPlayerDamage({ amount: swimmingTick.drowningDamagePoints, cause: 'generic' })
    context.markSessionDirty()
  }
  if (mountedVehicle !== undefined) {
    const moved = context.vehicleById(String(mountedVehicle.id))
    if (moved !== undefined && !pearlTeleported) Effect.runSync(context.playerApi.moveTo(moved.position))
  }

  if (Exit.isFailure(outcome)) {
    // A stage's error channel is `never`, so reaching here means a DEFECT.
    // Stopping the loop is deliberate: a defect that repeats sixty times a
    // second buries its own first occurrence in the console.
    context.failBoot('a frame stage defected', outcome.cause)
    return undefined
  }
  // render:chunk-sync cannot fail the frame, so mc-render queues meshing
  // faults on the attachment; they leave the tick here as a typed failure.
  yield* context.drainChunkRenderFaults()
  // Inside `runFrame` only stages change the vitals owner; today that is the
  // survival-hunger stage alone (I4). A death there has no other handler.
  if (multiplayer === undefined) {
    if (vitalsBeforeFrame.healthPoints > 0 && vitalsAfterFrame.healthPoints <= 0) context.handleLocalPlayerDeath()
    if (vitalsChangedByHunger(vitalsBeforeFrame, vitalsAfterFrame)) context.markSessionDirty()
  }

  const activeEntities = Effect.runSync(context.world.entities.entities)
  const droppedEntitiesById = new Map(
    activeEntities
      .filter((entity) => context.isDroppedItemBehaviour(entity.behaviour))
      .map((entity) => [String(entity.id), entity]),
  )
  if (multiplayer === undefined) {
    const expiredDroppedItemIds = context.droppedItemLifetime.advance(
      context.currentChunkContext().dimension,
      deltaSecs,
      [...droppedEntitiesById.keys()],
    )
    for (const entityId of expiredDroppedItemIds) {
      const entity = droppedEntitiesById.get(entityId)
      if (entity === undefined) continue
      Effect.runSync(context.world.entities.despawn(entity.id))
      context.droppedItemMetadata.delete(context.droppedItemMetadataKey(context.currentChunkContext().dimension, entityId))
    }
    if (expiredDroppedItemIds.length > 0) context.markSessionDirty()
  }

  return {
    poseBeforeFrame,
    groundedBeforeFrame,
    dimensionBeforeFrame,
    weatherBeforeFrame,
    sprinting,
  } satisfies H5aMovementResult
})
