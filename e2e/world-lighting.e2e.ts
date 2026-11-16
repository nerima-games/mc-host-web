import { expect, test } from '@playwright/test'

import { callQa, callQaWithFrames } from './helpers/qa'
import { startGameSession } from './helpers/session'
import { waitForSimulationProgress } from './helpers/simulation-wait'

type LightingSnapshot = {
  readonly resolvedChunks: number
  readonly sampledQuads: number
  readonly darkestShade: number | null
  readonly brightestShade: number | null
  readonly weatherBrightness: number
}

test('generated world lighting reaches rendered chunk vertex colors', async ({ page }) => {
  await startGameSession(page, 'world-lighting')
  await expect(page.locator('body')).toHaveAttribute('data-mc-compose-boot', 'running')

  const snapshotLighting = (): Promise<LightingSnapshot> =>
    callQa(page, 'render.snapshotLighting')

  const snapshotLightingWithFrames = (): Promise<{ frames: number; value: LightingSnapshot }> =>
    callQaWithFrames(page, 'render.snapshotLighting')

  // `syncWorld` (mc-render's application/world-sync.ts) drains one dirty batch
  // per call and is driven off the RAF loop, so the spawn chunks it meshes are
  // only as fresh as the last-called frame. `framesDrawn` counts RAF ticks, not
  // drained batches, so waiting for frames > 1 does not guarantee a batch
  // containing the spawn chunks has been drained yet — poll the actual
  // condition (resolvedChunks) instead of a proxy for it, bounded by
  // simulated progress rather than wall-clock — see waitForSimulationProgress.
  await waitForSimulationProgress(
    page,
    snapshotLightingWithFrames,
    (current) => current.resolvedChunks > 0,
    { description: 'chunk lighting resolution' },
  )

  const snapshot = await snapshotLighting()

  expect(snapshot.resolvedChunks).toBeGreaterThan(0)
  expect(snapshot.sampledQuads).toBeGreaterThan(0)
  expect(snapshot.darkestShade).not.toBeNull()
  expect(snapshot.brightestShade).not.toBeNull()
  expect(snapshot.brightestShade).toBeGreaterThan(
    snapshot.darkestShade ?? Number.POSITIVE_INFINITY,
  )
  expect(snapshot.weatherBrightness).toBe(1)

  await page.screenshot({ path: 'test-results/world-lighting.png' })
})
