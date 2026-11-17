import { expect, test, type Page } from '@playwright/test'

import { callQa } from './helpers/qa'
import { startGameSession } from './helpers/session'

const setPointerLocked = (page: Page, locked: boolean): Promise<void> => page.evaluate((next) => {
  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
  if (canvas === null) throw new Error('missing game canvas')
  // SwiftShader cannot acquire native pointer lock in this suite. Simulate only
  // the platform state and event; the installed host listener owns pause and focus.
  Object.defineProperty(document, 'pointerLockElement', {
    configurable: true,
    get: () => next ? canvas : null,
  })
  document.dispatchEvent(new Event('pointerlockchange'))
}, locked)

test('first-run title controls stay dismissed after reload and reopen from Controls', async ({ page }) => {
  await page.goto('/')
  const title = page.getByTestId('title-screen')
  const controls = title.getByRole('button', { name: 'Controls', exact: true })
  const onboarding = title.getByRole('region', { name: 'Quick Controls onboarding' })

  await expect(onboarding).toBeVisible()
  await expect(onboarding.locator('[data-onboarding-control-action="moveForward"]')).toBeVisible()
  await expect(onboarding.locator('[data-onboarding-control-action="jump"]')).toBeVisible()
  await onboarding.getByRole('button', { name: 'Dismiss Quick Controls' }).click()
  await expect(onboarding).toBeHidden()

  await page.reload()
  await expect(controls).toBeVisible()
  await expect(onboarding).toBeHidden()
  await controls.click()
  await expect(onboarding).toBeVisible()
  await expect(onboarding.locator('[data-onboarding-control-action="jump"]')).toBeVisible()

  await page.reload()
  await expect(controls).toBeVisible()
  await expect(onboarding).toBeHidden()
})

test('a short title viewport scrolls to reachable Controls and dismissal buttons', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 320 })
  await page.goto('/')
  const title = page.getByTestId('title-screen')
  const controls = title.getByRole('button', { name: 'Controls', exact: true })
  const onboarding = title.getByRole('region', { name: 'Quick Controls onboarding' })

  await expect(onboarding).toBeVisible()
  const initialScrollTop = await title.evaluate((element) => element.scrollTop)
  // The center belongs to the menu's own scroller; wheel over the title padding.
  await page.mouse.move(20, 160)
  await page.mouse.wheel(0, 1200)
  await expect.poll(() => title.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScrollTop)
  await controls.click()
  await expect(controls).toBeInViewport()
  const dismiss = onboarding.getByRole('button', { name: 'Dismiss Quick Controls' })
  await dismiss.click()
  await expect(onboarding).toBeHidden()
})

test('losing pointer lock opens the product pause menu and focuses Resume', async ({ page }) => {
  await startGameSession(page, 'pause-lock-loss')
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  const pause = page.getByTestId('pause-overlay')
  const gameShell = page.getByTestId('game-shell')
  const resume = page.getByTestId('resume-button')

  await expect(pause).toBeHidden()
  await setPointerLocked(page, true)
  await expect(pause).toBeHidden()
  await setPointerLocked(page, false)
  await expect(pause).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-session-paused', 'true')
  await expect(gameShell).toHaveAttribute('inert', '')
  await expect(resume).toBeFocused()
})

test('Escape keeps the death screen active without opening pause', async ({ page }) => {
  await startGameSession(page, 'pause-death-priority')
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await callQa(page, 'gameplay.seedSmokeGroundingEncounter')
  for (let hit = 0; hit < 5; hit += 1) await callQa(page, 'gameplay.damage')
  const death = page.locator('#hud-root [data-mx-ui="death"]')
  const pause = page.getByTestId('pause-overlay')

  await expect(death).toBeVisible()
  await expect(death.getByRole('button', { name: 'Respawn' })).toBeVisible()
  for (let press = 0; press < 2; press += 1) {
    await page.keyboard.press('Escape')
    const framesAfterEscape = Number(await page.locator('body').getAttribute('data-frames'))
    await expect.poll(async () => Number(await page.locator('body').getAttribute('data-frames')))
      .toBeGreaterThan(framesAfterEscape)
    const snapshot = await callQa<{ readonly dead: boolean }>(page, 'gameplay.snapshot')
    expect(snapshot.dead).toBe(true)
    await expect(death).toBeVisible()
    await expect(pause).toBeHidden()
    await expect(page.locator('body')).not.toHaveAttribute('data-session-paused', 'true')
  }
})
