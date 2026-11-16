import { expect, test } from '@playwright/test'

import { startGameSession } from './helpers/session'

const installSettingsWriteFault = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.addInitScript(() => {
    const faultState = { remaining: 0 }
    const originalTransaction = IDBDatabase.prototype.transaction
    const transactionWithFault = function (
      this: IDBDatabase,
      ...arguments_: Parameters<IDBDatabase['transaction']>
    ): IDBTransaction {
      if (arguments_[1] === 'readwrite' && faultState.remaining > 0) {
        faultState.remaining -= 1
        throw new DOMException('Injected settings write failure', 'InvalidStateError')
      }
      return originalTransaction.apply(this, arguments_)
    }
    IDBDatabase.prototype.transaction = transactionWithFault
    ;(globalThis as unknown as { failNextSettingsWrite: () => void }).failNextSettingsWrite = () => {
      faultState.remaining += 1
    }
  })
}

const failNextSettingsWrite = (page: import('@playwright/test').Page): Promise<void> =>
  page.evaluate(() => {
    ;(globalThis as unknown as { failNextSettingsWrite: () => void }).failNextSettingsWrite()
  })

test('player settings persist and preserve Escape priority from title and pause', async ({ page }) => {
  await page.goto('/')
  const settingsRoot = page.getByTestId('settings-root')
  const titleSettings = page.locator('[data-menu-entry="settings"]')

  await titleSettings.click()
  await expect(settingsRoot).toBeVisible()
  await expect(page.locator('[data-settings-close]')).toBeFocused()

  const sensitivity = page.locator('[data-sensitivity]')
  await sensitivity.fill('175')
  await page.locator('[data-audio-enabled]').uncheck()
  await page.locator('[data-master]').fill('42')
  await page.locator('[data-sfx]').fill('23')
  await page.locator('[data-captions-enabled]').uncheck()

  const forwardBinding = page.locator('[data-binding-action="moveForward"]')
  const backwardBinding = page.locator('[data-binding-action="moveBackward"]')
  await forwardBinding.click()
  await page.keyboard.press('KeyS')
  await expect(forwardBinding).toHaveText('KeyS')
  await expect(forwardBinding).toBeFocused()
  await expect(backwardBinding).toHaveText('KeyW')
  await expect(page.locator('body')).toHaveAttribute('data-player-settings-persistence', 'saved')

  await forwardBinding.click()
  await page.keyboard.press('Escape')
  await expect(settingsRoot).toBeVisible()
  await expect(page.locator('[data-settings-status]')).toHaveText('Key capture cancelled.')
  await expect(forwardBinding).toBeFocused()

  await page.locator('[data-reset-bindings]').click()
  await expect(forwardBinding).toHaveText('KeyW')
  await expect(backwardBinding).toHaveText('KeyS')
  await expect(page.locator('[data-settings-status]')).toHaveText('Key bindings reset.')
  await forwardBinding.click()
  await page.keyboard.press('KeyS')
  await expect(forwardBinding).toHaveText('KeyS')
  await expect(backwardBinding).toHaveText('KeyW')
  await expect(page.locator('body')).toHaveAttribute('data-player-settings-persistence', 'saved')

  await page.keyboard.press('Escape')
  await expect(settingsRoot).toBeHidden()
  await expect(titleSettings).toBeFocused()

  await startGameSession(page, 'player-settings')
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await page.keyboard.press('Escape')
  await page.getByTestId('options-button').click()
  await expect(settingsRoot).toBeVisible()
  await expect(page.locator('[data-settings-close]')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sensitivity).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('[data-settings-close]')).toBeFocused()
  await expect(sensitivity).toHaveValue('175')
  await expect(page.locator('[data-audio-enabled]')).not.toBeChecked()
  await expect(page.locator('[data-master]')).toHaveValue('42')
  await expect(page.locator('[data-sfx]')).toHaveValue('23')
  await expect(page.locator('[data-captions-enabled]')).not.toBeChecked()
  await expect(forwardBinding).toHaveText('KeyS')

  await page.keyboard.press('Escape')
  await expect(settingsRoot).toBeHidden()
  await expect(page.getByTestId('options-button')).toBeFocused()
  await expect(page.getByTestId('pause-overlay')).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-session-paused', 'true')
})

test('settings dialog stays within a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/')
  await page.locator('[data-menu-entry="settings"]').click()

  const layout = await page.getByTestId('settings-root').evaluate((root) => {
    const dialog = root.querySelector<HTMLElement>('.settings-dialog')
    if (dialog === null) throw new Error('settings dialog missing')
    const bounds = dialog.getBoundingClientRect()
    return {
      dialogLeft: bounds.left,
      dialogRight: bounds.right,
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
    }
  })

  expect(layout.dialogLeft).toBeGreaterThanOrEqual(0)
  expect(layout.dialogRight).toBeLessThanOrEqual(layout.rootClientWidth)
  expect(layout.rootScrollWidth).toBe(layout.rootClientWidth)
})

test('rapid setting changes finish saving before title navigation', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-menu-entry="settings"]').click()

  await page.getByTestId('settings-root').evaluate((root) => {
    const sensitivity = root.querySelector<HTMLInputElement>('[data-sensitivity]')
    const close = root.querySelector<HTMLButtonElement>('[data-settings-close]')
    if (sensitivity === null || close === null) throw new Error('settings controls missing')

    for (let value = 50; value <= 245; value += 5) {
      sensitivity.value = String(value)
      sensitivity.dispatchEvent(new Event('input', { bubbles: true }))
    }
    close.click()

    const newWorld = document.querySelector<HTMLButtonElement>('[data-menu-entry="new-world"]')
    if (newWorld === null) throw new Error('new world control missing')
    newWorld.click()

    const name = document.querySelector<HTMLInputElement>('[data-mx-ui="menu-world-name"]')
    const confirm = document.querySelector<HTMLButtonElement>('[data-menu-action="confirm"]')
    if (name === null || confirm === null) throw new Error('new world form missing')
    name.value = 'Rapid Settings'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    confirm.click()
  })

  await expect(page).toHaveURL(/\?session=rapid-settings-[^&]+&create=1/u)
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')
  await page.keyboard.press('Escape')
  await page.getByTestId('options-button').click()
  await expect(page.locator('[data-sensitivity]')).toHaveValue('245')
})

test('settings write failures block navigation until a later save succeeds', async ({ page }) => {
  await installSettingsWriteFault(page)
  await startGameSession(page, 'settings-write-failure')
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  await page.keyboard.press('Escape')
  await page.getByTestId('options-button').click()
  await failNextSettingsWrite(page)
  await page.locator('[data-audio-enabled]').uncheck()
  await expect(page.locator('[data-settings-error]')).toHaveText('Settings could not be saved.')
  await expect(page.locator('[data-settings-error]')).toHaveAttribute('role', 'alert')
  await page.locator('[data-settings-close]').click()

  await page.getByTestId('save-quit-button').click()
  await expect(page).toHaveURL(/\?session=settings-write-failure$/u)
  await expect(page.locator('[data-pause-error]')).toHaveText(
    'Save failed. Your world is still open; please try again.',
  )
  await expect(page.locator('[data-pause-error]')).toHaveAttribute('role', 'alert')

  await page.getByTestId('options-button').click()
  await expect(page.locator('[data-audio-enabled]')).toBeChecked()
  await page.locator('[data-audio-enabled]').uncheck()
  await expect(page.locator('body')).toHaveAttribute('data-player-settings-persistence', 'saved')
  await page.locator('[data-settings-close]').click()
  await page.getByTestId('save-quit-button').click()
  await expect(page).toHaveURL('/')

  await page.locator('[data-menu-entry="settings"]').click()
  await page.locator('[data-audio-enabled]').check()
  await expect(page.locator('body')).toHaveAttribute('data-player-settings-persistence', 'saved')
  await failNextSettingsWrite(page)
  await page.locator('[data-audio-enabled]').uncheck()
  await expect(page.locator('[data-settings-error]')).toHaveText('Settings could not be saved.')
  await page.locator('[data-settings-close]').click()
  await page.locator('[data-menu-entry="load-world"]').click()
  await page.locator('[data-mx-ui="menu-world-row"][data-session-id="settings-write-failure"]').click()
  await expect(page).toHaveURL('/')
  await expect(page.locator('#title-status')).toHaveText(
    'Could not finish saving settings. Please try again.',
  )

  await page.locator('[data-menu-action="back"]').click()
  await page.locator('[data-menu-entry="settings"]').click()
  await expect(page.locator('[data-audio-enabled]')).toBeChecked()
  await page.locator('[data-audio-enabled]').uncheck()
  await expect(page.locator('body')).toHaveAttribute('data-player-settings-persistence', 'saved')
  await page.locator('[data-settings-close]').click()
  await page.locator('[data-menu-entry="load-world"]').click()
  await page.locator('[data-mx-ui="menu-world-row"][data-session-id="settings-write-failure"]').click()
  await expect(page).toHaveURL('/?session=settings-write-failure')
})

test('corrupt saved settings warn until a valid change replaces the record', async ({ page }) => {
  await page.goto('/')
  const settings = page.locator('[data-menu-entry="settings"]')
  const error = page.locator('[data-settings-error]')
  const sensitivity = page.locator('[data-sensitivity]')
  await settings.click()
  await sensitivity.fill('175')
  await expect(page.locator('body')).toHaveAttribute('data-player-settings-persistence', 'saved')

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nerima-games-minecraft')
      request.addEventListener('success', () => resolve(request.result), { once: true })
      request.addEventListener('error', () => reject(request.error), { once: true })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('saves', 'readwrite')
        const store = transaction.objectStore('saves')
        const request: IDBRequest<unknown> = store.get('mc-compose/player-settings')
        request.addEventListener('success', () => {
          const record = request.result
          if (typeof record !== 'object' || record === null) {
            transaction.abort()
            reject(new Error('saved settings record missing before corruption'))
            return
          }
          store.put({ ...record, envelope: null })
        }, { once: true })
        transaction.addEventListener('complete', () => resolve(), { once: true })
        transaction.addEventListener('error', () => reject(transaction.error), { once: true })
        transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
      })
    } finally {
      database.close()
    }
  })

  await page.reload()
  await settings.click()
  await expect(error).toBeVisible()
  await expect(error).toHaveAttribute('role', 'alert')
  await expect(error).toHaveText('Saved settings could not be read. Changing a setting will replace them.')
  await page.locator('[data-settings-close]').click()
  await settings.click()
  await expect(error).toHaveText('Saved settings could not be read. Changing a setting will replace them.')

  await sensitivity.fill('176')
  await expect(page.locator('body')).toHaveAttribute('data-player-settings-persistence', 'saved')
  await expect(error).toBeEmpty()
  await page.reload()
  await settings.click()
  await expect(sensitivity).toHaveValue('176')
  await expect(error).toBeEmpty()
})
