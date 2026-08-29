import {
  hasInjectionContext,
  getCurrentInstance,
  inject,
  watch,
  watchEffect,
  type WatchCallback,
  type WatchOptions,
  type WatchSource,
  type WatchStopHandle,
} from 'vue'
import {
  SSR_REQUEST_RESOLUTION,
  fingerprintSsrReactivityValues,
  registerSsrReactivitySource,
  requestSsrReactivityEffectPass,
  requestSsrReactivityPass,
  type SsrResolutionController,
  type SsrRequestResolution,
} from './SsrRequestResolution'

/**
 * On the server, a run that happens AFTER the synchronous creation of the
 * watcher reflects state that settled late — for example a store populated from
 * an awaited `onServerPrefetch`, after a sibling component already rendered.
 * Asking the resolution contract for another render pass lets consumers reflect
 * it; the resumed pass settles synchronously (the API client's request cache is
 * warm). Recreated transitions are coalesced only when they produce an already
 * consumed request-owned render-state consequence; ambiguous registration
 * structure remains conservative without asserting semantic source equality.
 * Inert in the browser and when no host is present.
 *
 * This is what makes the "parent query → child components → child queries
 * consumed indirectly through a shared store read by a sibling" pattern work on
 * the server with NO orchestration code in the application: components just use
 * `ssrWatch` to reconcile resolved data, as they already do.
 */
const resolveSsrResolution = (): SsrRequestResolution | null =>
  hasInjectionContext()
    ? inject<SsrRequestResolution | null>(SSR_REQUEST_RESOLUTION, null)
    : null

const runSsrReactivityCallback = <T>(
  resolution: SsrRequestResolution | null,
  callback: () => T
): T => {
  const controller = resolution as Partial<SsrResolutionController> | null
  controller?.beginReactivityCallback?.()
  try {
    return callback()
  } finally {
    controller?.endReactivityCallback?.()
  }
}

const resolveComponentTypeIdentity = (type: {
  name?: string
  __name?: string
  __file?: string
  __scopeId?: string
  setup?: unknown
  render?: unknown
}): string => {
  const label = type.__file || type.__scopeId || type.name || type.__name || 'anonymous'
  const implementation =
    typeof type === 'function'
      ? String(type)
      : typeof type.setup === 'function'
      ? String(type.setup)
      : typeof type.render === 'function'
        ? String(type.render)
        : ''
  return JSON.stringify([label, implementation])
}

const resolveReactivityIdentity = (): {
  identity: string
  deduplicable: boolean
} => {
  const segments: string[] = []
  let instance = getCurrentInstance()
  let deduplicable = true
  while (instance) {
    const type = instance.type as {
      name?: string
      __name?: string
      __file?: string
      __scopeId?: string
      setup?: unknown
      render?: unknown
    }
    const typeIdentity = resolveComponentTypeIdentity(type)
    const key = instance.vnode.key
    const props = fingerprintSsrReactivityValues([instance.vnode.props ?? {}])
    const root = instance.parent === null
    // An unkeyed non-root instance can exchange structural position with a
    // sibling on a later pass. Its invalidations remain conservatively eligible
    // rather than relying on traversal order or props to prove identity.
    if (!root && key == null) deduplicable = false
    if (props === null) deduplicable = false
    segments.push(
      `${typeIdentity}:${key == null ? '' : String(key)}:${props ?? 'uncertain'}`
    )
    instance = instance.parent
  }
  return {
    identity: segments.reverse().join('/') || 'anonymous',
    deduplicable,
  }
}


/**
 * SSR-safe reactivity.
 *
 * # Which Vue reactivity APIs are server-safe
 *
 * During server-side rendering Vue does NOT flush the scheduler, so any effect
 * queued to run later is created and then discarded. This is the single most
 * common cause of "the shell renders but the content is missing" bugs.
 *
 * | API                                   | Server behaviour                                   |
 * | ------------------------------------- | -------------------------------------------------- |
 * | `computed`                            | ✅ Safe. Lazily evaluated during render.           |
 * | `watch(src, cb, { flush: 'sync' })`   | ✅ Safe. Runs synchronously, stays active in render.|
 * | `watch(src, cb)` / `{ flush:'pre' }`  | ⚠️  Discarded. `immediate` runs once, then nothing.|
 * | `watch(src, cb, { flush: 'post' })`   | ⚠️  Discarded. Never runs on the server.           |
 * | `watchEffect(fn)`                      | ⚠️  Runs once at setup, then discarded.            |
 * | `onServerPrefetch(async fn)`          | ✅ Safe. Awaited before the component renders.      |
 * | `onMounted` / `onUpdated`             | ❌ Browser only. Never runs on the server.         |
 *
 * # The primitive
 *
 * {@link ssrWatch} and {@link ssrWatchEffect} force `flush: 'sync'`, so the
 * effect is active during the server render and reacts to state that settles
 * mid-render (for example a ref written by an awaited `onServerPrefetch`). They
 * behave identically on the server and in the browser, which is exactly what an
 * application needs to derive state from resolved data without reinventing a
 * broken watcher workaround.
 *
 * Prefer a `computed` when you only need to DERIVE a value for the template.
 * Reach for {@link ssrWatch} when resolved data must drive an imperative side
 * effect (populating an external store, setting a status code) that has to
 * happen during the server render.
 */

export type SsrWatchOptions<Immediate extends boolean = boolean> = Omit<
  WatchOptions<Immediate>,
  'flush'
>

/**
 * `watch`, pinned to `flush: 'sync'` so the callback is active during SSR.
 *
 * Identical semantics to Vue's `watch` otherwise: pass `{ immediate: true }` to
 * run once on setup, and use the returned handle to stop it. Because the flush
 * is synchronous, avoid mutating the watched source from inside the callback.
 *
 * When the callback runs on the server AFTER creation (a dependency settled
 * during the render, e.g. an awaited query result), it requests reconciliation
 * so consumers that read the mutated state elsewhere reflect it. Recreated
 * instances repeat-coalesce only when their ownership and transition values are
 * exact. Ambiguous sources are never equated, but a recreated callback whose
 * request-owned consequence was already consumed can close the prior
 * reconciliation obligation; distinct consequences remain eligible.
 * Applications write no orchestration for this — it is a property of the
 * primitive. A request-local external store must contribute its serializable
 * state through the SSR hydration controller (or explicitly request a pass) so
 * automatic reconciliation can distinguish replay from a new consequence.
 * Render visibility is observed automatically for plain objects, arrays, Maps,
 * and Sets reachable through request `state`/`response`. Observations are scoped
 * to the property, membership, structure, or collection result actually read;
 * a transient change to an unrelated request field is not a dependency. Dates,
 * RegExps, WeakMaps, WeakSets, class instances, and other opaque mutable
 * containers are outside that automatic observation contract; consumers of
 * those values (or opaque external stores) must explicitly request a pass when
 * their position can change relative to callbacks.
 *
 * The v1 automatic surface guarantees primitive property results, supported
 * container reference identity and nested traversal, `in`, own-key structure,
 * structural descriptor existence, kind, enumerability, configurability, and
 * writability, Map `get`/`has`, Set `has`, every entry consumed by `forEach`,
 * and each lazy iterator entry actually yielded by `next()`.
 * Direct consumption of a descriptor's `.value`, `.get`, or `.set` is
 * intentionally outside the automatic contract because structural operations
 * such as `Object.keys` request the same descriptor without consuming those
 * fields. Call `requestAdditionalPass()` for those advanced cases.
 */
export function ssrWatch<T, Immediate extends boolean = false>(
  source: WatchSource<T>,
  callback: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: SsrWatchOptions<Immediate>
): WatchStopHandle
export function ssrWatch<T extends readonly unknown[], Immediate extends boolean = false>(
  source: readonly [...T] | (() => T),
  callback: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: SsrWatchOptions<Immediate>
): WatchStopHandle
export function ssrWatch(
  source: any,
  callback: any,
  options?: SsrWatchOptions
): WatchStopHandle {
  const resolution = resolveSsrResolution()
  const { identity, deduplicable } = resolveReactivityIdentity()
  const reactivitySource =
    resolution?.server
      ? registerSsrReactivitySource(resolution, identity, deduplicable)
      : null
  let created = false
  const wrapped = (...args: any[]) => {
    const controller = resolution as Partial<SsrResolutionController> | null
    const beforeCheckpoint =
      created && resolution?.server
        ? controller?.reactivityCheckpoint?.()
        : undefined
    const result = runSsrReactivityCallback(resolution, () => callback(...args))
    if (created && resolution?.server) {
      requestSsrReactivityPass(
        resolution,
        reactivitySource,
        args.slice(0, 2),
        beforeCheckpoint
      )
    }
    return result
  }
  const stop = watch(source, wrapped, { ...options, flush: 'sync' })
  created = true
  return stop
}

/**
 * `watchEffect`, pinned to `flush: 'sync'` so the effect is active during SSR.
 * The effect runs immediately and re-runs synchronously whenever a tracked
 * dependency changes — including changes that happen while the server render is
 * still in progress. Post-creation server runs request automatic reconciliation;
 * request-owned render-state consequences distinguish a reconciliation replay
 * from a new mutation in both development and production, without relying on
 * Vue debugger hooks. External request-local state follows the same hydration
 * contribution requirement as {@link ssrWatch}.
 */
export const ssrWatchEffect = (
  effect: Parameters<typeof watchEffect>[0],
  options?: Omit<NonNullable<Parameters<typeof watchEffect>[1]>, 'flush'>
): WatchStopHandle => {
  const resolution = resolveSsrResolution()
  const { identity, deduplicable } = resolveReactivityIdentity()
  const reactivitySource =
    resolution?.server
      ? registerSsrReactivitySource(resolution, identity, deduplicable)
      : null
  let created = false
  const stop = watchEffect(
    ((onCleanup: any) => {
      const result = runSsrReactivityCallback(resolution, () =>
        (effect as any)(onCleanup)
      )
      if (created && resolution?.server) {
        requestSsrReactivityEffectPass(resolution, reactivitySource)
      }
      return result
    }) as Parameters<typeof watchEffect>[0],
    { ...options, flush: 'sync' }
  )
  created = true
  return stop
}
