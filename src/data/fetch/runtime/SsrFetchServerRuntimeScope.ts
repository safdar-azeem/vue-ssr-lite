import { AsyncLocalStorage } from 'node:async_hooks'
import type { SsrFetchRuntime } from './SsrFetchRuntime'
import { SSR_FETCH_ASYNC_RUNTIME } from './SsrFetchRuntimeScope'

const values = globalThis as unknown as Record<PropertyKey, unknown>
const storage = (values[SSR_FETCH_ASYNC_RUNTIME] ??= new AsyncLocalStorage<
  SsrFetchRuntime
>()) as AsyncLocalStorage<SsrFetchRuntime>

/** Keep one immutable runtime association for this asynchronous application pass. */
export const runWithSsrFetchRuntime = <T>(
  runtime: SsrFetchRuntime,
  execute: () => T
): T => storage.run(runtime, execute)
