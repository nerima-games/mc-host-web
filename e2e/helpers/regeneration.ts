export type NutritionSnapshot = {
  readonly hungerPoints: number
  readonly saturation: number
  readonly exhaustion: number
  readonly foodTimerSecs: number
}

// Only use while stationary with no jumping, attacking, mining, eating, or
// other exhaustion sources. Each nutrition point absorbs 4 exhaustion; each
// passive heal costs 6. Health is deliberately absent from this calculation.
export const regenerationHeals = (before: NutritionSnapshot, current: NutritionSnapshot): number => (
  4 * (before.saturation + before.hungerPoints - current.saturation - current.hungerPoints)
  + current.exhaustion - before.exhaustion
) / 6
