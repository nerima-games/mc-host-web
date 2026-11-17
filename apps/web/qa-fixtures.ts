import { Option } from 'effect'
import { BlockAxis, blockIdOf, blockPosition, type BlockId, type BlockPosition } from '@nerima-games/mc-kernel'

type Cell = BlockPosition
type Pose = { readonly feetPosition: { readonly x: number; readonly y: number; readonly z: number }; readonly yawRadians: number; readonly pitchRadians: number }

// The fixed fixture blocks must exist in the built-in kernel registry.
export const FARMLAND_BLOCK_ID: BlockId = Option.getOrThrow(blockIdOf('farmland'))
export const POTATO_CROP_BLOCK_ID: BlockId = Option.getOrThrow(blockIdOf('potato_crop'))
export const OBSIDIAN_BLOCK_ID: BlockId = Option.getOrThrow(blockIdOf('obsidian'))
export const NETHER_PORTAL_BLOCK_ID: BlockId = Option.getOrThrow(blockIdOf('nether_portal'))

export const KNOWN_TARGET_BLOCK: Cell = blockPosition(BlockAxis(8), BlockAxis(63), BlockAxis(8))
export const QA_FARM_CROP_BLOCK: Cell = blockPosition(BlockAxis(8), BlockAxis(64), BlockAxis(8))
export const QA_IGNITION_HIT_BLOCK: Cell = blockPosition(BlockAxis(8), BlockAxis(66), BlockAxis(8))
export const QA_IGNITION_CELL: Cell = blockPosition(BlockAxis(8), BlockAxis(66), BlockAxis(9))
export const QA_IGNITION_SUPPORT_BLOCK: Cell = blockPosition(BlockAxis(8), BlockAxis(65), BlockAxis(9))
export const QA_IGNITION_FLOOR_BLOCK: Cell = blockPosition(BlockAxis(8), BlockAxis(64), BlockAxis(10))
export const QA_PISTON: Cell = blockPosition(BlockAxis(8), BlockAxis(66), BlockAxis(8))
export const QA_PISTON_LEVER: Cell = blockPosition(BlockAxis(8), BlockAxis(66), BlockAxis(9))
export const QA_PISTON_NEAR: Cell = blockPosition(BlockAxis(8), BlockAxis(66), BlockAxis(7))
export const QA_PISTON_FAR: Cell = blockPosition(BlockAxis(8), BlockAxis(66), BlockAxis(6))
export const QA_REDSTONE_BUTTON: Cell = blockPosition(BlockAxis(8), BlockAxis(66), BlockAxis(9))
export const QA_REDSTONE_REPEATER: Cell = blockPosition(BlockAxis(8), BlockAxis(66), BlockAxis(8))
export const QA_REDSTONE_LAMP: Cell = blockPosition(BlockAxis(8), BlockAxis(66), BlockAxis(7))
export const QA_REDSTONE_BRANCH_BUTTON: Cell = blockPosition(BlockAxis(12), BlockAxis(66), BlockAxis(9))
export const QA_REDSTONE_BRANCH_WIRE: Cell = blockPosition(BlockAxis(12), BlockAxis(66), BlockAxis(8))
export const QA_REDSTONE_DOOR: Cell = blockPosition(BlockAxis(11), BlockAxis(66), BlockAxis(8))
export const QA_REDSTONE_RAIL: Cell = blockPosition(BlockAxis(13), BlockAxis(66), BlockAxis(8))
export const QA_REDSTONE_DISPENSER: Cell = blockPosition(BlockAxis(12), BlockAxis(67), BlockAxis(8))
export const QA_REDSTONE_HOPPER: Cell = blockPosition(BlockAxis(12), BlockAxis(65), BlockAxis(8))
export const QA_REDSTONE_OBSERVER: Cell = blockPosition(BlockAxis(16), BlockAxis(66), BlockAxis(8))
export const QA_REDSTONE_OBSERVER_INPUT: Cell = blockPosition(BlockAxis(16), BlockAxis(66), BlockAxis(9))
export const QA_REDSTONE_OBSERVER_LAMP: Cell = blockPosition(BlockAxis(16), BlockAxis(66), BlockAxis(7))
export const QA_REDSTONE_COMPARATOR: Cell = blockPosition(BlockAxis(20), BlockAxis(66), BlockAxis(8))
// Own lane at spawn's own z=10 row, walkable from QA_IGNITION_POSE by real
// movement input — every other redstone fixture sits at z=7-9, targeted by
// raycast rather than walked onto, so this lane avoids them entirely.
//
// The plate sits ON TOP of its own floor tile, one cell above the z=11/12
// wire and lamp's floor — the real arrangement, not the walkway-flush stand-in
// this used to be. main.ts's `simPhysicsConfig` now resolves each block's
// actual registry collisionShape (the real ~1/16-tall plate box mc-physics
// itself models), so a plate raised a block above the approach floor is
// walkable rather than a solid wall. The wire and lamp move up in lockstep so
// the circuit's relative shape — and its support, each on its own explicit
// floor tile rather than on assumed ambient terrain — is unchanged from what
// already passes.
export const QA_REDSTONE_PLATE_FLOOR: ReadonlyArray<Cell> = [
  blockPosition(BlockAxis(9), BlockAxis(64), BlockAxis(10)),
  blockPosition(BlockAxis(10), BlockAxis(64), BlockAxis(10)),
  blockPosition(BlockAxis(11), BlockAxis(64), BlockAxis(10)),
  blockPosition(BlockAxis(10), BlockAxis(64), BlockAxis(11)),
  blockPosition(BlockAxis(10), BlockAxis(64), BlockAxis(12)),
]
export const QA_REDSTONE_PLATE: Cell = blockPosition(BlockAxis(10), BlockAxis(65), BlockAxis(10))
export const QA_REDSTONE_PLATE_WIRE: Cell = blockPosition(BlockAxis(10), BlockAxis(65), BlockAxis(11))
export const QA_REDSTONE_PLATE_LAMP: Cell = blockPosition(BlockAxis(10), BlockAxis(65), BlockAxis(12))

export const QA_ENVIRONMENT_OVERLAP_POSE = {
  feetPosition: { x: 24.95, y: 65, z: 8.5 },
  yawRadians: 0,
  pitchRadians: 0,
} as const
export const QA_CACTUS_APPROACH_POSE = {
  feetPosition: { x: 24.2, y: 65, z: 8.5 },
  yawRadians: 0,
  pitchRadians: 0,
} as const
export const QA_ENVIRONMENT_CONTACT_CELLS: readonly [Cell, Cell] = [
  blockPosition(BlockAxis(24), BlockAxis(65), BlockAxis(8)),
  blockPosition(BlockAxis(25), BlockAxis(65), BlockAxis(8)),
]
export const QA_ENVIRONMENT_FLOOR_CELLS: ReadonlyArray<Cell> = Array.from({ length: 4 }, (_, offset) =>
  blockPosition(BlockAxis(23 + offset), BlockAxis(64), BlockAxis(8)),
)
export const QA_FALL_CENTER = { x: 28, z: 8 } as const
export const QA_FALL_FLOOR_Y = 64
export const QA_FALL_START_Y = {
  safe: 67.5,
  damaging: 72,
  lethal: 88,
} as const

export const QA_PORTAL_ANCHOR: Cell = blockPosition(BlockAxis(120), BlockAxis(65), BlockAxis(8))
export const QA_PORTAL_POSE = {
  feetPosition: { x: 120.5, y: 65, z: 8.5 },
  yawRadians: 0,
  pitchRadians: 0,
} as const
export const QA_PORTAL_LAYOUT: { readonly frame: ReadonlyArray<Cell>; readonly interior: ReadonlyArray<Cell> } = {
  frame: [
    ...Array.from({ length: 4 }, (_, offset) => blockPosition(BlockAxis(119 + offset), BlockAxis(64), BlockAxis(8))),
    ...Array.from({ length: 4 }, (_, offset) => blockPosition(BlockAxis(119 + offset), BlockAxis(68), BlockAxis(8))),
    ...Array.from({ length: 3 }, (_, offset) => blockPosition(BlockAxis(119), BlockAxis(65 + offset), BlockAxis(8))),
    ...Array.from({ length: 3 }, (_, offset) => blockPosition(BlockAxis(122), BlockAxis(65 + offset), BlockAxis(8))),
  ],
  interior: Array.from({ length: 6 }, (_, index) =>
    blockPosition(BlockAxis(120 + (index % 2)), BlockAxis(65 + Math.floor(index / 2)), BlockAxis(8)),
  ),
}
export const QA_IGNITION_PORTAL_LAYOUT: { readonly frame: ReadonlyArray<Cell>; readonly interior: ReadonlyArray<Cell> } = {
  frame: [
    ...Array.from({ length: 4 }, (_, offset) => blockPosition(BlockAxis(7 + offset), BlockAxis(65), BlockAxis(9))),
    ...Array.from({ length: 4 }, (_, offset) => blockPosition(BlockAxis(7 + offset), BlockAxis(69), BlockAxis(9))),
    ...Array.from({ length: 3 }, (_, offset) => blockPosition(BlockAxis(7), BlockAxis(66 + offset), BlockAxis(9))),
    ...Array.from({ length: 3 }, (_, offset) => blockPosition(BlockAxis(10), BlockAxis(66 + offset), BlockAxis(9))),
  ],
  interior: Array.from({ length: 6 }, (_, index) =>
    blockPosition(BlockAxis(8 + (index % 2)), BlockAxis(66 + Math.floor(index / 2)), BlockAxis(9)),
  ),
}

// Strictly positive and far below VILLAGER_RESTOCK_INTERVAL_SECS, so advancing
// a zero clock by it cannot trigger a restock that would reset offer uses.
export const QA_VILLAGER_RESTOCK_ELAPSED_SECS = 1

export const REDSTONE_PLACEMENT_ITEMS: ReadonlySet<string> = new Set([
  'redstone_dust',
  'redstone_torch',
  'lever',
  'stone_button',
  'repeater',
  'redstone_lamp',
  'observer',
  'comparator',
  'dispenser',
  'dropper',
  'hopper',
  'piston',
  'powered_rail',
  'door',
  'pressure_plate',
])

export const QA_POSE: Pose = {
  feetPosition: { x: 8.5, y: 64.5, z: 8.5 },
  yawRadians: 0,
  pitchRadians: -Math.PI / 2 + 0.01,
}
export const QA_FARM_POSE: Pose = {
  feetPosition: { x: 8.5, y: 65.5, z: 8.5 },
  yawRadians: 0,
  pitchRadians: -Math.PI / 2 + 0.01,
}
export const QA_IGNITION_POSE = {
  feetPosition: { x: 8.5, y: 65, z: 10.5 },
  yawRadians: 0,
  pitchRadians: 0,
} as const

// Away from every other fixture's z=6-12 band, so terraforming this loop's
// bounding box (main.ts's seedRailTrackEncounter) cannot clip a neighbour's
// blocks and streaming it in cannot evict them.
export const QA_RAIL_TRACK_ORIGIN: Cell = blockPosition(BlockAxis(4), BlockAxis(64), BlockAxis(24))
export const QA_RAIL_TRACK_WIDTH = 8
export const QA_RAIL_TRACK_HEIGHT = 6

/**
 * The perimeter of a QA_RAIL_TRACK_WIDTH x QA_RAIL_TRACK_HEIGHT rectangle of
 * track, anchored at QA_RAIL_TRACK_ORIGIN — the same closed-rectangle shape
 * mx-gameplay's own `rectangularPoweredTrack` test fixture walks (see that
 * package's test/vehicle-rail-simulation.test.ts), so a cart driven around
 * this loop exercises the identical four-corner case its regression guard
 * proves at the package level, but through the browser's real vehicle
 * service and frame stage rather than an in-memory rig.
 */
export const QA_RAIL_TRACK_CELLS: ReadonlyArray<Cell> = (() => {
  const cells: Array<Cell> = []
  for (let x = 0; x <= QA_RAIL_TRACK_WIDTH; x += 1) {
    cells.push(blockPosition(BlockAxis(QA_RAIL_TRACK_ORIGIN.x + x), BlockAxis(QA_RAIL_TRACK_ORIGIN.y), BlockAxis(QA_RAIL_TRACK_ORIGIN.z)))
    cells.push(blockPosition(
      BlockAxis(QA_RAIL_TRACK_ORIGIN.x + x),
      BlockAxis(QA_RAIL_TRACK_ORIGIN.y),
      BlockAxis(QA_RAIL_TRACK_ORIGIN.z + QA_RAIL_TRACK_HEIGHT),
    ))
  }
  for (let z = 1; z < QA_RAIL_TRACK_HEIGHT; z += 1) {
    cells.push(blockPosition(BlockAxis(QA_RAIL_TRACK_ORIGIN.x), BlockAxis(QA_RAIL_TRACK_ORIGIN.y), BlockAxis(QA_RAIL_TRACK_ORIGIN.z + z)))
    cells.push(blockPosition(
      BlockAxis(QA_RAIL_TRACK_ORIGIN.x + QA_RAIL_TRACK_WIDTH),
      BlockAxis(QA_RAIL_TRACK_ORIGIN.y),
      BlockAxis(QA_RAIL_TRACK_ORIGIN.z + z),
    ))
  }
  return cells
})()

export const QA_RAIL_POSE: Pose = {
  feetPosition: {
    x: QA_RAIL_TRACK_ORIGIN.x + QA_RAIL_TRACK_WIDTH / 2,
    y: QA_RAIL_TRACK_ORIGIN.y + 1,
    z: QA_RAIL_TRACK_ORIGIN.z + QA_RAIL_TRACK_HEIGHT / 2,
  },
  yawRadians: 0,
  pitchRadians: -Math.PI / 2 + 0.01,
}

// Away from every other fixture's footprint the same way QA_RAIL_TRACK_ORIGIN
// is: every other QA_* fixture sits within x:4-28, z:6-12 or the portal's
// x:119-122, z:8-9; the rail loop occupies x:4-12, z:24-30. z=40 clears the
// rail loop's own margin so terraforming this pool cannot clip either.
export const QA_WATER_ORIGIN: Cell = blockPosition(BlockAxis(4), BlockAxis(64), BlockAxis(40))
export const QA_WATER_SIZE = 8

/** Every cell of the pool's single-layer water surface, at QA_WATER_ORIGIN.y. */
export const QA_WATER_CELLS: ReadonlyArray<Cell> = (() => {
  const cells: Array<Cell> = []
  for (let x = 0; x <= QA_WATER_SIZE; x += 1) {
    for (let z = 0; z <= QA_WATER_SIZE; z += 1) {
      cells.push(blockPosition(BlockAxis(QA_WATER_ORIGIN.x + x), BlockAxis(QA_WATER_ORIGIN.y), BlockAxis(QA_WATER_ORIGIN.z + z)))
    }
  }
  return cells
})()

// Hovering above the pool's centre, aimed nearly straight down at the open
// water below (within DEFAULT_BLOCK_REACH) — the same aim a player uses to
// place a boat on open water in practice, and the one that hits the water
// block's TOP face rather than a side face. Used by the real right-click
// placement sub-test to exercise the SAME targetedBlock() raycast production
// placement uses, not a QA-only spawn.
export const QA_WATER_PLACEMENT_POSE: Pose = {
  feetPosition: {
    x: QA_WATER_ORIGIN.x + QA_WATER_SIZE / 2,
    y: QA_WATER_ORIGIN.y + 2,
    z: QA_WATER_ORIGIN.z + QA_WATER_SIZE / 2,
  },
  yawRadians: 0,
  pitchRadians: -Math.PI / 2 + 0.01,
}
