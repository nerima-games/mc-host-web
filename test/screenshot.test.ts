import { Result } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { makeScreenshotRuntime } from '../apps/web/screenshot'

const timestamp = new Date('2026-11-16T06:30:01.234Z')
const filename = 'screenshot-2026-11-16T06-30-01-234Z.png'

const makeCanvas = () => {
  const callbacks: BlobCallback[] = []
  const toBlob = vi.fn((callback: BlobCallback) => { callbacks.push(callback) })
  const complete = (blob: Blob | null) => {
    const callback = callbacks.shift()
    if (callback === undefined) throw new Error('No capture pending')
    callback(blob)
  }
  return { canvas: { toBlob }, toBlob, complete }
}

const success = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error('Expected success')
  return result.success
}

const failure = <A, E>(result: Result.Result<A, E>): E => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error('Expected failure')
  return result.failure
}

describe('screenshot runtime', () => {
  it('does not capture or save without a request', async () => {
    const { canvas, toBlob } = makeCanvas()
    const save = vi.fn()
    const runtime = makeScreenshotRuntime({ canvas, save })
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
    expect(toBlob).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('starts toBlob synchronously on the next render and saves exactly once', async () => {
    const { canvas, toBlob, complete } = makeCanvas()
    const save = vi.fn()
    const runtime = makeScreenshotRuntime({ canvas, save })
    const blob = new Blob(['pixels'], { type: 'image/png' })
    success(runtime.request(timestamp))
    expect(toBlob).not.toHaveBeenCalled()
    const capture = runtime.captureAfterRender()
    expect(toBlob).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 'image/png')
    expect(save).not.toHaveBeenCalled()
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
    complete(blob)
    expect(success(await capture)).toEqual({ filename, blob })
    expect(save).toHaveBeenCalledExactlyOnceWith(blob, filename)
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
    expect(toBlob).toHaveBeenCalledTimes(1)
  })

  it('coalesces requests before rendering using the latest timestamp', async () => {
    const { canvas, toBlob, complete } = makeCanvas()
    const runtime = makeScreenshotRuntime({ canvas, save: vi.fn() })
    const blob = new Blob(['latest pixels'])
    success(runtime.request(timestamp))
    success(runtime.request(new Date('2026-11-16T06:30:02.345Z')))
    const capture = runtime.captureAfterRender()
    complete(blob)
    expect(success(await capture)).toEqual({ filename: 'screenshot-2026-11-16T06-30-02-345Z.png', blob })
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
    expect(toBlob).toHaveBeenCalledTimes(1)
  })

  it('keeps a request made while the previous capture is encoding', async () => {
    const { canvas, toBlob, complete } = makeCanvas()
    const save = vi.fn()
    const runtime = makeScreenshotRuntime({ canvas, save })
    const firstBlob = new Blob(['first'])
    const secondBlob = new Blob(['second'])
    success(runtime.request(timestamp))
    const first = runtime.captureAfterRender()
    success(runtime.request(new Date('2026-11-16T06:30:02.345Z')))
    const second = runtime.captureAfterRender()
    expect(toBlob).toHaveBeenCalledTimes(2)
    complete(firstBlob)
    complete(secondBlob)
    expect(success(await first)?.blob).toBe(firstBlob)
    expect(success(await second)?.blob).toBe(secondBlob)
    expect(save.mock.calls.map(([blob]) => blob)).toEqual([firstBlob, secondBlob])
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
  })

  it('returns typed failure for null blobs without saving or retrying', async () => {
    const { canvas, toBlob, complete } = makeCanvas()
    const save = vi.fn()
    const runtime = makeScreenshotRuntime({ canvas, save })
    success(runtime.request(timestamp))
    const capture = runtime.captureAfterRender()
    complete(null)
    expect(failure(await capture)).toMatchObject({ _tag: 'ScreenshotCaptureFailure', reason: 'empty-blob' })
    expect(save).not.toHaveBeenCalled()
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
    expect(toBlob).toHaveBeenCalledTimes(1)
  })

  it('returns typed failure for a synchronous toBlob exception', async () => {
    const cause = new DOMException('Canvas is not origin-clean', 'SecurityError')
    const toBlob = vi.fn(() => { throw cause })
    const save = vi.fn()
    const runtime = makeScreenshotRuntime({ canvas: { toBlob }, save })
    success(runtime.request(timestamp))
    expect(failure(await runtime.captureAfterRender())).toMatchObject({ _tag: 'ScreenshotCaptureFailure', reason: 'to-blob-threw', cause })
    expect(save).not.toHaveBeenCalled()
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
    expect(toBlob).toHaveBeenCalledTimes(1)
  })

  it.each(['throw', 'reject'])('returns typed failure when saving does %s', async (mode) => {
    const { canvas, toBlob, complete } = makeCanvas()
    const cause = new Error('Download failed')
    const save = vi.fn(() => {
      if (mode === 'throw') throw cause
      return Promise.reject(cause)
    })
    const runtime = makeScreenshotRuntime({ canvas, save })
    success(runtime.request(timestamp))
    const capture = runtime.captureAfterRender()
    complete(new Blob(['pixels']))
    expect(failure(await capture)).toMatchObject({ _tag: 'ScreenshotSaveFailure', cause, filename })
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
    expect(toBlob).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('waits for successful saving before reporting success', async () => {
    const { canvas, complete } = makeCanvas()
    let finishSave: (() => void) | undefined
    const saving = new Promise<void>((resolve) => { finishSave = resolve })
    const save = vi.fn(() => saving)
    const runtime = makeScreenshotRuntime({ canvas, save })
    const blob = new Blob(['pixels'])
    let settled = false
    success(runtime.request(timestamp))
    const capture = runtime.captureAfterRender().then((result) => {
      settled = true
      return result
    })
    complete(blob)
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    if (finishSave === undefined) throw new Error('Save promise not created')
    finishSave()
    expect(success(await capture)?.blob).toBe(blob)
    expect(settled).toBe(true)
  })

  it('retains a request made during saving when the earlier save fails', async () => {
    const { canvas, toBlob, complete } = makeCanvas()
    const cause = new Error('First download failed')
    let rejectSave: ((reason: unknown) => void) | undefined
    const saving = new Promise<void>((_resolve, reject) => { rejectSave = reject })
    const save = vi.fn<(blob: Blob, name: string) => Promise<void>>()
      .mockImplementationOnce(() => saving)
      .mockResolvedValue(undefined)
    const runtime = makeScreenshotRuntime({ canvas, save })
    success(runtime.request(timestamp))
    const firstCapture = runtime.captureAfterRender()
    complete(new Blob(['first']))
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
    success(runtime.request(new Date('2026-11-16T06:30:02.345Z')))
    if (rejectSave === undefined) throw new Error('Save promise not created')
    rejectSave(cause)
    expect(failure(await firstCapture)).toMatchObject({ _tag: 'ScreenshotSaveFailure', cause })

    const nextCapture = runtime.captureAfterRender()
    const nextBlob = new Blob(['next'])
    complete(nextBlob)
    expect(success(await nextCapture)).toEqual({
      filename: 'screenshot-2026-11-16T06-30-02-345Z.png', blob: nextBlob,
    })
    expect(save).toHaveBeenCalledTimes(2)
    expect(toBlob).toHaveBeenCalledTimes(2)
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
  })

  it('rejects invalid timestamps without creating a capture request', async () => {
    const { canvas, toBlob } = makeCanvas()
    const save = vi.fn()
    const runtime = makeScreenshotRuntime({ canvas, save })
    expect(failure(runtime.request(new Date(Number.NaN)))).toMatchObject({ _tag: 'ScreenshotInvalidTimestamp', timestamp: Number.NaN })
    expect(success(await runtime.captureAfterRender())).toBeUndefined()
    expect(toBlob).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
})
