import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { EnchantmentLevel, type ItemType } from '@nerima-games/mc-kernel'
import { itemStack } from '@nerima-games/mc-sim'

import {
  decodeProjectedEnchantedItem,
  enchantedItemWithLevels,
  projectEnchantedItem,
} from '../apps/web/enchanted-item-state'

// Fixture literals are in-range stack counts.
const stackOf = (item: ItemType, count: number) => Result.getOrThrow(itemStack(item, count))

describe('enchanted item state', () => {
  it('uses authoritative durability for a damageable item', () => {
    expect(projectEnchantedItem(
      stackOf('diamond_pickaxe', 1),
      { current: 1400, max: 1561 },
      {
        item: 'diamond_pickaxe',
        durability: { current: 1500, max: 1561 },
        enchantments: [{ id: 'efficiency', level: EnchantmentLevel(3) }],
      },
    )).toEqual({
      item: 'diamond_pickaxe',
      durability: { current: 1400, max: 1561 },
      enchantments: [{ id: 'efficiency', level: 3 }],
    })
  })

  it('does not attach stale enchantments to a replacement item', () => {
    expect(projectEnchantedItem(
      stackOf('iron_sword', 1),
      { current: 250, max: 250 },
      {
        item: 'diamond_pickaxe',
        durability: { current: 1500, max: 1561 },
        enchantments: [{ id: 'efficiency', level: EnchantmentLevel(3) }],
      },
    )).toEqual({
      item: 'iron_sword',
      durability: { current: 250, max: 250 },
      enchantments: [],
    })
  })

  it('rejects malformed and mismatched persisted metadata', () => {
    const stack = stackOf('stone_pickaxe', 1)
    const durability = { current: 100, max: 131 }
    expect(decodeProjectedEnchantedItem('{', stack, durability)).toBeNull()
    expect(decodeProjectedEnchantedItem(JSON.stringify({
      item: 'diamond_pickaxe',
      durability: { current: 1500, max: 1561 },
      enchantments: [{ id: 'efficiency', level: 2 }],
    }), stack, durability)).toBeNull()
  })

  it('brands raw enchantment levels from mc-server shared rules', () => {
    expect(Result.getOrThrow(enchantedItemWithLevels({
      item: 'diamond_pickaxe',
      durability: { current: 1500, max: 1561 },
      enchantments: [{ id: 'efficiency', level: 5 }, { id: 'unbreaking', level: 3 }],
    }))).toEqual({
      item: 'diamond_pickaxe',
      durability: { current: 1500, max: 1561 },
      enchantments: [
        { id: 'efficiency', level: EnchantmentLevel(5) },
        { id: 'unbreaking', level: EnchantmentLevel(3) },
      ],
    })
  })

  it('rejects a raw enchantment level outside the kernel range', () => {
    for (const level of [256, -1, 1.5]) {
      expect(Result.isFailure(enchantedItemWithLevels({
        item: 'diamond_pickaxe',
        durability: null,
        enchantments: [{ id: 'efficiency', level: 2 }, { id: 'fortune', level }],
      }))).toBe(true)
    }
  })
})
