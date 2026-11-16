/**
 * No prior e2e coverage of passive regen — damage is thoroughly covered
 * (fall-damage.e2e.ts, environmental-contact-damage.e2e.ts,
 * survival-combat.e2e.ts) but nothing exercises recovery over time.
 *
 * The mechanic, read from @nerima-games/mc-sim's
 * dist/domain/vitals-hunger.js: every FOOD_TICK_SECS (4s) of simulated time,
 * `advanceFoodTimer` heals 1 HP when `healthPoints < maxHealthPoints` and
 * `hungerPoints >= REGEN_HUNGER_THRESHOLD` (18, spawn is 20/20), and each
 * regen tick adds EXHAUSTION_PER_REGEN (6) exhaustion, which only converts to
 * lost hunger once accumulated exhaustion crosses EXHAUSTION_PER_POINT (4)
 * AND spawn saturation (5) is exhausted first — so a player who spawns,
 * takes damage, and stands still stays above the regen threshold for several
 * ticks before hunger itself starts falling.
 * `apps/web/main.ts` calls `survivalHunger.tick(deltaSecs)` every frame
 * (confirmed at the call site), so this is wired if it works at all.
 */
import { expect, test, type Page } from '@playwright/test'

import { callQa, callQaWithFrames } from './helpers/qa'
import { startGameSession } from './helpers/session'
import { waitForSimulationProgress } from './helpers/simulation-wait'

type GameplaySnapshot = {
  readonly vitals: {
    readonly healthPoints: number
    readonly maxHealthPoints: number
    readonly hungerPoints: number
  }
  readonly fall: {
    readonly grounded: boolean
  }
}

const snapshotWithFrames = (page: Page): Promise<{ frames: number; value: GameplaySnapshot }> =>
  callQaWithFrames(page, 'gameplay.snapshot')

test('a fed, standing player regenerates health over time after taking damage', async ({ page }) => {
  await startGameSession(page)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  const seeded = await callQa<GameplaySnapshot>(page, 'gameplay.seedSmokeGroundingEncounter')
  await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.fall.grounded,
    { description: 'player settles onto flat QA terrain' },
  )
  expect(seeded.vitals.healthPoints).toBe(seeded.vitals.maxHealthPoints)
  expect(seeded.vitals.hungerPoints).toBe(20)

  // gameplay.damage applies a fixed 4-point generic hit.
  const damaged = await callQa<GameplaySnapshot>(page, 'gameplay.damage')
  expect(damaged.vitals.healthPoints).toBe(seeded.vitals.healthPoints - 4)
  // Still well fed — no walking/jumping/attacking happened, so no
  // exhaustion has accumulated from activity, only from the regen itself.
  expect(damaged.vitals.hungerPoints).toBeGreaterThanOrEqual(18)

  // Backstopped generously: at 4 simulated seconds per regen tick, several
  // ticks fit comfortably inside the default outer budget even under load.
  const firstRegen = await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.vitals.healthPoints > damaged.vitals.healthPoints,
    { description: 'first passive regen tick heals 1 HP', backstopMs: 30_000 },
  )
  expect(firstRegen.vitals.healthPoints).toBe(damaged.vitals.healthPoints + 1)

  // A second tick confirms this is ongoing regeneration, not a one-off.
  const secondRegen = await waitForSimulationProgress(
    page,
    () => snapshotWithFrames(page),
    (current) => current.vitals.healthPoints > firstRegen.vitals.healthPoints,
    { description: 'second passive regen tick heals another HP', backstopMs: 30_000 },
  )
  expect(secondRegen.vitals.healthPoints).toBe(firstRegen.vitals.healthPoints + 1)
  expect(secondRegen.vitals.healthPoints).toBeLessThanOrEqual(secondRegen.vitals.maxHealthPoints)
})
