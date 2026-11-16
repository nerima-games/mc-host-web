import { Brand, Result } from 'effect'
import { EnchantmentLevel } from '@nerima-games/mc-kernel'
import type { Durability, ItemStack } from '@nerima-games/mc-sim'
import {
  decodeEnchantedItemSnapshot,
  snapshotEnchantedItem,
  type EnchantedItem,
  type EnchantmentId,
} from '@nerima-games/mx-gameplay'

type RawLevelEnchantedItem = Omit<EnchantedItem, 'enchantments'> & {
  readonly enchantments: ReadonlyArray<{ readonly id: EnchantmentId; readonly level: number }>
}

/**
 * `@nerima-games/mc-server/shared` still carries the raw enchantment levels of
 * mx-gameplay 0.12.0, so every level is branded before its item enters host state.
 */
export const enchantedItemWithLevels = (
  item: RawLevelEnchantedItem,
): Result.Result<EnchantedItem, Brand.BrandError> =>
  Result.map(
    Result.all(item.enchantments.map(({ id, level }) =>
      Result.map(EnchantmentLevel.result(level), (branded) => ({ id, level: branded })))),
    (enchantments) => ({ item: item.item, durability: item.durability, enchantments }),
  )

export const projectEnchantedItem = (
  stack: ItemStack | undefined,
  durability: Durability | null | undefined,
  saved: EnchantedItem | undefined,
): EnchantedItem | null => {
  if (stack === undefined) return null

  const projected = snapshotEnchantedItem({
    item: stack.item,
    durability: durability ?? null,
    enchantments: saved?.item === stack.item ? saved.enchantments : [],
  })
  return projected.ok ? projected.value : null
}

export const decodeProjectedEnchantedItem = (
  encoded: string,
  stack: ItemStack | undefined,
  durability: Durability | null | undefined,
): EnchantedItem | null => {
  const decoded = decodeEnchantedItemSnapshot(encoded)
  if (!decoded.ok || decoded.value.item !== stack?.item) return null
  return projectEnchantedItem(stack, durability, decoded.value)
}
