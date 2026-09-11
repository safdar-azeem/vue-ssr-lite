import { safeSsrLog } from '../SsrObservability'

/** Production start failures use the shared operator diagnostic path. */
export const reportSsrCliFatal = (command: string | undefined, error: unknown): void => {
  if (command === 'start') {
    safeSsrLog(undefined, 'error', 'ssr.start.failed', { requestId: 'startup', error })
    return
  }
  console.error('fatal error', error)
}
