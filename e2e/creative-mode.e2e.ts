import { expect, test, type Page } from '@playwright/test'

import { callQa } from './helpers/qa'
import { waitForSimulationProgress } from './helpers/simulation-wait'

type GameplaySnapshot = {
  readonly mode: 'survival' | 'creative'
  readonly vitals: { readonly healthPoints: number; readonly hungerPoints: number }
  readonly inventory: {
    readonly slots: ReadonlyArray<{ readonly item: string; readonly count: number } | null>
  }
  readonly target: { readonly block: number | null }
  readonly ignitionTarget: { readonly block: number | null }
}

const snapshot = (page: Page): Promise<GameplaySnapshot> =>
  callQa(page, 'gameplay.snapshot')

const inventoryCount = (current: GameplaySnapshot, item: string): number =>
  current.inventory.slots.reduce(
    (total, slot) => total + (slot?.item === item ? slot.count : 0),
    0,
  )

type BreakProgress = { readonly requests: number; readonly block: number | null }
type PlacementProgress = { readonly requests: number; readonly placed: boolean; readonly stone: number }

const readBreakProgress = (
  page: Page,
): Promise<{ frames: number; value: BreakProgress }> =>
  page.evaluate(async () => {
    const transport = window.__NERIMA_GAMES_QA__
    if (transport === undefined) throw new Error('missing QA transport')
    const result = await transport.dispatch('gameplay', 'snapshot', null)
    if (result._tag === 'Failure') {
      throw new Error(`QA command failed: gameplay.snapshot: ${JSON.stringify(result.error)}`)
    }
    const snap = result.value as GameplaySnapshot
    const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
    return {
      frames: Number(document.body.getAttribute('data-frames')),
      value: {
        requests: Number(canvas?.getAttribute('data-breaks-requested')),
        block: snap.target.block,
      },
    }
  })

const readPlacementProgress = (
  page: Page,
): Promise<{ frames: number; value: PlacementProgress }> =>
  page.evaluate(async () => {
    const transport = window.__NERIMA_GAMES_QA__
    if (transport === undefined) throw new Error('missing QA transport')
    const result = await transport.dispatch('gameplay', 'snapshot', null)
    if (result._tag === 'Failure') {
      throw new Error(`QA command failed: gameplay.snapshot: ${JSON.stringify(result.error)}`)
    }
    const snap = result.value as GameplaySnapshot
    const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
    const stone = snap.inventory.slots.reduce(
      (total, slot) => total + (slot?.item === 'stone' ? slot.count : 0),
      0,
    )
    return {
      frames: Number(document.body.getAttribute('data-frames')),
      value: {
        requests: Number(canvas?.getAttribute('data-placements-requested')),
        placed: snap.ignitionTarget.block !== null
          && snap.ignitionTarget.block !== 0,
        stone,
      },
    }
  })

const grantPointerLock = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
    if (canvas === null) throw new Error('missing game canvas')
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => canvas,
    })
    document.dispatchEvent(new Event('pointerlockchange'))
  })
}

test('creates, plays, saves, and resumes a Creative world', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-menu-entry="single-player"]').click()
  await page.locator('[data-menu-action="new-world"]').click()
  await page.locator('[data-mx-ui="menu-world-name"]').fill('Creative E2E')
  await page.locator('[data-mx-ui="menu-game-mode"]').click()
  await expect(page.locator('[data-mx-ui="menu-game-mode"]')).toHaveAttribute(
    'aria-label',
    'Game mode: Creative',
  )
  await page.locator('[data-menu-action="confirm"]').click()

  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await expect(page).toHaveURL(/\?session=creative-e2e-[^&]+$/u)
  const sessionId = new URL(page.url()).searchParams.get('session')
  expect(sessionId).not.toBeNull()
  expect((await snapshot(page)).mode).toBe('creative')

  const breakSeed = await callQa<GameplaySnapshot>(page, 'gameplay.seedCreativeBreakEncounter')
  expect(breakSeed.target.block).not.toBeNull()
  await grantPointerLock(page)
  const canvas = page.locator('#game-canvas')
  const breaksBefore = Number(await canvas.getAttribute('data-breaks-requested'))
  await canvas.hover()
  await page.mouse.down({ button: 'left' })
  try {
    // Breaking accumulates mining progress over simulated frames, which fall
    // behind wall-clock time under host contention — see
    // waitForSimulationProgress.
    await waitForSimulationProgress(
      page,
      () => readBreakProgress(page),
      (progress) => progress.requests === breaksBefore + 1 && progress.block === 0,
      { description: 'creative-mode block break' },
    )
  } finally {
    await page.mouse.up({ button: 'left' })
  }

  const placementSeed = await callQa<GameplaySnapshot>(page, 'gameplay.seedCreativePlacementEncounter')
  const stoneBefore = inventoryCount(placementSeed, 'stone')
  const placementsBefore = Number(await canvas.getAttribute('data-placements-requested'))
  await canvas.hover()
  await page.mouse.down({ button: 'right' })
  try {
    await waitForSimulationProgress(
      page,
      () => readPlacementProgress(page),
      (progress) => (
        progress.requests === placementsBefore + 1
        && progress.placed
        && progress.stone === stoneBefore
      ),
      { description: 'creative-mode block placement' },
    )
  } finally {
    await page.mouse.up({ button: 'right' })
  }

  const beforeDamage = await snapshot(page)
  const afterDamage = await callQa<GameplaySnapshot>(page, 'gameplay.damage')
  expect(afterDamage.vitals).toEqual(beforeDamage.vitals)

  await page.keyboard.press('Escape')
  await page.getByTestId('save-quit-button').click()
  await page.locator('[data-menu-entry="single-player"]').click()
  const savedSession = page.locator(
    `[data-mx-ui="menu-world-row"][data-session-id="${sessionId}"]`,
  )
  await savedSession.click()
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  expect((await snapshot(page)).mode).toBe('creative')
})
