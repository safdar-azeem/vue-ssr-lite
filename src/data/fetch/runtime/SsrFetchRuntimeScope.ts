import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import type { SsrHydrationController } from '../../../SsrHydrationRuntime'
import type { SsrRequestContext } from '../../../SsrRuntimeTypes'
import type { SsrFetchRuntime } from './SsrFetchRuntime'

export const FETCH_HYDRATION_KEY = 'vue-ssr-lite:fetch'

export const SSR_FETCH_RUNTIME = Symbol.for('vue-ssr:fetch-runtime') as InjectionKey<SsrFetchRuntime>
export const SSR_FETCH_OWNER = Symbol.for('vue-ssr:fetch-owner') as InjectionKey<SsrFetchOwner>

/** Data only: importing application ownership must never import fetch execution. */
export interface SsrFetchOwner {
  server: boolean
  context: SsrRequestContext
  hydration: SsrHydrationController
  hydrating: boolean
  disposed: boolean
  runtime?: SsrFetchRuntime
}

type FetchBinding = SsrFetchRuntime | SsrFetchOwner

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
  runtimes: FetchBinding[]
}

const registry = (): Record<PropertyKey, unknown> =>
  globalThis as unknown as Record<PropertyKey, unknown>

const readAsyncRuntime = (): SsrFetchRuntime | null => {
  const storage = registry()[SSR_FETCH_ASYNC_RUNTIME] as
    | AsyncRuntimeStorage
    | undefined
  return storage?.getStore() ?? null
}

const readBrowserRuntime = (): FetchBinding | null => {
  if (typeof window === 'undefined') return null
  const slot = registry()[SSR_FETCH_BROWSER_RUNTIME] as
    | BrowserRuntimeSlot
    | undefined
  return slot?.runtimes[slot.runtimes.length - 1] ?? null
}

/** Bind the single document-owning browser application until its disposal. */
export const bindSsrFetchRuntime = (
  runtime: FetchBinding,
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

/** Injection wins over the legacy document fallback, including disposed owners. */
export const readSsrFetchBinding = (setupOnly = false): FetchBinding | null => {
  const injected = hasInjectionContext()
    ? inject(SSR_FETCH_RUNTIME, null) ?? inject(SSR_FETCH_OWNER, null)
    : null
  return injected ?? (setupOnly ? null : readAsyncRuntime() ?? readBrowserRuntime())
}

