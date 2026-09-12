import { nextTick, type App, type InjectionKey } from 'vue'
import { createSsrVueHydrationAdapter } from './hydration/SsrVueHydrationAdapter'

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
   * (or `undefined`). Server: `undefined` on the first pass, or the prior
   * contribution when resuming the same request during reconciliation.
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
  collect(validate?: boolean): Record<string, unknown> | undefined
  /** @internal Server-only request-local state; never enters browser hydration JSON. */
  readReconciliation<T = unknown>(key: string): T | undefined
  /** @internal Register request-local state needed only by a recreated SSR pass. */
  contributeReconciliation(key: string, snapshot: () => unknown): void
  /** @internal Collect request-local state for the next SSR pass only. */
  collectReconciliation(): Record<string, unknown> | undefined
  /** Internal snapshot validation, skipped for intermediate reactivity checkpoints. */
  onValidate(validate: () => void): void
  /** Internal initial-browser-hydration transaction completion. */
  onHydrated(complete: () => void): void
  completeHydration(): void
  /** Release one restored internal contribution once its continuation is consumed. */
  forget(key: string): void
  /** Idempotently run and clear every registered dispose callback. */
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
  server: boolean = typeof window === 'undefined',
  restoredReconciliation?: Record<string, unknown> | null
): SsrHydrationController => {
  const contributors = server ? new Map<string, () => unknown>() : null
  const reconciliationContributors = server ? new Map<string, () => unknown>() : null
  const disposers: Array<() => void> = []
  const validators: Array<() => void> = []
  const hydrationCompletions: Array<() => void> = []
  // Own the map: forgetting an internal continuation must not mutate the caller's payload.
  const restoredState = restored ? { ...restored } : null
  const reconciliationState = server && restoredReconciliation
    ? { ...restoredReconciliation }
    : null
  let disposed = false
  let hydrated = false

  return {
    server,
    read: <T = unknown>(key: string): T | undefined =>
      restoredState ? (restoredState[key] as T | undefined) : undefined,
    contribute: (key, dehydrate) => {
      if (!disposed) contributors?.set(key, dehydrate)
    },
    readReconciliation: <T = unknown>(key: string): T | undefined =>
      reconciliationState ? (reconciliationState[key] as T | undefined) : undefined,
    contributeReconciliation: (key, snapshot) => {
      if (!disposed) reconciliationContributors?.set(key, snapshot)
    },
    collectReconciliation: () => {
      if (disposed || !reconciliationContributors?.size) return undefined
      const state: Record<string, unknown> = {}
      for (const [key, snapshot] of reconciliationContributors) state[key] = snapshot()
      return state
    },
    onValidate: (validate) => {
      if (server && !disposed) validators.push(validate)
    },
    onHydrated: (complete) => {
      if (disposed || server) return
      if (hydrated) complete()
      else hydrationCompletions.push(complete)
    },
    completeHydration: () => {
      if (disposed || hydrated || server) return
      hydrated = true
      const callbacks = hydrationCompletions.splice(0)
      for (const complete of callbacks) complete()
    },
    forget: (key) => {
      if (restoredState) delete restoredState[key]
    },
    onDispose: (dispose) => {
      if (!disposed) {
        disposers.push(dispose)
        return
      }
      try {
        dispose()
      } catch (error) {
        reportDisposeError(error)
      }
    },
    collect: (validate = true) => {
      if (disposed || !contributors?.size) return undefined
      if (validate) for (const check of validators) check()
      const state: Record<string, unknown> = {}
      for (const [key, dehydrate] of contributors) {
        state[key] = dehydrate()
      }
      return state
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      contributors?.clear()
      reconciliationContributors?.clear()
      if (reconciliationState) {
        for (const key of Object.keys(reconciliationState)) delete reconciliationState[key]
      }
      validators.length = 0
      hydrationCompletions.length = 0
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

/**
 * Vue's mount return is not completion of an async hydrated tree. Await setup
 * dependencies already belonging to that tree, then discover any descendants
 * they created. This adapter is intentionally generic; it knows nothing about
 * contributed state or network clients. No root wrapper or extra DOM is added.
 *
 * Vue-private discovery lives in the version-sensitive hydration adapter.
 * Unknown renderer structure rejects and disposes this transaction rather
 * than silently declaring an incomplete tree successfully hydrated.
 */
export const completeSsrBrowserHydration = async (
  app: App,
  hydration: SsrHydrationController
): Promise<void> => {
  const observed = new Set<Promise<unknown>>()
  let disposed = false
  let stopWaiting!: () => void
  const disposal = new Promise<void>((resolve) => { stopWaiting = resolve })
  hydration.onDispose(() => { disposed = true; stopWaiting() })
  try {
    if (disposed) return
    const readDependencies = createSsrVueHydrationAdapter(app)
    while (!disposed) {
      const pending = readDependencies().filter((work) => !observed.has(work))
      for (const work of pending) observed.add(work)
      if (!pending.length) {
        hydration.completeHydration()
        return
      }
      await Promise.race([Promise.all(pending), disposal])
      await nextTick()
    }
  } catch (error) {
    hydration.dispose()
    throw error
  } finally {
    observed.clear()
  }
}
