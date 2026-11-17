import type { Page } from '@playwright/test'

export const DATABASE_NAME = 'nerima-games-minecraft'
const RESET_DOCUMENT = '/__e2e__/database-reset'

export const clearDatabase = async (page: Page): Promise<void> => {
  // Keep the app origin without booting a title screen that opens IndexedDB.
  await page.route(`**${RESET_DOCUMENT}`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Database reset</title>',
  }), { times: 1 })
  await page.goto(RESET_DOCUMENT)
  await page.evaluate((databaseName) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.addEventListener('success', () => resolve(), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
    request.addEventListener('blocked', () => reject(new Error('database deletion blocked')), {
      once: true,
    })
  }), DATABASE_NAME)
}
