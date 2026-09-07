import { hasInjectionContext, inject } from 'vue'
import {
  SSR_FETCH_RUNTIME,
  type SsrFetchRuntime,
} from './SsrFetchRuntime'

/** Shared across managed-server and Vite application module graphs. */
export const SSR_FETCH_ASYNC_RUNTIME = Symbol.for(
  'vue-ssr:fetch-async-runtime'
)

const SSR_FETCH_BROWSER_RUNTIME = Symbol.for(
  'vue-ssr:fetch-browser-runtime'
)

interface AsyncRuntimeStorage {
  getStore(): SsrFetchRuntime | undefined
}

interface BrowserRuntimeSlot {
  runtimes: SsrFetchRuntime[]
}

const registry = (): Record<PropertyKey, unknown> =>
  globalThis as unknown as Record<PropertyKey, unknown>

const readAsyncRuntime = (): SsrFetchRuntime | null => {
  const storage = registry()[SSR_FETCH_ASYNC_RUNTIME] as
    | AsyncRuntimeStorage
    | undefined
  return storage?.getStore() ?? null
}

const readBrowserRuntime = (): SsrFetchRuntime | null => {
  if (typeof window === 'undefined') return null
  const slot = registry()[SSR_FETCH_BROWSER_RUNTIME] as
    | BrowserRuntimeSlot
    | undefined
  return slot?.runtimes[slot.runtimes.length - 1] ?? null
}

/** Bind the single document-owning browser application until its disposal. */
export const bindSsrFetchRuntime = (
  runtime: SsrFetchRuntime,
  server: boolean
): (() => void) => {
  if (server) return () => undefined
  const values = registry()
  const slot = (values[SSR_FETCH_BROWSER_RUNTIME] ??= {
    runtimes: [],
  }) as BrowserRuntimeSlot
  slot.runtimes.push(runtime)
  return () => {
    const index = slot.runtimes.lastIndexOf(runtime)
    if (index >= 0) slot.runtimes.splice(index, 1)
  }
}

/** Resolve setup, request-scoped server, then mounted-browser ownership. */
export const resolveSsrFetchRuntime = (): SsrFetchRuntime | null => {
  const injected = hasInjectionContext()
    ? inject(SSR_FETCH_RUNTIME, null)
    : null
  return injected ?? readAsyncRuntime() ?? readBrowserRuntime()
}
