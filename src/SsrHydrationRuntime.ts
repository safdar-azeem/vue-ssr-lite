import type { InjectionKey } from 'vue'

/**
 * Generic, framework-neutral hydration contract.
 *
 * `vue-ssr-lite` renders a Vue application and serializes a single hydration
 * document. Application plugins (an API client, a store, an i18n cache, …) may
 * need to embed their own serializable state on the server and restore it in
 * the browser before the component tree is created. This contract is the ONLY
 * integration point they use — `vue-ssr-lite` never learns what that state is.
 *
 * A plugin obtains the active context by injecting {@link SSR_HYDRATION_CONTEXT}.
 * The key is created with `Symbol.for(...)` so a plugin can integrate WITHOUT
 * importing this package (it re-derives the identical symbol):
 *
 * ```ts
 * const host = app.runWithContext(() =>
 *   inject<SsrHydrationContext | null>(Symbol.for('vue-ssr:hydration-context'), null)
 * )
 * ```
 */
export interface SsrHydrationContext {
  /** True while server-rendering, false during browser hydration. */
  readonly server: boolean
  /**
   * Browser: the serializable state previously embedded under `key`
   * (or `undefined`). Server: always `undefined`.
   */
  read<T = unknown>(key: string): T | undefined
  /**
   * Server: register a contributor whose return value is serialized under
   * `key` after `renderToString` completes. Ignored in the browser.
   */
  contribute(key: string, dehydrate: () => unknown): void
  /**
   * Register cleanup executed after render (server) or on teardown /
   * hydration failure (browser).
   */
  onDispose(dispose: () => void): void
}

/**
 * Cross-package-stable injection key for {@link SsrHydrationContext}. Uses the
 * global symbol registry so integrations resolve the same identity whether or
 * not they import `vue-ssr-lite`.
 */
export const SSR_HYDRATION_CONTEXT = Symbol.for(
  'vue-ssr:hydration-context'
) as InjectionKey<SsrHydrationContext>

export interface SsrHydrationController extends SsrHydrationContext {
  /** Server: run every contributor and return the serializable state map. */
  collect(): Record<string, unknown> | undefined
  /** Run and clear every registered dispose callback. */
  dispose(): void
}

const reportDisposeError = (error: unknown) => {
  console.error('[vue-ssr-lite] hydration dispose failed', error)
}

/**
 * Creates the per-request hydration controller. `restored` carries the plugin
 * state map from a previous server render during browser hydration.
 */
export const createSsrHydrationController = (
  restored?: Record<string, unknown> | null,
  server: boolean = typeof window === 'undefined'
): SsrHydrationController => {
  const contributors = new Map<string, () => unknown>()
  const disposers: Array<() => void> = []
  const restoredState = restored ?? null

  return {
    server,
    read: <T = unknown>(key: string): T | undefined =>
      restoredState ? (restoredState[key] as T | undefined) : undefined,
    contribute: (key, dehydrate) => {
      if (server) contributors.set(key, dehydrate)
    },
    onDispose: (dispose) => {
      disposers.push(dispose)
    },
    collect: () => {
      if (contributors.size === 0) return undefined
      const state: Record<string, unknown> = {}
      for (const [key, dehydrate] of contributors) {
        state[key] = dehydrate()
      }
      return state
    },
    dispose: () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose?.()
        } catch (error) {
          reportDisposeError(error)
        }
      }
    },
  }
}
