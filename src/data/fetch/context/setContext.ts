import { resolveSsrFetchRuntime } from '../runtime/SsrFetchRuntimeScope'
import type { SetContextOptions } from '../types/SsrFetchTypes'

/** Replace header defaults for future same-origin useFetch executions. */
export const setContext = (context: SetContextOptions): void => {
  const runtime = resolveSsrFetchRuntime()
  if (!runtime) {
    throw new Error(
      'setContext() requires an active vue-ssr-lite application.'
    )
  }
  runtime.setContext(context)
}
