import { inject, type InjectionKey, type WatchOptions, type WatchStopHandle, type watchEffect } from 'vue'

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
 * Request-local external stores that participate in automatic watcher/effect
 * reconciliation should contribute their serializable state through the
 * hydration controller. That contribution becomes part of the request-owned
 * render checkpoint used to distinguish replay from a new consequence.
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
   * Tracking alone does not invalidate rendered HTML; call
   * {@link requestAdditionalPass} when settlement changes render-visible state.
   */
  track<T>(work: Promise<T>): Promise<T>
  /**
   * Request one additional render pass even when no tracked promise is pending.
   * Use when work mutated shared state synchronously in a way the current tree
   * did not observe. Honoured up to the configured pass bound. The {@link
   * ssrWatch} primitive calls this automatically, so applications rarely call it
   * directly.
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

/** Internal request-owned dispatch; never installs a process-global implementation. */
export const SSR_SERVER_REACTIVITY = Symbol.for('vue-ssr:server-reactivity')

export interface SsrServerReactivity {
  watch(resolution: SsrRequestResolution, source: any, callback: any, options?: Omit<WatchOptions, 'flush'>): WatchStopHandle
  watchEffect(
    resolution: SsrRequestResolution,
    effect: Parameters<typeof watchEffect>[0],
    options?: Omit<NonNullable<Parameters<typeof watchEffect>[1]>, 'flush'>
  ): WatchStopHandle
}

export interface SsrResolutionController extends SsrRequestResolution {
  /** Present only on the server controller; public watchers depend on this contract alone. */
  readonly [SSR_SERVER_REACTIVITY]?: SsrServerReactivity
  /** Begin a new render pass: clears the additional-pass request flag. */
  beginPass(pass: number): void
  /** Register a watcher source; ambiguous slot layouts are never deduplicated. */
  registerReactivitySource(
    identity?: string,
    deduplicable?: boolean
  ): SsrReactivitySource
  /** Request reconciliation for one watcher transition and its callback baseline. */
  requestReactivityPass(
    source: SsrReactivitySource,
    transition: string | null,
    beforeCheckpoint?: string | null
  ): void
  /** Snapshot the current request-owned render state at a callback boundary. */
  reactivityCheckpoint(): string | null
  /** Install the current application's render-state checkpoint reader. */
  setReactivityCheckpointReader(reader: (() => string) | null): void
  /** Record one request dependency result and how to read it at pass completion. */
  registerReactivityObservation(
    observed?: string | null,
    readTerminal?: () => string | null
  ): void
  /** Stop accepting render observations after Vue finishes the current HTML. */
  completeReactivityObservation(): void
  /** Suppress callback-internal reads from render-observation accounting. */
  beginReactivityCallback(): void
  endReactivityCallback(): void
  /** Request reconciliation for one effect invalidation consequence. */
  requestReactivityEffectPass(source: SsrReactivitySource): void
  /** Finalize structural reactivity bookkeeping for the completed pass. */
  completeReactivityPass(): void
  /** Promises registered during the current request that are not yet settled. */
  pendingWork(): Promise<unknown>[]
  /** True when a plugin explicitly asked for another pass this render. */
  additionalPassRequested(): boolean
  /**
   * Await all currently-tracked work, bounded by `deadlineMs` and aborted by
   * `signal`. Returns `true` when everything settled within the deadline.
   */
  drain(deadlineMs: number, signal?: AbortSignal): Promise<boolean>
  /** Clear all state and stop accepting work. Called after the final pass. */
  dispose(): void
}

export interface SsrReactivitySource {
  readonly identity: string
  readonly slot: number
  readonly deduplicable: boolean
}
