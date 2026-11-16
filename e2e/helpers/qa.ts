import type { Page } from '@playwright/test'

type QaResult =
  | { readonly _tag: 'Success'; readonly value: unknown }
  | { readonly _tag: 'Failure'; readonly error: unknown }

declare global {
  interface Window {
    __NERIMA_GAMES_QA__?: {
      readonly dispatch: (
        namespace: string,
        operation: string,
        input: null | number,
      ) => Promise<QaResult>
    }
  }
}

export const callQa = <A>(
  page: Page,
  command: string,
  input: null | number = null,
): Promise<A> => page.evaluate(async ({ commandName, commandInput }) => {
  const transport = window.__NERIMA_GAMES_QA__
  if (transport === undefined) throw new Error('missing QA transport')
  const separator = commandName.indexOf('.')
  const result = await transport.dispatch(
    commandName.slice(0, separator),
    commandName.slice(separator + 1),
    commandInput,
  )
  if (result._tag === 'Failure') {
    throw new Error(`QA command failed: ${commandName}: ${JSON.stringify(result.error)}`)
  }
  return result.value
}, { commandName: command, commandInput: input }) as Promise<A>

export const callQaWithFrames = <A>(
  page: Page,
  command: string,
  input: null | number = null,
): Promise<{ frames: number; value: A }> => page.evaluate(async ({ commandName, commandInput }) => {
  const transport = window.__NERIMA_GAMES_QA__
  if (transport === undefined) throw new Error('missing QA transport')
  const separator = commandName.indexOf('.')
  const result = await transport.dispatch(
    commandName.slice(0, separator),
    commandName.slice(separator + 1),
    commandInput,
  )
  if (result._tag === 'Failure') {
    throw new Error(`QA command failed: ${commandName}: ${JSON.stringify(result.error)}`)
  }
  return { frames: Number(document.body.getAttribute('data-frames')), value: result.value }
}, { commandName: command, commandInput: input }) as Promise<{ frames: number; value: A }>
