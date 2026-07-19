import { inject, type InjectionKey } from 'vue'

/**
 * Generic, framework-neutral server-render resolution contract.
 *
 * `renderToString` makes a single pass and awaits each component's native
 * `onServerPrefetch`. That covers data consumed reactively inside the component
 * that declared it, but it offers no way to:
 *
 *   1. await asynchronous work that was started OUTSIDE a component's own
 *      prefetch lifecycle (a store action, an i18n loader, a lazy query), or
 *   2. tell the renderer that application state settled AFTER the first pass and
 *      the tree should be produced again.
 *
 * This contract closes both gaps without `vue-ssr-lite` learning anything about
 * the plugin doing the work. An installed plugin — an API client, a store, an
 * i18n cache — obtains the active resolution by injecting
 * {@link SSR_REQUEST_RESOLUTION}. The key is created with `Symbol.for(...)` so a
 * plugin integrates WITHOUT importing this package (it re-derives the identical
 * symbol):
 *
 * ```ts
 * const resolution = app.runWithContext(() =>
 *   inject<SsrRequestResolution | null>(
 *     Symbol.for('vue-ssr:request-resolution'),
 *     null,
 *   )
 * )
 * resolution?.track(client.query(...))
 * ```
 *
 * The contract is API-client neutral: it never inspects the work it is handed.
 */
export interface SsrRequestResolution {
  /** True while server-rendering, false during browser hydration / SPA mount. */
  readonly server: boolean
  /** Zero-based index of the render pass currently in progress. */
  readonly pass: number
  /**
   * Register in-flight async work the renderer must await before it serializes
   * the response. Returns the same promise for convenient chaining. Ignored in
   * the browser, where there is no server render to gate. Rejections are
   * swallowed by the renderer's await — the component tree owns error surfacing.
   */
  track<T>(work: Promise<T>): Promise<T>
  /**
   * Request one additional render pass even when no tracked promise is pending.
   * Use when work mutated shared state synchronously in a way the current tree
   * did not observe. Honoured up to the configured pass bound.
   */
  requestAdditionalPass(): void
}

/**
 * Cross-package-stable injection key for {@link SsrRequestResolution}. Uses the
 * global symbol registry so integrations resolve the same identity whether or
 * not they import `vue-ssr-lite`.
 */
export const SSR_REQUEST_RESOLUTION = Symbol.for(
  'vue-ssr:request-resolution'
) as InjectionKey<SsrRequestResolution>

/**
 * Resolve the active {@link SsrRequestResolution} from component setup. Returns
 * `null` when no SSR host is installed (a plain SPA), so callers can no-op.
 *
 * The canonical use is the "parent query → child components → child queries via
 * an external store read by a sibling" pattern: a component that hydrates async
 * server data into a shared store (read by a sibling that Vue renders without
 * awaiting this component's prefetch) calls `requestAdditionalPass()` so the
 * renderer produces one more pass. On the next pass the data is warm in the
 * request cache and hydrates synchronously at setup, so the sibling sees it. All
 * of this is inert in the browser.
 */
export const useSsrResolution = (): SsrRequestResolution | null =>
  inject<SsrRequestResolution | null>(SSR_REQUEST_RESOLUTION, null)

export interface SsrResolutionController extends SsrRequestResolution {
  /** Begin a new render pass: clears the additional-pass request flag. */
  beginPass(pass: number): void
  /** Promises registered during the current request that are not yet settled. */
  pendingWork(): Promise<unknown>[]
  /** True when a plugin explicitly asked for another pass this render. */
  additionalPassRequested(): boolean
  /**
   * Await all currently-tracked work, bounded by `deadlineMs` and aborted by
   * `signal`. Returns `true` when everything settled within the deadline.
   */
  drain(deadlineMs: number, signal?: AbortSignal): Promise<boolean>
  /** Clear all state. Called once per request after the final pass. */
  dispose(): void
}

interface TrackedWork {
  readonly promise: Promise<unknown>
  settled: boolean
}

const isThenable = (value: unknown): value is Promise<unknown> =>
  Boolean(value) &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function'

/**
 * Creates the per-request resolution controller. Reused across every render
 * pass of a single request so tracked work and pass requests accumulate
 * coherently while the Vue application itself is recreated per pass.
 */
export const createSsrResolutionController = (
  server: boolean = typeof window === 'undefined'
): SsrResolutionController => {
  const tracked = new Set<TrackedWork>()
  let pass = 0
  let passRequested = false

  const controller: SsrResolutionController = {
    server,
    get pass() {
      return pass
    },
    track: <T>(work: Promise<T>): Promise<T> => {
      if (!server || !isThenable(work)) return work
      const entry: TrackedWork = { promise: work, settled: false }
      tracked.add(entry)
      // Mark settled without swallowing the original rejection for callers that
      // await the returned promise directly.
      work.then(
        () => {
          entry.settled = true
        },
        () => {
          entry.settled = true
        }
      )
      return work
    },
    requestAdditionalPass: () => {
      if (server) passRequested = true
    },
    beginPass: (nextPass: number) => {
      pass = nextPass
      passRequested = false
    },
    pendingWork: () =>
      [...tracked].filter((entry) => !entry.settled).map((entry) => entry.promise),
    additionalPassRequested: () => passRequested,
    drain: async (deadlineMs: number, signal?: AbortSignal): Promise<boolean> => {
      const settleAll = async (): Promise<boolean> => {
        // Work tracked while awaiting (a resolving promise starting the next
        // link of a waterfall) is included until nothing is left pending.
        while (true) {
          const pending = controller.pendingWork()
          if (pending.length === 0) return true
          await Promise.allSettled(pending)
        }
      }

      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        if (signal?.aborted) return controller.pendingWork().length === 0
        return settleAll()
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const guard = new Promise<false>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), deadlineMs)
        if (signal) {
          onAbort = () => resolvePromise(false)
          if (signal.aborted) resolvePromise(false)
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
      try {
        return await Promise.race([settleAll(), guard])
      } finally {
        if (timer) clearTimeout(timer)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
    },
    dispose: () => {
      tracked.clear()
      passRequested = false
      pass = 0
    },
  }
  return controller
}
