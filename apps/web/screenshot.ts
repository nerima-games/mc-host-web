import { Result } from 'effect'

export class ScreenshotInvalidTimestamp extends Error {
  readonly _tag: 'ScreenshotInvalidTimestamp' = 'ScreenshotInvalidTimestamp'
  readonly timestamp: number

  constructor({ timestamp }: { readonly timestamp: number }) {
    super('Screenshot timestamp is invalid')
    this.timestamp = timestamp
  }
}

export class ScreenshotCaptureFailure extends Error {
  readonly _tag: 'ScreenshotCaptureFailure' = 'ScreenshotCaptureFailure'
  readonly reason: 'empty-blob' | 'to-blob-threw'
  override readonly cause: unknown

  constructor({ reason, cause }: {
    readonly reason: 'empty-blob' | 'to-blob-threw'
    readonly cause: unknown
  }) {
    super('Screenshot capture failed')
    this.reason = reason
    this.cause = cause
  }
}

export class ScreenshotSaveFailure extends Error {
  readonly _tag: 'ScreenshotSaveFailure' = 'ScreenshotSaveFailure'
  readonly filename: string
  override readonly cause: unknown

  constructor({ filename, cause }: { readonly filename: string; readonly cause: unknown }) {
    super('Screenshot save failed')
    this.filename = filename
    this.cause = cause
  }
}

export interface ScreenshotSaved {
  readonly filename: string
  readonly blob: Blob
}

export interface ScreenshotOptions {
  readonly canvas: Pick<HTMLCanvasElement, 'toBlob'>
  readonly save: (blob: Blob, filename: string) => void | Promise<void>
}

export interface ScreenshotRuntime {
  readonly request: (timestamp: Date) => Result.Result<void, ScreenshotInvalidTimestamp>
  readonly captureAfterRender: () => Promise<
    Result.Result<ScreenshotSaved | undefined, ScreenshotCaptureFailure | ScreenshotSaveFailure>
  >
}

export const makeScreenshotRuntime = ({ canvas, save }: ScreenshotOptions): ScreenshotRuntime => {
  let pendingFilename: string | undefined

  return {
    request(timestamp: Date): Result.Result<void, ScreenshotInvalidTimestamp> {
      const milliseconds = timestamp.getTime()
      if (!Number.isFinite(milliseconds)) {
        return Result.fail(new ScreenshotInvalidTimestamp({ timestamp: milliseconds }))
      }

      pendingFilename = `screenshot-${timestamp.toISOString().replace(/[:.]/g, '-')}.png`
      return Result.succeed(undefined)
    },

    captureAfterRender(): Promise<
      Result.Result<ScreenshotSaved | undefined, ScreenshotCaptureFailure | ScreenshotSaveFailure>
    > {
      const filename = pendingFilename
      if (filename === undefined) return Promise.resolve(Result.succeed(undefined))

      // Consume before encoding so a request during encoding or saving belongs to the next draw.
      pendingFilename = undefined
      return new Promise((resolve) => {
        try {
          // Start in this call stack, before the browser can discard the WebGL drawing buffer.
          canvas.toBlob((blob) => {
            if (blob === null) {
              resolve(
                Result.fail(
                  new ScreenshotCaptureFailure({ reason: 'empty-blob', cause: undefined }),
                ),
              )
              return
            }

            Promise.resolve()
              .then(() => save(blob, filename))
              .then(
                () => resolve(Result.succeed({ filename, blob })),
                (cause: unknown) => resolve(Result.fail(new ScreenshotSaveFailure({ filename, cause }))),
              )
          }, 'image/png')
        } catch (cause) {
          resolve(Result.fail(new ScreenshotCaptureFailure({ reason: 'to-blob-threw', cause })))
        }
      })
    },
  }
}
