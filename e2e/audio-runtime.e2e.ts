import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'

import { callQa } from './helpers/qa'
import { startGameSession } from './helpers/session'

type AudioReport = {
  readonly availability: string
  readonly contextState: string | null
  readonly unlockAttempts: number
  readonly activeTones: number
}

type AudioSnapshot = {
  readonly cueIds: ReadonlyArray<string>
  readonly captions: ReadonlyArray<{
    readonly cueId: string
    readonly reason: string
  }>
}

type PageFaults = {
  readonly consoleErrors: ReadonlyArray<string>
  readonly pageErrors: ReadonlyArray<string>
}

const watchForFaults = (page: Page): PageFaults => {
  const consoleErrors: Array<string> = []
  const pageErrors: Array<string> = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error: Error) => pageErrors.push(`${error.name}: ${error.message}`))
  return { consoleErrors, pageErrors }
}

test('unlocks Web Audio and schedules a player-hurt node from a game event', async ({ page }) => {
  const faults = watchForFaults(page)
  await startGameSession(page)

  await page.locator('canvas').click({ position: { x: 8, y: 8 } })
  await expect.poll(async () => callQa<AudioReport>(page, 'audio.report')).toMatchObject({
    availability: 'ready',
    contextState: 'running',
    unlockAttempts: 1,
  })

  const result = await page.evaluate(async () => {
    const transport = window.__NERIMA_GAMES_QA__
    if (transport === undefined) throw new Error('missing QA transport')
    const run = async (namespace: string, operation: string): Promise<unknown> => {
      const result = await transport.dispatch(namespace, operation, null)
      if (result._tag === 'Failure') {
        throw new Error(`QA command failed: ${namespace}.${operation}: ${JSON.stringify(result.error)}`)
      }
      return result.value
    }
    await run('gameplay', 'damage')
    return {
      report: await run('audio', 'report'),
      snapshot: await run('audio', 'snapshot'),
    }
  }) as { readonly report: AudioReport; readonly snapshot: AudioSnapshot }

  expect(result.report.activeTones).toBeGreaterThan(0)
  expect(result.snapshot.cueIds).toContain('playerHurt')
  expect(result.snapshot.captions).toContainEqual(expect.objectContaining({
    cueId: 'playerHurt',
    reason: 'audible',
  }))
  expect(faults).toEqual({ consoleErrors: [], pageErrors: [] })
})
